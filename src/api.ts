export type User = { id: string; name: string; email: string }
export type SkillStatus = 'matched' | 'partial' | 'missing'
export type Skill = { name: string; status: SkillStatus; evidence: string; requirement: string }
export type Analysis = { id: string; role: string; candidate: string; score: number; scoreBreakdown: { label: string; value: number }[]; skills: Skill[]; positives: string[]; gaps: { skill: string; priority: string; why: string; next: string }[]; roadmap: { skill: string; steps: string[]; project: string }[]; questions: string[]; created_at?: string }
export type InterviewState = { session_id: string; status: string; current_question_index: number; total_questions?: number; completed_answer_ids: string[]; question: string | null }
export type AnswerResult = { duplicate: boolean; answer_submission_id: string; next_action: 'ASK_FOLLOW_UP' | 'NEXT_TOPIC'; question_index: number; transcript: string }

const base = () => import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000'
export const token = () => localStorage.getItem('skillsync_token')

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const auth = token()
  if (auth) headers.set('Authorization', `Bearer ${auth}`)
  const response = await fetch(`${base()}${path}`, { ...init, headers })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.detail || 'The request could not be completed.')
  return body as T
}

export async function register(name: string, email: string, password: string): Promise<{ access_token: string; user: User }> { return request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password }) }) }
export async function login(email: string, password: string): Promise<{ access_token: string; user: User }> { return request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }) }
export async function me(): Promise<User> { return request('/api/auth/me') }
export async function listAnalyses(): Promise<Analysis[]> { return request('/api/analysis') }

export async function analyzeResume(file: File, jobDescription: string): Promise<Analysis> {
  const form = new FormData()
  form.append('resume', file)
  form.append('job_description', jobDescription)
  return request('/api/analyze', { method: 'POST', body: form })
}

export async function startInterview(analysisId: string): Promise<InterviewState & { question: string }> { return request('/api/interview/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ analysis_id: analysisId }) }) }
export async function getInterviewState(sessionId: string): Promise<InterviewState> { return request(`/api/interview/${sessionId}/state`) }
export async function submitInterviewAnswer(sessionId: string, answerSubmissionId: string, transcript: string): Promise<AnswerResult> { return request(`/api/interview/${sessionId}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer_submission_id: answerSubmissionId, transcript }) }) }
export async function endInterview(sessionId: string): Promise<void> { await request(`/api/interview/${sessionId}/end`, { method: 'POST' }) }
