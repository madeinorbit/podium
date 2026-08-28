import type { VoiceInput } from './voice-input-contract'

const ignore = () => {}

const UNSUPPORTED: VoiceInput = {
  supported: false,
  starting: false,
  listening: false,
  error: null,
  session: null,
  statusMessage: undefined,
  progress: undefined,
  start: ignore,
  stop: ignore,
  clear: ignore,
}

/** Safe fallback for Android and native targets without a platform adapter. */
export function useVoiceInput(): VoiceInput {
  return UNSUPPORTED
}
