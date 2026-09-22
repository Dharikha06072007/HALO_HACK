import { useEffect, useReducer, useRef, useState } from 'react'
import { ArrowUpRight, Check, Mic, MicOff, RotateCcw, Sparkles, Video, VideoOff, Wifi, X } from 'lucide-react'
import { Analysis, endInterview, getInterviewState, startInterview, submitInterviewAnswer } from './api'
import { analyzeFrame, CameraQuality, cleanupOpenCV, initializeOpenCV } from './services/opencvCameraService'

type RoomState = 'SETUP' | 'CONNECTING' | 'CONNECTED' | 'AI_SPEAKING' | 'LISTENING' | 'PROCESSING' | 'COMPLETED' | 'ERROR'
type Room = { state: RoomState; sessionId: string; questionIndex: number; question: string; answer: string; interim: string; micEnabled: boolean; cameraEnabled: boolean; elapsedSeconds: number; error: string }
type Action =
  | { type: 'CONNECT' }
  | { type: 'CONNECTED'; sessionId: string; question: string; questionIndex: number }
  | { type: 'SPEAKING' }
  | { type: 'LISTENING' }
  | { type: 'ANSWER'; value: string }
  | { type: 'INTERIM'; value: string }
  | { type: 'PROCESSING' }
  | { type: 'NEXT'; question: string; questionIndex: number }
  | { type: 'TOGGLE_MIC' }
  | { type: 'TOGGLE_CAMERA' }
  | { type: 'COMPLETE' }
  | { type: 'ERROR'; message: string }

const initialRoom = (question: string): Room => ({ state: 'SETUP', sessionId: '', questionIndex: 0, question, answer: '', interim: '', micEnabled: true, cameraEnabled: true, elapsedSeconds: 0, error: '' })

function reducer(room: Room, action: Action): Room {
  switch (action.type) {
    case 'CONNECT': return { ...room, state: 'CONNECTING', error: '' }
    case 'CONNECTED': return { ...room, state: 'CONNECTED', sessionId: action.sessionId, question: action.question, questionIndex: action.questionIndex }
    case 'SPEAKING': return { ...room, state: 'AI_SPEAKING' }
    case 'LISTENING': return { ...room, state: 'LISTENING' }
    case 'ANSWER': return { ...room, answer: action.value, interim: '' }
    case 'INTERIM': return { ...room, interim: action.value }
    case 'PROCESSING': return { ...room, state: 'PROCESSING' }
    case 'NEXT': return { ...room, state: 'CONNECTED', question: action.question, questionIndex: action.questionIndex, answer: '', interim: '' }
    case 'TOGGLE_MIC': return { ...room, micEnabled: !room.micEnabled }
    case 'TOGGLE_CAMERA': return { ...room, cameraEnabled: !room.cameraEnabled }
    case 'COMPLETE': return { ...room, state: 'COMPLETED' }
    case 'ERROR': return { ...room, state: 'ERROR', error: action.message }
  }
}

function recognitionConstructor(): any {
  const browserWindow = window as Window & { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any }
  return browserWindow.SpeechRecognition || browserWindow.webkitSpeechRecognition
}

export default function InterviewRoom({ analysis }: { analysis: Analysis }) {
  const [room, dispatch] = useReducer(reducer, initialRoom(analysis.questions[0]))
  const [notice, setNotice] = useState('')
  const [quality, setQuality] = useState<CameraQuality | null>(null)
  const mediaStream = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const recognition = useRef<any>(null)

  useEffect(() => () => {
    mediaStream.current?.getTracks().forEach((track) => track.stop())
    recognition.current?.stop()
    window.speechSynthesis.cancel()
    cleanupOpenCV()
  }, [])

  useEffect(() => {
    if (room.state === 'SETUP' || room.state === 'COMPLETED') return
    const interval = window.setInterval(() => {
      const stored = sessionStorage.getItem('skillsync-interview-recovery')
      if (stored) sessionStorage.setItem('skillsync-interview-recovery', JSON.stringify({ ...JSON.parse(stored), elapsedSeconds: room.elapsedSeconds + 1 }))
    }, 1000)
    return () => window.clearInterval(interval)
  }, [room.state, room.elapsedSeconds])

  useEffect(() => {
    if (!mediaStream.current || !videoRef.current || room.state === 'SETUP') return
    videoRef.current.srcObject = mediaStream.current
    let interval: number | undefined
    void initializeOpenCV().then((available) => {
      if (available && videoRef.current) interval = window.setInterval(() => videoRef.current && setQuality(analyzeFrame(videoRef.current)), 1500)
    })
    return () => { if (interval) window.clearInterval(interval) }
  }, [room.state, room.cameraEnabled])

  const speak = (question: string) => {
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(question)
    utterance.onstart = () => dispatch({ type: 'SPEAKING' })
    utterance.onend = () => dispatch({ type: 'LISTENING' })
    utterance.onerror = () => dispatch({ type: 'LISTENING' })
    window.speechSynthesis.speak(utterance)
  }

  const join = async () => {
    dispatch({ type: 'CONNECT' })
    try {
      mediaStream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    } catch {
      setNotice('Camera or microphone access was unavailable. You can continue with typed answers.')
    }
    try {
      const saved = sessionStorage.getItem('skillsync-interview-recovery')
      if (saved) {
        const recovered = JSON.parse(saved) as { sessionId?: string }
        if (recovered.sessionId) {
          const state = await getInterviewState(recovered.sessionId)
          if (state.status === 'active') {
            dispatch({ type: 'CONNECTED', sessionId: state.session_id, question: state.question ?? analysis.questions[0], questionIndex: state.current_question_index })
            return
          }
        }
      }
      const session = await startInterview(analysis.id)
      dispatch({ type: 'CONNECTED', sessionId: session.session_id, question: session.question, questionIndex: session.current_question_index })
      sessionStorage.setItem('skillsync-interview-recovery', JSON.stringify({ sessionId: session.session_id, elapsedSeconds: 0, submittedAnswerIds: [] }))
      speak(session.question)
    } catch {
      const localId = `demo-${Date.now()}`
      dispatch({ type: 'CONNECTED', sessionId: localId, question: analysis.questions[0], questionIndex: 0 })
      speak(analysis.questions[0])
    }
  }

  const listen = () => {
    const Constructor = recognitionConstructor()
    if (!Constructor || room.state === 'AI_SPEAKING') {
      setNotice('Speech recognition is unavailable. Type your answer below.')
      return
    }
    const speech = new Constructor()
    speech.continuous = true
    speech.interimResults = true
    speech.onresult = (event: any) => {
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
    speech.onerror = () => setNotice('Speech recognition stopped. You can continue with typed answers.')
    recognition.current = speech
    speech.start()
  }

  const submit = async () => {
    const transcript = room.answer.trim()
    if (!transcript || room.state === 'PROCESSING') return
    recognition.current?.stop()
    dispatch({ type: 'PROCESSING' })
    const submissionId = `${room.sessionId}_q${room.questionIndex}_${Date.now()}`
    try {
      const result = await submitInterviewAnswer(room.sessionId, submissionId, transcript)
      const nextIndex = room.questionIndex + 1
      if (nextIndex >= analysis.questions.length) {
        await endInterview(room.sessionId).catch(() => undefined)
        sessionStorage.removeItem('skillsync-interview-recovery')
        dispatch({ type: 'COMPLETE' })
        return
      }
      const nextQuestion = result.next_action === 'ASK_FOLLOW_UP' && room.questionIndex === 0
        ? 'You mentioned authentication. Could you explain how protected routes validated the token?'
        : analysis.questions[nextIndex]
      dispatch({ type: 'NEXT', question: nextQuestion, questionIndex: nextIndex })
      speak(nextQuestion)
    } catch {
      dispatch({ type: 'ERROR', message: 'Connection lost. Your answer was not confirmed. Retry with the same answer.' })
    }
  }

  const finish = () => {
    window.speechSynthesis.cancel()
    recognition.current?.stop()
    mediaStream.current?.getTracks().forEach((track) => track.stop())
    void endInterview(room.sessionId)
    dispatch({ type: 'COMPLETE' })
  }

  if (room.state === 'SETUP') return <Setup analysis={analysis} notice={notice} onJoin={join} />
  if (room.state === 'COMPLETED') return <Completed analysis={analysis} />
  if (room.state === 'ERROR') return <div className="interview-error"><Wifi size={24} /><h2>Connection paused</h2><p>{room.error}</p><button className="primary-button" onClick={submit}><RotateCcw size={15} /> Retry answer</button></div>

  return <div className="live-room">
    <div className="room-top"><div><span className="eyebrow">LIVE INTERVIEW / {room.state}</span><h2>{analysis.role}</h2></div><div className="room-status"><span className="status-dot" /> Connected <span className="timer">{String(Math.floor(room.elapsedSeconds / 60)).padStart(2, '0')}:{String(room.elapsedSeconds % 60).padStart(2, '0')}</span></div></div>
    <div className="video-stage"><div className="ai-stage"><div className="ai-stage-avatar"><Sparkles size={48} /><span>AI</span></div><div className="speaking-label">{room.state === 'AI_SPEAKING' ? 'AI Interviewer is speaking' : room.state === 'PROCESSING' ? 'Analyzing your answer' : 'Listening for your answer'}</div></div><div className={`candidate-tile ${!room.cameraEnabled ? 'camera-off' : ''}`}>{room.cameraEnabled ? <video ref={videoRef} autoPlay muted playsInline /> : <VideoOff size={22} />}<small>You</small></div>{quality && <div className="camera-quality"><span className="status-dot" /> {quality.message}</div>}<div className="stage-caption"><span>{room.state === 'LISTENING' ? 'AI' : 'YOU'}</span>{room.state === 'LISTENING' ? room.question : room.answer || room.interim || 'Your live transcript will appear here.'}</div></div>
    {notice && <div className="room-notice">{notice}<button onClick={() => setNotice('')}><X size={14} /></button></div>}
    <div className="answer-bar"><div className="answer-status"><div className="mic-live">{room.micEnabled ? <Mic size={17} /> : <MicOff size={17} />}</div><span>{room.state === 'AI_SPEAKING' ? 'AI is speaking' : room.state === 'PROCESSING' ? 'Saving answer...' : 'Ready when you are'}</span></div><input value={room.answer} onChange={(event) => dispatch({ type: 'ANSWER', value: event.target.value })} placeholder="Type an answer or use your microphone..." onFocus={listen} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} /><button className="mic-button" onClick={listen}><Mic size={18} /></button><button className="send-answer" onClick={() => void submit()} disabled={room.state === 'PROCESSING'}><ArrowUpRight size={17} /></button></div>
    <div className="room-controls"><button onClick={() => dispatch({ type: 'TOGGLE_MIC' })}>{room.micEnabled ? <Mic size={17} /> : <MicOff size={17} />}</button><button onClick={() => dispatch({ type: 'TOGGLE_CAMERA' })}>{room.cameraEnabled ? <Video size={17} /> : <VideoOff size={17} />}</button><span>Question {Math.min(room.questionIndex + 1, analysis.questions.length)} / {analysis.questions.length}</span><button className="end-button" onClick={finish}>End interview</button></div>
  </div>
}

function Setup({ analysis, notice, onJoin }: { analysis: Analysis; notice: string; onJoin: () => void }) { return <div className="interview-page"><div className="interview-setup"><div className="setup-copy"><span className="eyebrow">AI HR INTERVIEW / {analysis.role.toUpperCase()}</span><h2>Your next conversation<br /><span>starts here.</span></h2><p>A realistic practice round shaped by your resume, target role, and gaps worth exploring.</p><div className="setup-checks"><div><Video size={17} /><span><b>Camera</b><small>Permission requested on join</small></span><Check size={15} /></div><div><Mic size={17} /><span><b>Microphone</b><small>Voice answers with typed fallback</small></span><Check size={15} /></div><div><Wifi size={17} /><span><b>Connection</b><small>Session recovery enabled</small></span><Check size={15} /></div></div>{notice && <div className="room-notice">{notice}</div>}<button className="primary-button" onClick={onJoin}>Join interview <ArrowUpRight size={16} /></button></div><div className="setup-preview"><div className="preview-glow" /><div className="preview-avatar"><Sparkles size={40} /><span>SKILLSYNC AI</span></div><div className="preview-label"><span className="status-dot" /> AI interviewer is ready</div></div></div><div className="interview-note"><span>{analysis.questions.length} personalized questions</span><span>·</span><span>Content-only feedback</span></div></div> }

function Completed({ analysis }: { analysis: Analysis }) { const strengths = analysis.skills.filter((skill) => skill.status === 'matched'); const gaps = analysis.skills.filter((skill) => skill.status !== 'matched'); return <div className="report-page"><div className="report-heading"><div><span className="eyebrow">INTERVIEW COMPLETE / PREPARATION REPORT</span><h2>Your next conversation is clearer.</h2><p>Feedback is based on answer content and its connection to the {analysis.role} requirements.</p></div><div className="complete-icon"><Check size={28} /></div></div><div className="report-summary"><div><span>ROLE</span><strong>{analysis.role}</strong></div><div><span>QUESTIONS</span><strong>{analysis.questions.length}</strong></div><div><span>CONTENT FOCUS</span><strong>Technical + role fit</strong></div></div><div className="report-columns"><section className="report-card"><span className="eyebrow">STRONG AREAS</span><h3>Keep these stories ready.</h3>{strengths.map((skill) => <div className="report-skill" key={skill.name}><Check size={14} /><span><strong>{skill.name}</strong><small>{skill.evidence}</small></span></div>)}</section><section className="report-card prepare-card"><span className="eyebrow">AREAS TO PREPARE</span><h3>Turn uncertainty into evidence.</h3>{gaps.map((skill) => <div className="report-skill" key={skill.name}><span className={`report-marker ${skill.status}`} /><span><strong>{skill.name}</strong><small>{skill.status === 'partial' ? 'Related experience exists; prepare a transition story.' : 'Not clearly demonstrated in the resume.'}</small></span></div>)}</section></div><div className="report-next"><Sparkles size={17} /><span><strong>Suggested next step:</strong> Practice explaining one project with context, decisions, trade-offs, and evidence.</span><button className="primary-button" onClick={() => window.location.reload()}><RotateCcw size={15} /> Practice again</button></div></div> }
