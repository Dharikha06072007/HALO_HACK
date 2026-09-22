import { useEffect, useReducer, useRef } from 'react'
import { ArrowUpRight, Check, Mic, MicOff, Pause, Play, RotateCcw, Sparkles, Video, VideoOff, Wifi, X } from 'lucide-react'
import { Analysis, endInterview, getInterviewState, startInterview, submitInterviewAnswer } from './api'

type InterviewState = 'SETUP' | 'CONNECTING' | 'CONNECTED' | 'AI_SPEAKING' | 'LISTENING' | 'PROCESSING' | 'COMPLETED' | 'ERROR'
type State = { state: InterviewState; started: boolean; sessionId: string; questionIndex: number; question: string; answer: string; interim: string; history: string[]; micEnabled: boolean; cameraEnabled: boolean; captionsEnabled: boolean; error: string; elapsedSeconds: number }
type Action =
  | { type: 'CONNECT' }
  | { type: 'CONNECTED'; sessionId: string; question: string; questionIndex?: number }
  | { type: 'SPEAKING' }
  | { type: 'LISTENING' }
  | { type: 'ANSWER'; value: string }
  | { type: 'INTERIM'; value: string }
  | { type: 'PROCESSING' }
  | { type: 'NEXT'; question: string; questionIndex: number; transcript: string }
  | { type: 'TOGGLE_MIC' }
  | { type: 'TOGGLE_CAMERA' }
  | { type: 'COMPLETE' }
  | { type: 'ERROR'; message: string }

const initialState = (question: string): State => ({ state: 'SETUP', started: false, sessionId: '', questionIndex: 0, question, answer: '', interim: '', history: [], micEnabled: true, cameraEnabled: true, captionsEnabled: true, error: '', elapsedSeconds: 0 })

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'CONNECT': return { ...state, state: 'CONNECTING', started: true, error: '' }
    case 'CONNECTED': return { ...state, state: 'CONNECTED', sessionId: action.sessionId, question: action.question, questionIndex: action.questionIndex ?? 0 }
    case 'SPEAKING': return { ...state, state: 'AI_SPEAKING' }
    case 'LISTENING': return { ...state, state: 'LISTENING' }
    case 'ANSWER': return { ...state, answer: action.value, interim: '' }
    case 'INTERIM': return { ...state, interim: action.value }
    case 'PROCESSING': return { ...state, state: 'PROCESSING' }
    case 'NEXT': return { ...state, state: 'CONNECTED', answer: '', interim: '', question: action.question, questionIndex: action.questionIndex, history: [...state.history, action.transcript] }
    case 'TOGGLE_MIC': return { ...state, micEnabled: !state.micEnabled }
    case 'TOGGLE_CAMERA': return { ...state, cameraEnabled: !state.cameraEnabled }
    case 'COMPLETE': return { ...state, state: 'COMPLETED' }
    case 'ERROR': return { ...state, state: 'ERROR', error: action.message }
  }
}

function getSpeechRecognition(): any {
  const browserWindow = window as Window & { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any }
  return browserWindow.SpeechRecognition || browserWindow.webkitSpeechRecognition
}

export default function InterviewRoom({ analysis }: { analysis: Analysis }) {
  const [room, dispatch] = useReducer(reducer, initialState(analysis.questions[0]))
  const [mediaError, setMediaError] = useReducer((_value: string, next: string) => next, '')
  const mediaStream = useRef<MediaStream | null>(null)
  const recognition = useRef<any>(null)
  const startedFromRecovery = useRef(false)

  useEffect(() => () => {
    mediaStream.current?.getTracks().forEach((track) => track.stop())
    recognition.current?.stop()
    window.speechSynthesis.cancel()
  }, [])

  useEffect(() => {
    if (!room.started || room.state === 'COMPLETED') return
    const timer = window.setInterval(() => {
      const key = 'skillsync-interview-recovery'
      const saved = sessionStorage.getItem(key)
      if (saved) sessionStorage.setItem(key, JSON.stringify({ ...JSON.parse(saved), elapsedSeconds: room.elapsedSeconds + 1 }))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [room.started, room.state, room.elapsedSeconds])

  const speakQuestion = (question: string) => {
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(question)
    utterance.onstart = () => dispatch({ type: 'SPEAKING' })
    utterance.onend = () => dispatch({ type: 'LISTENING' })
    utterance.onerror = () => dispatch({ type: 'LISTENING' })
    window.speechSynthesis.speak(utterance)
  }

  const join = async () => {
    dispatch({ type: 'CONNECT' })
    if (!mediaStream.current && navigator.mediaDevices?.getUserMedia) {
      try {
        mediaStream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      } catch {
        setMediaError('Camera or microphone access was unavailable. You can continue with typed answers.')
      }
    }
    try {
      const recovery = sessionStorage.getItem('skillsync-interview-recovery')
      if (recovery && !startedFromRecovery.current) {
        const saved = JSON.parse(recovery) as { sessionId?: string }
        if (saved.sessionId) {
          const recovered = await getInterviewState(saved.sessionId)
          if (recovered.status === 'active') {
            startedFromRecovery.current = true
            dispatch({ type: 'CONNECTED', sessionId: recovered.session_id, question: recovered.question ?? analysis.questions[recovered.current_question_index] ?? analysis.questions[0], questionIndex: recovered.current_question_index })
            return
          }
        }
      }
      const session = await startInterview(analysis.id)
      dispatch({ type: 'CONNECTED', sessionId: session.session_id, question: session.question, questionIndex: session.current_question_index })
      sessionStorage.setItem('skillsync-interview-recovery', JSON.stringify({ sessionId: session.session_id, questionId: session.current_question_index, submittedAnswerIds: [], finalTranscript: '', interimTranscript: '', elapsedSeconds: 0, micEnabled: true, cameraEnabled: true, captionsEnabled: true }))
      speakQuestion(session.question)
    } catch {
      const localSessionId = `demo-${Date.now()}`
      dispatch({ type: 'CONNECTED', sessionId: localSessionId, question: analysis.questions[0] })
      sessionStorage.setItem('skillsync-interview-recovery', JSON.stringify({ sessionId: localSessionId, questionId: 0, submittedAnswerIds: [], elapsedSeconds: 0 }))
      speakQuestion(analysis.questions[0])
    }
  }

  const startListening = () => {
    const SpeechRecognition = getSpeechRecognition()
    if (!SpeechRecognition) return
    recognition.current?.stop()
    const nextRecognition = new SpeechRecognition()
    nextRecognition.continuous = true
    nextRecognition.interimResults = true
    nextRecognition.onresult = (event: any) => {
      let finalText = ''
      let interimText = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const text = event.results[index][0].transcript
        if (event.results[index].isFinal) finalText += text
        else interimText += text
      }
      if (finalText) dispatch({ type: 'ANSWER', value: `${room.answer} ${finalText}`.trim() })
      dispatch({ type: 'INTERIM', value: interimText })
    }
    nextRecognition.onerror = () => setMediaError('Speech recognition is unavailable. You can type your answer below.')
    recognition.current = nextRecognition
    nextRecognition.start()
  }

  const submit = async () => {
    const transcript = room.answer.trim()
    if (!transcript || room.state === 'PROCESSING') return
    recognition.current?.stop()
    dispatch({ type: 'PROCESSING' })
    const answerId = `${room.sessionId}_q${room.questionIndex}_${Date.now()}`
    try {
      const result = await submitInterviewAnswer(room.sessionId, answerId, transcript)
      const nextIndex = room.questionIndex + 1
      if (nextIndex >= analysis.questions.length) {
        dispatch({ type: 'COMPLETE' })
        await endInterview(room.sessionId).catch(() => undefined)
        sessionStorage.removeItem('skillsync-interview-recovery')
      } else {
        const nextQuestion = result.next_action === 'ASK_FOLLOW_UP' && room.questionIndex === 0
          ? 'You mentioned JWT authentication. Could you explain how protected routes validated the token?'
          : analysis.questions[nextIndex]
        dispatch({ type: 'NEXT', question: nextQuestion, questionIndex: nextIndex, transcript })
        speakQuestion(nextQuestion)
      }
    } catch {
      dispatch({ type: 'ERROR', message: 'Connection lost. Your answer was not confirmed. Retry to submit the same answer.' })
    }
  }

  if (room.state === 'SETUP') return <Setup analysis={analysis} mediaError={mediaError} onJoin={join} />
  if (room.state === 'COMPLETED') return <Completed analysis={analysis} />
  if (room.state === 'ERROR') return <div className="interview-error"><Wifi size={24} /><h2>Connection paused</h2><p>{room.error}</p><button className="primary-button" onClick={submit}><RotateCcw size={15} /> Retry answer</button></div>

  return <div className="live-room"><div className="room-top"><div><span className="eyebrow">LIVE INTERVIEW / {room.state}</span><h2>{analysis.role}</h2></div><div className="room-status"><span className="status-dot" /> Connected <span className="timer">{String(Math.floor(room.elapsedSeconds / 60)).padStart(2, '0')}:{String(room.elapsedSeconds % 60).padStart(2, '0')}</span></div></div><div className="video-stage"><div className="ai-stage"><div className="ai-stage-avatar"><Sparkles size={48} /><span>AI</span></div><div className="speaking-label"><span className="sound-wave"><i /><i /><i /></span> {room.state === 'AI_SPEAKING' ? 'AI Interviewer is speaking' : room.state === 'PROCESSING' ? 'Analyzing your answer' : 'Listening for your answer'}</div></div><div className={`candidate-tile ${!room.cameraEnabled ? 'camera-off' : ''}`}>{room.cameraEnabled ? <span>MC</span> : <VideoOff size={22} />}<small>You</small></div>{room.captionsEnabled && <div className="stage-caption"><span>{room.state === 'LISTENING' ? 'AI' : 'YOU'}</span>{room.state === 'LISTENING' ? room.question : room.answer || room.interim || 'Your live transcript will appear here.'}</div>}</div>{mediaError && <div className="room-notice">{mediaError}<button onClick={() => setMediaError('')}><X size={14} /></button></div>}<div className="answer-bar"><div className="answer-status"><div className="mic-live">{room.micEnabled ? <Mic size={17} /> : <MicOff size={17} />}</div><span>{room.state === 'AI_SPEAKING' ? 'AI is speaking' : room.state === 'PROCESSING' ? 'Saving answer...' : 'Listening'}</span></div><input value={room.answer} onChange={(event) => dispatch({ type: 'ANSWER', value: event.target.value })} placeholder="Type an answer or use your microphone..." onFocus={startListening} onKeyDown={(event) => { if (event.key === 'Enter') submit() }} /><button className="mic-button" onClick={startListening} title="Start voice recognition"><Mic size={18} /></button><button className="send-answer" onClick={submit} disabled={room.state === 'PROCESSING'}><ArrowUpRight size={17} /></button></div><div className="room-controls"><button onClick={() => dispatch({ type: 'TOGGLE_MIC' })}>{room.micEnabled ? <Mic size={17} /> : <MicOff size={17} />}</button><button onClick={() => dispatch({ type: 'TOGGLE_CAMERA' })}>{room.cameraEnabled ? <Video size={17} /> : <VideoOff size={17} />}</button><span>Question {Math.min(room.questionIndex + 1, analysis.questions.length)} / {analysis.questions.length}</span><button className="end-button" onClick={() => { window.speechSynthesis.cancel(); dispatch({ type: 'COMPLETE' }); endInterview(room.sessionId).catch(() => undefined) }}>End interview</button></div></div>
}

function Setup({ analysis, mediaError, onJoin }: { analysis: Analysis; mediaError: string; onJoin: () => void }) {
  return <div className="interview-page"><div className="interview-setup"><div className="setup-copy"><span className="eyebrow">AI HR INTERVIEW / {analysis.role.toUpperCase()}</span><h2>Your next conversation<br /><span>starts here.</span></h2><p>A realistic practice round shaped by your resume, your target role, and the gaps worth exploring.</p><div className="setup-checks"><div><Video size={17} /><span><b>Camera</b><small>Permission requested on join</small></span><Check size={15} /></div><div><Mic size={17} /><span><b>Microphone</b><small>Voice answers with typed fallback</small></span><Check size={15} /></div><div><Wifi size={17} /><span><b>Connection</b><small>Session recovery enabled</small></span><Check size={15} /></div></div>{mediaError && <div className="room-notice">{mediaError}</div>}<button className="primary-button" onClick={onJoin}>Join interview <ArrowUpRight size={16} /></button></div><div className="setup-preview"><div className="preview-glow" /><div className="preview-avatar"><Sparkles size={40} /><span>SKILLSYNC AI</span></div><div className="preview-label"><span className="status-dot" /> AI interviewer is ready</div></div></div><div className="interview-note"><span>5 personalized questions</span><span>·</span><span>Approx. 12 minutes</span><span>·</span><span>Content-only feedback</span></div></div>
}

function Completed({ analysis }: { analysis: Analysis }) {
  const demonstrated = analysis.skills.filter((skill) => skill.status === 'matched').slice(0, 4)
  const prepare = analysis.skills.filter((skill) => skill.status !== 'matched')
  return <div className="report-page"><div className="report-heading"><div><span className="eyebrow">INTERVIEW COMPLETE / PREPARATION REPORT</span><h2>Your next conversation is clearer.</h2><p>Feedback is based on answer content and its connection to the {analysis.role} requirements.</p></div><div className="complete-icon"><Check size={28} /></div></div><div className="report-summary"><div><span>ROLE</span><strong>{analysis.role}</strong></div><div><span>QUESTIONS</span><strong>{analysis.questions.length}</strong></div><div><span>CONTENT FOCUS</span><strong>Technical + role fit</strong></div></div><div className="report-columns"><section className="report-card"><span className="eyebrow">STRONG DEMONSTRATED AREAS</span><h3>Keep these stories ready.</h3>{demonstrated.map((skill) => <div className="report-skill" key={skill.name}><Check size={14} /><span><strong>{skill.name}</strong><small>{skill.evidence}</small></span></div>)}</section><section className="report-card prepare-card"><span className="eyebrow">AREAS TO PREPARE</span><h3>Turn uncertainty into evidence.</h3>{prepare.map((skill) => <div className="report-skill" key={skill.name}><span className={`report-marker ${skill.status}`} /> <span><strong>{skill.name}</strong><small>{skill.status === 'partial' ? 'Related experience exists; prepare a transition story.' : 'Not clearly demonstrated in the resume.'}</small></span></div>)}</section></div><div className="report-next"><Sparkles size={17} /><span><strong>Suggested next step:</strong> Practice explaining one project with context, decisions, trade-offs, and measurable evidence.</span><button className="primary-button" onClick={() => window.location.reload()}><RotateCcw size={15} /> Practice again</button></div></div>
}
