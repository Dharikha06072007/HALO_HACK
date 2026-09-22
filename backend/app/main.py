from __future__ import annotations

import io
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:
    import fitz
except ImportError:  # pragma: no cover
    fitz = None

try:
    from docx import Document
except ImportError:  # pragma: no cover
    Document = None

app = FastAPI(title="SkillSync AI API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEMO_RESUME = """Maya Chen\nPython FastAPI MongoDB JWT React\nEduTwin: built a FastAPI backend, REST APIs, MongoDB data layer, and JWT authentication.\n"""
DEMO_JD = """Backend Developer\nPython FastAPI REST APIs PostgreSQL Docker AWS\nBuild secure services, improve reliability, and collaborate with product teams."""
SESSIONS: dict[str, dict[str, Any]] = {}

class AnswerRequest(BaseModel):
    answer_submission_id: str = Field(min_length=1)
    transcript: str = Field(min_length=1)

class StartRequest(BaseModel):
    analysis_id: str = "demo-analysis"


def extract_text(filename: str, content: bytes) -> str:
    suffix = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if suffix == "pdf" and fitz:
        document = fitz.open(stream=content, filetype="pdf")
        return "\n".join(page.get_text() for page in document).strip()
    if suffix == "docx" and Document:
        document = Document(io.BytesIO(content))
        return "\n".join(paragraph.text for paragraph in document.paragraphs).strip()
    if suffix in {"txt", "md"}:
        return content.decode("utf-8", errors="ignore").strip()
    raise HTTPException(status_code=400, detail="Use a PDF, DOCX, TXT, or Markdown file.")


def has(text: str, term: str) -> bool:
    return bool(re.search(rf"\b{re.escape(term)}\b", text, re.IGNORECASE))


def build_analysis(resume_text: str, job_description: str) -> dict[str, Any]:
    resume = resume_text or DEMO_RESUME
    job = job_description or DEMO_JD
    role = job.splitlines()[0].strip() or "Backend Developer"
    candidates = [
        ("Python", "Core language for service development.", "Used across backend and data projects."),
        ("FastAPI", "Experience building REST APIs using FastAPI.", "Built the EduTwin backend with FastAPI."),
        ("REST APIs", "Build and maintain production APIs.", "Designed authenticated API routes for EduTwin."),
        ("JWT", "Secure service-to-service and user auth.", "Implemented JWT-based authentication."),
        ("PostgreSQL", "Role uses PostgreSQL for transactional data.", "MongoDB experience demonstrates data modeling fundamentals."),
        ("Docker", "Containerize services for consistent delivery.", "Not clearly demonstrated in the resume."),
        ("AWS", "Deploy and operate backend services.", "Not clearly demonstrated in the resume."),
    ]
    skills = []
    for name, requirement, evidence in candidates:
        if name == "PostgreSQL" and has(resume, "MongoDB") and not has(resume, name):
            status = "partial"
        elif has(resume, name):
            status = "matched"
        else:
            status = "missing"
        skills.append({"name": name, "status": status, "evidence": evidence, "requirement": requirement})
    matched = sum(skill["status"] == "matched" for skill in skills)
    partial = sum(skill["status"] == "partial" for skill in skills)
    score = round(58 + matched * 4 + partial * 2)
    return {
        "id": str(uuid.uuid4()),
        "role": role,
        "candidate": "Candidate",
        "score": min(score, 96),
        "scoreBreakdown": [{"label": "Skills", "value": min(62 + matched * 5 + partial * 3, 96)}, {"label": "Experience", "value": 70}, {"label": "Education", "value": 85}, {"label": "Projects", "value": 76}],
        "skills": skills,
        "positives": [f"{skill['name']} is clearly demonstrated in the supplied resume." for skill in skills if skill["status"] == "matched"],
        "gaps": [{"skill": skill["name"], "priority": "High" if skill["name"] in {"Docker", "AWS"} else "Medium", "why": skill["requirement"], "next": f"Build a small project that demonstrates {skill['name']} with evidence you can discuss."} for skill in skills if skill["status"] != "matched"],
        "roadmap": [{"skill": "Docker", "steps": ["Understand images, containers, and volumes.", "Write a Dockerfile for FastAPI.", "Use Compose with PostgreSQL.", "Deploy a small containerized API."], "project": "Containerize an authenticated FastAPI + PostgreSQL service."}, {"skill": "PostgreSQL", "steps": ["Review relational modeling and joins.", "Practice constraints and indexes.", "Use SQLAlchemy migrations.", "Compare the model with MongoDB."], "project": "Migrate one backend feature to a relational schema."}],
        "questions": ["I noticed an important project in your resume. Could you explain what you personally implemented?", "You mentioned authentication. How did you validate tokens on protected routes?", "Your resume demonstrates related data experience. How would you approach the role's database transition?", "One required technology is not clearly demonstrated. Have you worked with it or containerization?", "Tell me about a backend debugging challenge and how you reached a resolution."],
    }


def now() -> str:
    return datetime.now(timezone.utc).isoformat()

@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "mode": "demo" if os.getenv("AI_PROVIDER", "demo") == "demo" else "configured"}

@app.post("/api/analyze")
async def analyze(resume: UploadFile | None = File(default=None), job_description: str = Form(default="")) -> dict[str, Any]:
    resume_text = DEMO_RESUME
    if resume:
        content = await resume.read()
        if len(content) > 10 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Resume must be smaller than 10 MB.")
        resume_text = extract_text(resume.filename or "resume.txt", content)
        if not resume_text:
            raise HTTPException(status_code=400, detail="The uploaded resume appears to be empty.")
    if not job_description.strip():
        raise HTTPException(status_code=400, detail="Add a job description before analyzing.")
    return build_analysis(resume_text, job_description)

@app.post("/api/interview/start")
def start_interview(request: StartRequest) -> dict[str, Any]:
    session_id = str(uuid.uuid4())
    session = {"session_id": session_id, "analysis_id": request.analysis_id, "status": "active", "current_question_index": 0, "total_questions": 5, "completed_answer_ids": [], "answers": {}, "started_at": now(), "elapsed_seconds": 0}
    SESSIONS[session_id] = session
    return {**session, "question": build_analysis(DEMO_RESUME, DEMO_JD)["questions"][0]}

@app.post("/api/interview/{session_id}/answer")
def submit_answer(session_id: str, request: AnswerRequest) -> dict[str, Any]:
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Interview session not found.")
    if request.answer_submission_id in session["answers"]:
        return {"duplicate": True, **session["answers"][request.answer_submission_id]}
    question_index = session["current_question_index"]
    result = {"answer_submission_id": request.answer_submission_id, "question_index": question_index, "transcript": request.transcript, "evaluation": {"relevance": 78, "technical_correctness": 74, "depth": 68, "clarity": 82}}
    session["answers"][request.answer_submission_id] = result
    session["completed_answer_ids"].append(request.answer_submission_id)
    session["current_question_index"] = min(question_index + 1, session["total_questions"])
    return {"duplicate": False, **result, "next_action": "ASK_FOLLOW_UP" if question_index == 0 else "NEXT_TOPIC"}

@app.get("/api/interview/{session_id}/state")
def interview_state(session_id: str) -> dict[str, Any]:
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Interview session not found.")
    questions = build_analysis(DEMO_RESUME, DEMO_JD)["questions"]
    return {**session, "question": questions[min(session["current_question_index"], len(questions) - 1)] if session["current_question_index"] < len(questions) else None}

@app.post("/api/interview/{session_id}/end")
def end_interview(session_id: str) -> dict[str, Any]:
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Interview session not found.")
    session["status"] = "completed"
    return {"status": "completed", "session_id": session_id}

@app.get("/api/interview/{session_id}/report")
def interview_report(session_id: str) -> dict[str, Any]:
    session = SESSIONS.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Interview session not found.")
    return {"session_id": session_id, "target_role": "Backend Developer", "questions_completed": len(session["completed_answer_ids"]), "strengths": ["Clear communication", "REST API fundamentals"], "prepare": ["Docker", "AWS", "PostgreSQL"], "feedback": list(session["answers"].values())}
