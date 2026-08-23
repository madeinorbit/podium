export interface VoiceInputError {
  code: string
  message: string
}

/** One recognizer session, rebuilt from the recognizer's indexed result list. */
export interface VoiceInputSession {
  id: number
  revision: number
  finalText: string
  interimText: string
}

export interface VoiceInput {
  supported: boolean
  starting: boolean
  listening: boolean
  error: VoiceInputError | null
  session: VoiceInputSession | null
  /** Platform-specific preparation or capture detail for the visible status line. */
  statusMessage?: string
  /** Platform-specific preparation progress, from zero through one. */
  progress?: number
  start: () => void
  /** Ends capture now, keeps final text, and discards interim text. */
  stop: () => void
  /** Ends capture now and discards the entire recognition session. */
  clear: () => void
}
