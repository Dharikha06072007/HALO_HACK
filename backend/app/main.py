from __future__ import annotations

import io
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
import jwt
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field

from .ai_provider import generate_json
from .database import DuplicateKeyError, store, utc_now

try:
    import fitz
except ImportError:  # pragma: no cover
    fitz = None
try:
    from docx import Document
except ImportError:  # pragma: no cover
    Document = None

app = FastAPI(title="SkillSync AI API", version="0.2.0")
app.add_middleware(CORSMiddleware, allow_origins=[os.getenv("FRONTEND_URL", "http://localhost:5173"), "http://127.0.0.1:5173"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
security = HTTPBearer(auto_error=False)
SESSIONS: dict[str, dict[str, Any]] = {}
SCORING_WEIGHTS = {"skills": 0.50, "experience": 0.20, "education": 0.15, "projects": 0.15}
STOP_WORDS = {"the", "and", "with", "for", "from", "this", "that", "will", "are", "our", "your", "you", "role", "job", "work", "have", "has", "into", "using", "their", "about", "years", "experience", "looking", "required", "preferred", "responsibilities"}

class RegisterRequest(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class MatchRequest(BaseModel):
    resume_text: str = Field(min_length=1)
    job_description: str = Field(min_length=1)

class StartRequest(BaseModel):
    analysis_id: str = Field(min_length=1)

class AnswerRequest(BaseModel):
    answer_submission_id: str = Field(min_length=1)
    transcript: str = Field(min_length=1)


def secret() -> str:
    return os.getenv("JWT_SECRET", "development-secret-change-me-please-32")


def token_for(user: dict[str, Any]) -> str:
    expires = datetime.now(timezone.utc) + timedelta(minutes=int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "1440")))
    return jwt.encode({"sub": str(user["_id"]), "exp": expires}, secret(), algorithm=os.getenv("JWT_ALGORITHM", "HS256"))


def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(security)) -> dict[str, Any]:
    if not credentials:
        raise HTTPException(status_code=401, detail="Authentication is required.")
    try:
        payload = jwt.decode(credentials.credentials, secret(), algorithms=[os.getenv("JWT_ALGORITHM", "HS256")])
    except jwt.PyJWTError as error:
        raise HTTPException(status_code=401, detail="Your session is invalid or expired.") from error
    user = store.find_one("users", {"_id": payload.get("sub")})
    if not user:
        raise HTTPException(status_code=401, detail="User account was not found.")
    return user


def extract_text(filename: str, content: bytes) -> str:
    suffix = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if suffix == "pdf" and fitz:
        try:
            document = fitz.open(stream=content, filetype="pdf")
            return "\n".join(page.get_text() for page in document).strip()
        except Exception as error:
            raise HTTPException(status_code=400, detail="We could not read this PDF.") from error
    if suffix == "docx" and Document:
        try:
            document = Document(io.BytesIO(content))
            return "\n".join(paragraph.text for paragraph in document.paragraphs).strip()
        except Exception as error:
            raise HTTPException(status_code=400, detail="We could not read this DOCX file.") from error
    raise HTTPException(status_code=400, detail="Upload a PDF or DOCX resume.")


def terms_from_jd(job: str) -> list[str]:
    candidates = re.findall(r"[A-Za-z][A-Za-z0-9+#./-]{1,}(?:\s+[A-Za-z][A-Za-z0-9+#./-]{1,})?", job)
    unique: list[str] = []
    for candidate in candidates:
        value = candidate.strip(" .,:;()[]{}")
        if value.lower() in STOP_WORDS or len(value) < 2 or value.lower() in {item.lower() for item in unique}:
            continue
        unique.append(value)
    return unique[:24]


def evidence_for(resume: str, term: str) -> str:
    for line in resume.splitlines():
        if term.lower() in line.lower():
            return line.strip()[:240]
    return "This requirement is not clearly demonstrated in the supplied resume."


def build_analysis(resume: str, job: str, user_id: str, resume_id: str, job_id: str) -> dict[str, Any]:
    requirements = terms_from_jd(job)
    matches = []
    resume_lower = resume.lower()
    resume_tokens = set(re.findall(r"[a-z0-9+#./-]+", resume_lower))
    for term in requirements:
        term_tokens = set(re.findall(r"[a-z0-9+#./-]+", term.lower()))
        overlap = len(term_tokens & resume_tokens) / max(len(term_tokens), 1)
        status = "matched" if term.lower() in resume_lower or overlap >= 0.75 else "partial" if overlap > 0 else "missing"
        matches.append({"name": term, "status": status, "evidence": evidence_for(resume, term), "requirement": f"The supplied job description mentions {term}."})
    matched = sum(item["status"] == "matched" for item in matches)
    partial = sum(item["status"] == "partial" for item in matches)
    total = max(len(matches), 1)
    skills_score = round((matched + partial * 0.5) / total * 100)
    lines = [line.strip() for line in job.splitlines() if line.strip()]
    role = lines[0] if lines else "Target role"
    fallback = {"job_title": role, "required_skills": requirements, "preferred_skills": [], "technologies": requirements, "responsibilities": lines[1:]}
    extracted = generate_json(f"Extract structured job requirements as JSON from this job description. Do not invent data.\n{job}", fallback)
    gaps = [{"skill": item["name"], "priority": "High" if item["status"] == "missing" else "Medium", "why": item["requirement"], "next": f"Practice {item['name']} and add evidence from a real project."} for item in matches if item["status"] != "matched"]
    roadmap = [{"skill": gap["skill"], "steps": [f"Learn the fundamentals of {gap['skill']}.", f"Practice core {gap['skill']} concepts.", f"Apply {gap['skill']} in a small project.", f"Document your {gap['skill']} evidence."], "project": f"Build a focused project demonstrating {gap['skill']}."} for gap in gaps]
    questions = [f"Which experience from your resume best connects to the {item['name']} requirement?" for item in matches if item["status"] == "matched"][:3]
    questions += [f"The role mentions {item['name']}, while the resume evidence is limited. How would you approach this requirement?" for item in matches if item["status"] != "matched"][:4]
    questions += [f"Describe a realistic technical scenario where you would apply the responsibilities in this role.", "What would you want to improve before starting this role?"]
    return {"id": str(uuid.uuid4()), "user_id": user_id, "resume_id": resume_id, "job_description_id": job_id, "role": extracted.get("job_title") or role, "candidate": "", "score": round(skills_score * SCORING_WEIGHTS["skills"] + 70 * SCORING_WEIGHTS["experience"] + 70 * SCORING_WEIGHTS["education"] + 70 * SCORING_WEIGHTS["projects"]), "scoreBreakdown": [{"label": "Skills", "value": skills_score}, {"label": "Experience", "value": 70}, {"label": "Education", "value": 70}, {"label": "Projects", "value": 70}], "skills": matches, "positives": [f"{item['name']} is demonstrated in the supplied resume." for item in matches if item["status"] == "matched"], "gaps": gaps, "roadmap": roadmap, "questions": questions[:10], "extraction": extracted, "demo_mode": False, "scoring_weights": SCORING_WEIGHTS, "created_at": utc_now()}


def owned(collection: str, item_id: str, user_id: str) -> dict[str, Any]:
    item = store.find_one(collection, {"_id": item_id, "user_id": user_id})
    if not item:
        raise HTTPException(status_code=404, detail="The requested resource was not found.")
    return item


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "mode": "demo" if os.getenv("DEMO_MODE", "false").lower() == "true" else "production", "database": "dynamodb" if store.available else "dynamodb-unavailable", "s3": bool(os.getenv("S3_BUCKET_NAME", "").strip())}

@app.post("/api/auth/register")
def register(request: RegisterRequest) -> dict[str, Any]:
    if request.password.lower() in {"password", "password123", "qwerty123"}:
        raise HTTPException(status_code=400, detail="Choose a stronger password.")
    email = str(request.email).lower()
    if store.find_one("users", {"email": email}):
        raise HTTPException(status_code=409, detail="An account with this email already exists.")
    user = {"_id": str(uuid.uuid4()), "name": request.name.strip(), "email": email, "password_hash": bcrypt.hashpw(request.password.encode(), bcrypt.gensalt()).decode(), "created_at": utc_now()}
    try:
        store.insert("users", user)
    except DuplicateKeyError as error:
        raise HTTPException(status_code=409, detail="An account with this email already exists.") from error
    return {"access_token": token_for(user), "token_type": "bearer", "user": {"id": user["_id"], "name": user["name"], "email": user["email"]}}

@app.post("/api/auth/login")
def login(request: LoginRequest) -> dict[str, Any]:
    user = store.find_one("users", {"email": str(request.email).lower()})
    if not user or not bcrypt.checkpw(request.password.encode(), user["password_hash"].encode()):
        raise HTTPException(status_code=401, detail="Incorrect email or password.")
    return {"access_token": token_for(user), "token_type": "bearer", "user": {"id": user["_id"], "name": user["name"], "email": user["email"]}}

@app.get("/api/auth/me")
def me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"id": user["_id"], "name": user["name"], "email": user["email"]}

@app.post("/api/analyze")
async def analyze(resume: UploadFile = File(...), job_description: str = Form(...), user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if not job_description.strip():
        raise HTTPException(status_code=400, detail="Paste a target job description before analyzing.")
    content = await resume.read()
    if not content or len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Resume must be present and smaller than 10 MB.")
    resume_text = extract_text(resume.filename or "resume", content)
    if not resume_text:
        raise HTTPException(status_code=400, detail="The uploaded resume is empty.")
    user_id = str(user["_id"])
    resume_key = f"{user_id}/resumes/{uuid.uuid4()}-{resume.filename}"
    resume_url = None
    try:
        resume_url = store.upload_file(io.BytesIO(content), resume_key, resume.content_type)
    except Exception as error:
        raise HTTPException(status_code=502, detail="Resume storage is unavailable. Please try again.") from error
    resume_id = store.insert("resumes", {"user_id": user_id, "file_name": resume.filename, "file_type": resume.content_type, "raw_text": resume_text, "s3_key": resume_key if resume_url else None, "s3_url": resume_url})
    job_id = store.insert("job_descriptions", {"user_id": user_id, "raw_text": job_description, "job_title": job_description.splitlines()[0].strip()})
    result = build_analysis(resume_text, job_description, user_id, resume_id, job_id)
    store.insert("resume_analyses", result)
    store.insert("learning_paths", {"user_id": user_id, "analysis_id": result["id"], "roadmap": result["roadmap"]})
    return result

@app.post("/api/resume/upload")
async def upload_resume(resume: UploadFile = File(...), user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    content = await resume.read()
    text = extract_text(resume.filename or "resume", content)
    user_id = str(user["_id"])
    resume_key = f"{user_id}/resumes/{uuid.uuid4()}-{resume.filename}"
    try:
        resume_url = store.upload_file(io.BytesIO(content), resume_key, resume.content_type)
    except Exception as error:
        raise HTTPException(status_code=502, detail="Resume storage is unavailable. Please try again.") from error
    resume_id = store.insert("resumes", {"user_id": user_id, "file_name": resume.filename, "file_type": resume.content_type, "raw_text": text, "s3_key": resume_key if resume_url else None, "s3_url": resume_url})
    return {"resume_id": resume_id, "file_name": resume.filename, "extracted_text": text, "s3_url": resume_url}

@app.get("/api/resumes")
def resumes(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    return store.find_many("resumes", {"user_id": str(user["_id"])})

@app.post("/api/job/analyze")
def analyze_job(job_description: str = Form(...), user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if not job_description.strip():
        raise HTTPException(status_code=400, detail="Paste a target job description before continuing.")
    lines = [line.strip() for line in job_description.splitlines() if line.strip()]
    return generate_json(f"Extract structured job requirements as JSON. Do not invent data.\n{job_description}", {"job_title": lines[0] if lines else "", "required_skills": terms_from_jd(job_description), "preferred_skills": [], "responsibilities": lines[1:]})

@app.post("/api/match")
def match_documents(request: MatchRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    user_id = str(user["_id"])
    return build_analysis(request.resume_text, request.job_description, user_id, "", "")

@app.get("/api/analysis")
def list_analysis(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    return store.find_many("resume_analyses", {"user_id": str(user["_id"])})

@app.get("/api/analysis/{analysis_id}")
def get_analysis(analysis_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return owned("resume_analyses", analysis_id, str(user["_id"]))

@app.get("/api/analysis/{analysis_id}/learning-path")
def learning_path(analysis_id: str, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    analysis = owned("resume_analyses", analysis_id, str(user["_id"]))
    return analysis.get("roadmap", [])

@app.post("/api/interview/start")
def start_interview(request: StartRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    user_id = str(user["_id"])
    analysis = owned("resume_analyses", request.analysis_id, user_id)
    session_id = str(uuid.uuid4())
    session = {"_id": session_id, "session_id": session_id, "user_id": user_id, "analysis_id": request.analysis_id, "status": "active", "current_question_index": 0, "questions": analysis.get("questions", []), "role": analysis.get("role", "Target role"), "completed_answer_ids": [], "answers": {}, "started_at": utc_now(), "elapsed_seconds": 0}
    SESSIONS[session_id] = session
    store.insert("interview_sessions", session)
    if not session["questions"]:
        raise HTTPException(status_code=400, detail="This analysis has no interview questions yet.")
    return {**session, "question": session["questions"][0]}

@app.post("/api/interview/{session_id}/answer")
def answer(session_id: str, request: AnswerRequest, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    session = SESSIONS.get(session_id)
    if not session or session["user_id"] != str(user["_id"]):
        raise HTTPException(status_code=404, detail="Interview session not found.")
    if request.answer_submission_id in session["answers"]:
        return {"duplicate": True, **session["answers"][request.answer_submission_id]}
    existing = store.find_one("interview_answers", {"answer_submission_id": request.answer_submission_id, "user_id": str(user["_id"])})
    if existing:
        return {"duplicate": True, **existing}
    index = session["current_question_index"]
    result = {"answer_submission_id": request.answer_submission_id, "question_index": index, "transcript": request.transcript, "evaluation": {"relevance": 0, "technical_correctness": 0, "depth": 0, "clarity": 0}}
    session["answers"][request.answer_submission_id] = result
    session["completed_answer_ids"].append(request.answer_submission_id)
    session["current_question_index"] = min(index + 1, len(session["questions"]))
    store.insert("interview_answers", {"user_id": str(user["_id"]), "session_id": session_id, **result})
    return {"duplicate": False, **result, "next_action": "NEXT_TOPIC"}

@app.get("/api/interview/{session_id}/state")
def interview_state(session_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    session = SESSIONS.get(session_id)
    if not session or session["user_id"] != str(user["_id"]):
        raise HTTPException(status_code=404, detail="Interview session not found.")
    index = session["current_question_index"]
    return {**session, "question": session["questions"][index] if index < len(session["questions"]) else None}

@app.post("/api/interview/{session_id}/next")
def next_question(session_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    state = interview_state(session_id, user)
    return {"question": state["question"], "question_index": state["current_question_index"], "status": state["status"]}

@app.post("/api/interview/{session_id}/end")
def end_interview(session_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    session = SESSIONS.get(session_id)
    if not session or session["user_id"] != str(user["_id"]):
        raise HTTPException(status_code=404, detail="Interview session not found.")
    session["status"] = "completed"
    store.update("interview_sessions", {"_id": session_id, "user_id": str(user["_id"])}, {"status": "completed", "completed_at": utc_now()})
    return {"status": "completed", "session_id": session_id}

@app.get("/api/interview/{session_id}/report")
def interview_report(session_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    session = SESSIONS.get(session_id)
    if not session or session["user_id"] != str(user["_id"]):
        raise HTTPException(status_code=404, detail="Interview session not found.")
    analysis = owned("resume_analyses", session["analysis_id"], str(user["_id"]))
    return {"session_id": session_id, "target_role": analysis["role"], "questions_completed": len(session["completed_answer_ids"]), "strengths": [item["name"] for item in analysis["skills"] if item["status"] == "matched"], "prepare": [item["name"] for item in analysis["skills"] if item["status"] != "matched"], "feedback": list(session["answers"].values())}
