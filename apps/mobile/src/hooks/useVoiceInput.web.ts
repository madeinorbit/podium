import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceInput, VoiceInputError, VoiceInputSession } from './voice-input-contract'

export type { VoiceInput, VoiceInputError, VoiceInputSession } from './voice-input-contract'

interface SpeechRecognitionAlternativeLike {
  transcript: string
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean
  readonly length: number
  readonly [index: number]: SpeechRecognitionAlternativeLike
}

interface SpeechRecognitionResultEventLike {
  readonly resultIndex: number
  readonly results: {
    readonly length: number
    readonly [index: number]: SpeechRecognitionResultLike
  }
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: (() => void) | null
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  start(): void
  stop(): void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

interface RecognizedPart {
  text: string
  final: boolean
}

interface ActiveSession {
  id: number
  revision: number
  recognition: SpeechRecognitionLike
  results: Map<number, RecognizedPart>
}

interface VoiceInputState {
  starting: boolean
  listening: boolean
  error: VoiceInputError | null
  session: VoiceInputSession | null
}

const IDLE: VoiceInputState = {
  starting: false,
  listening: false,
  error: null,
  session: null,
}

function recognitionConstructor(): SpeechRecognitionConstructor | undefined {
  const browser = globalThis as typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition
}

function errorForRecognition(code: string): VoiceInputError {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return {
        code: 'permission-denied',
        message: 'Microphone access is blocked. Allow it in your browser settings and try again.',
      }
    case 'no-speech':
      return { code: 'no-speech', message: 'No speech was detected. Try again.' }
    case 'audio-capture':
      return {
        code: 'no-microphone',
        message: 'No microphone is available. Check your device and try again.',
      }
    case 'network':
      return { code: 'network', message: 'Dictation lost its connection. Try again.' }
    case 'language-not-supported':
      return {
        code: 'unsupported-language',
        message: 'Dictation does not support your browser language.',
      }
    case 'aborted':
      return { code: 'aborted', message: 'Dictation stopped before it finished. Try again.' }
    default:
      return { code: 'unknown', message: 'Dictation failed. Try again.' }
  }
}

function errorForException(error: unknown, action: 'start' | 'stop'): VoiceInputError {
  const name =
    typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string'
      ? error.name
      : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return errorForRecognition('not-allowed')
  }
  return {
    code: action === 'start' ? 'start-failed' : 'stop-failed',
    message:
      action === 'start' ? 'Dictation could not start. Try again.' : 'Dictation could not stop.',
  }
}

function disconnect(recognition: SpeechRecognitionLike) {
  recognition.onstart = null
  recognition.onresult = null
  recognition.onend = null
  recognition.onerror = null
}

function sessionSnapshot(session: ActiveSession, includeInterim: boolean): VoiceInputSession {
  const final: string[] = []
  const interim: string[] = []
  const ordered = [...session.results.entries()].sort(([left], [right]) => left - right)
  for (const [, part] of ordered) {
    if (!part.text) continue
    if (part.final) final.push(part.text)
    else if (includeInterim) interim.push(part.text)
  }
  return {
    id: session.id,
    revision: session.revision,
    finalText: final.join(' '),
    interimText: interim.join(' '),
  }
}

function finalSnapshot(session: ActiveSession): VoiceInputSession | null {
  const withInterim = sessionSnapshot(session, true)
  if (withInterim.interimText) session.revision += 1
  const final = sessionSnapshot(session, false)
  return final.finalText ? final : null
}

/**
 * Browser dictation through the Web Speech API.
 *
 * Web Speech reports a session snapshot indexed from `resultIndex`; it does not
 * promise an append-only event stream. Final indexes are locked here and every
 * state update rebuilds the session text by index, so a replay cannot duplicate
 * text in Composer.
 */
export function useVoiceInput(): VoiceInput {
  const [state, setState] = useState<VoiceInputState>(IDLE)
  const activeRef = useRef<ActiveSession | null>(null)
  const nextSessionId = useRef(0)

  const finish = useCallback(
    (session: ActiveSession, error: VoiceInputError | null, requestStop: boolean) => {
      if (activeRef.current !== session) return

      // Identity changes before any browser call. Captured callbacks from this
      // recognizer are stale even if stop throws or onend never arrives.
      activeRef.current = null
      disconnect(session.recognition)
      const snapshot = finalSnapshot(session)
      let stopError: VoiceInputError | null = null
      if (requestStop) {
        try {
          session.recognition.stop()
        } catch (caught) {
          stopError = errorForException(caught, 'stop')
        }
      }
      setState({
        starting: false,
        listening: false,
        error: error ?? stopError,
        session: snapshot,
      })
    },
    [],
  )

  const clear = useCallback(() => {
    const session = activeRef.current
    if (session) {
      activeRef.current = null
      disconnect(session.recognition)
      try {
        session.recognition.stop()
      } catch {
        // Clear is used for send and draft replacement. Nothing from the old
        // session, including a stop failure, may repopulate the new draft.
      }
    }
    setState(IDLE)
  }, [])

  const stop = useCallback(() => {
    const session = activeRef.current
    if (session) finish(session, null, true)
    else {
      setState((current) => ({
        ...current,
        starting: false,
        listening: false,
        session: current.session?.finalText ? { ...current.session, interimText: '' } : null,
      }))
    }
  }, [finish])

  const start = useCallback(() => {
    if (activeRef.current) return
    const Recognition = recognitionConstructor()
    if (!Recognition) return

    let recognition: SpeechRecognitionLike
    try {
      recognition = new Recognition()
    } catch (error) {
      setState({
        starting: false,
        listening: false,
        error: errorForException(error, 'start'),
        session: null,
      })
      return
    }

    const session: ActiveSession = {
      id: (nextSessionId.current += 1),
      revision: 0,
      recognition,
      results: new Map(),
    }

    try {
      recognition.lang = globalThis.navigator?.language || 'en-US'
      recognition.continuous = true
      recognition.interimResults = true
      recognition.onstart = () => {
        if (activeRef.current !== session) return
        setState((current) => ({ ...current, starting: false, listening: true, error: null }))
      }
      recognition.onresult = (event) => {
        if (activeRef.current !== session) return
        let changed = false
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const previous = session.results.get(index)
          if (previous?.final) continue
          const result = event.results[index]
          if (!result) continue
          const next = { text: result[0]?.transcript.trim() ?? '', final: result.isFinal }
          if (previous?.text === next.text && previous.final === next.final) continue
          session.results.set(index, next)
          changed = true
        }
        if (!changed || activeRef.current !== session) return
        session.revision += 1
        setState((current) => ({
          ...current,
          session: sessionSnapshot(session, true),
        }))
      }
      recognition.onend = () => finish(session, null, false)
      recognition.onerror = (event) => finish(session, errorForRecognition(event.error), false)

      activeRef.current = session
      setState({
        starting: true,
        listening: false,
        error: null,
        session: sessionSnapshot(session, true),
      })
      recognition.start()
    } catch (error) {
      if (activeRef.current === session) {
        activeRef.current = null
        disconnect(recognition)
        setState({
          starting: false,
          listening: false,
          error: errorForException(error, 'start'),
          session: null,
        })
      }
    }
  }, [finish])

  useEffect(() => {
    return () => {
      const session = activeRef.current
      if (!session) return
      activeRef.current = null
      disconnect(session.recognition)
      try {
        session.recognition.stop()
      } catch {
        // Unmount has no remaining UI to report the stop failure to.
      }
    }
  }, [])

  return {
    supported: recognitionConstructor() !== undefined,
    starting: state.starting,
    listening: state.listening,
    error: state.error,
    session: state.session,
    statusMessage: state.starting
      ? 'Starting dictation…'
      : state.listening
        ? 'Listening…'
        : undefined,
    progress: undefined,
    start,
    stop,
    clear,
  }
}
