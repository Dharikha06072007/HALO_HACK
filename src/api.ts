export type SkillStatus = 'matched' | 'partial' | 'missing'

export type Skill = {
  name: string
  status: SkillStatus
  evidence: string
  requirement: string
}

export type Analysis = {
  id: string
  role: string
  candidate: string
  score: number
  scoreBreakdown: { label: string; value: number }[]
  skills: Skill[]
  positives: string[]
  gaps: { skill: string; priority: string; why: string; next: string }[]
  roadmap: { skill: string; steps: string[]; project: string }[]
  questions: string[]
}

export type InterviewState = {
  session_id: string
  status: string
  current_question_index: number
  total_questions: number
  completed_answer_ids: string[]
  question: string | null
}

export type AnswerResult = {
  duplicate: boolean
  answer_submission_id: string
  next_action: 'ASK_FOLLOW_UP' | 'NEXT_TOPIC'
  question_index: number
  transcript: string
}

export const demoAnalysis: Analysis = {
  id: 'demo-analysis',
  role: 'Backend Developer',
  candidate: 'Maya Chen',
  score: 78,
  scoreBreakdown: [
    { label: 'Skills', value: 82 },
    { label: 'Experience', value: 70 },
    { label: 'Education', value: 85 },
    { label: 'Projects', value: 76 },
  ],
  skills: [
    { name: 'Python', status: 'matched', evidence: 'Used across backend and data projects.', requirement: 'Core language for service development.' },
    { name: 'FastAPI', status: 'matched', evidence: 'Built the EduTwin backend with FastAPI.', requirement: 'Experience building REST APIs using FastAPI.' },
    { name: 'REST APIs', status: 'matched', evidence: 'Designed authenticated API routes for EduTwin.', requirement: 'Build and maintain production APIs.' },
    { name: 'JWT', status: 'matched', evidence: 'Implemented JWT-based authentication.', requirement: 'Secure service-to-service and user auth.' },
    { name: 'PostgreSQL', status: 'partial', evidence: 'MongoDB experience demonstrates data modeling fundamentals.', requirement: 'Role uses PostgreSQL for transactional data.' },
    { name: 'Docker', status: 'missing', evidence: 'Not clearly demonstrated in the resume.', requirement: 'Containerize services for consistent delivery.' },
    { name: 'AWS', status: 'missing', evidence: 'Not clearly demonstrated in the resume.', requirement: 'Deploy and operate backend services.' },
  ],
  positives: ['Python is clearly demonstrated across multiple projects.', 'FastAPI was used to build the EduTwin backend.', 'REST API design and JWT authentication are evidenced.', 'MongoDB experience transfers to the role\'s data modeling needs.'],
  gaps: [
    { skill: 'Docker', priority: 'High', why: 'The team uses containers for repeatable local development and deployment.', next: 'Learn images and Compose, then containerize a FastAPI service.' },
    { skill: 'AWS', priority: 'High', why: 'The role includes deploying and operating backend services.', next: 'Practice deploying one API with IAM, EC2 or Lambda, and CloudWatch.' },
    { skill: 'PostgreSQL', priority: 'Medium', why: 'The product relies on relational transactions and strong data integrity.', next: 'Map a MongoDB model to tables and build a small CRUD service.' },
  ],
  roadmap: [
    { skill: 'Docker', steps: ['Understand images, containers, and volumes.', 'Write a Dockerfile for FastAPI.', 'Use Compose with PostgreSQL.', 'Deploy a small containerized API.'], project: 'Containerize an authenticated FastAPI + PostgreSQL service.' },
    { skill: 'PostgreSQL', steps: ['Review relational modeling and joins.', 'Practice constraints and indexes.', 'Use SQLAlchemy migrations.', 'Compare the model with MongoDB.'], project: 'Migrate one EduTwin feature to a relational schema.' },
  ],
  questions: [
    'I noticed EduTwin in your resume. Could you explain the project and what you personally implemented?',
    'You mentioned JWT authentication. How did you validate tokens on protected routes?',
    'Your resume demonstrates MongoDB while this role uses PostgreSQL. How would you approach the transition?',
    'Docker is part of this role but is not clearly demonstrated. Have you worked with containerization?',
    'Tell me about a backend incident or debugging challenge and how you reached a resolution.',
  ],
}

export async function analyzeResume(file: File | null, jobDescription: string): Promise<Analysis> {
  const base = import.meta.env.VITE_API_URL
  if (!base) {
    await new Promise((resolve) => setTimeout(resolve, 900))
    return { ...demoAnalysis, candidate: file?.name ? 'Maya Chen' : 'Demo Candidate' }
  }
  const form = new FormData()
  if (file) form.append('resume', file)
  form.append('job_description', jobDescription)
  const response = await fetch(`${base}/api/analyze`, { method: 'POST', body: form })
  if (!response.ok) throw new Error('The analysis service could not process this request.')
  return response.json()
}

const apiBase = () => import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'

export async function startInterview(analysisId: string): Promise<InterviewState & { question: string }> {
  const response = await fetch(`${apiBase()}/api/interview/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysis_id: analysisId }),
  })
  if (!response.ok) throw new Error('The interview session could not be started.')
  return response.json()
}

export async function getInterviewState(sessionId: string): Promise<InterviewState> {
  const response = await fetch(`${apiBase()}/api/interview/${sessionId}/state`)
  if (!response.ok) throw new Error('The interview session could not be recovered.')
  return response.json()
}

export async function submitInterviewAnswer(sessionId: string, answerSubmissionId: string, transcript: string): Promise<AnswerResult> {
  const response = await fetch(`${apiBase()}/api/interview/${sessionId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer_submission_id: answerSubmissionId, transcript }),
  })
  if (!response.ok) throw new Error('Your answer could not be saved. It is still safe to retry.')
  return response.json()
}

export async function endInterview(sessionId: string): Promise<void> {
  await fetch(`${apiBase()}/api/interview/${sessionId}/end`, { method: 'POST' })
}
