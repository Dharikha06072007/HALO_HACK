# SkillSync AI

AI-powered career intelligence and virtual recruitment assistant.

## Run locally

### Frontend

```powershell
npm install
npm run dev
```

Open http://localhost:5173.

### Backend

```powershell
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.app.main:app --reload --port 8000
```

Set `VITE_API_URL=http://localhost:8000` in a local `.env` to use the FastAPI analysis endpoint. Without it, the frontend runs in deterministic demo mode and remains fully navigable.

## MVP included

- Resume PDF/DOCX upload surface with validation.
- Job description input and explainable resume-to-role matching.
- Matched, partial, and not-clearly-demonstrated skill states.
- Score breakdown, evidence map, skill gaps, and a personalized roadmap.
- AI HR interview room with contextual demo questions, typed-answer fallback, progress, and live-room controls.
- FastAPI endpoints for analysis, interview sessions, state recovery, reports, and idempotent answer submissions.
- `GEMINI_API_KEY`, `DATABASE_URL`, `AI_PROVIDER`, and `DEMO_MODE` examples in `.env.example`.

The current AI provider is deterministic demo mode. Gemini and PostgreSQL configuration are reserved for the next integration slice; no API key is hardcoded.