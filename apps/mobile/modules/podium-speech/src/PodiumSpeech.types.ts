export type PodiumSpeechAvailabilityStatus =
  | 'ready'
  | 'model_download_required'
  | 'model_downloading'
  | 'model_capacity_unavailable'
  | 'microphone_denied'
  | 'unsupported_os'
  | 'unsupported_device'
  | 'unsupported_locale'
  | 'unavailable'

export type PodiumSpeechModelStatus =
  | 'installed'
  | 'download_required'
  | 'downloading'
  | 'capacity_unavailable'
  | 'unavailable'

export type PodiumSpeechMicrophonePermission =
  | 'granted'
  | 'denied'
  | 'undetermined'
  | 'unknown'

export interface PodiumSpeechAvailability {
  status: PodiumSpeechAvailabilityStatus
  supported: boolean
  requestedLocaleIdentifier: string
  localeIdentifier: string | null
  modelStatus: PodiumSpeechModelStatus
  microphonePermission: PodiumSpeechMicrophonePermission
  progress: number | null
  message: string
}

export interface PodiumSpeechAvailabilityEvent extends PodiumSpeechAvailability {
  generation: number
}

export interface PodiumSpeechErrorEvent {
  generation: number
  code: string
  message: string
  recoverable: boolean
}

export type PodiumSpeechPhase = 'idle' | 'preparing' | 'downloading' | 'listening' | 'stopping'

export interface PodiumSpeechPhaseEvent {
  generation: number
  phase: PodiumSpeechPhase
  progress: number | null
}

/**
 * A replacement for one audio range, not a phrase to append. Apple can revoke
 * volatile text with an empty value and can finalize older ranges without
 * publishing those ranges again.
 */
export interface PodiumSpeechResultEvent {
  generation: number
  text: string
  startTime: number
  endTime: number
  isFinal: boolean
  finalizationTime: number
}

export type PodiumSpeechModuleEvents = {
  onAvailabilityChanged: (event: PodiumSpeechAvailabilityEvent) => void
  onError: (event: PodiumSpeechErrorEvent) => void
  onPhaseChanged: (event: PodiumSpeechPhaseEvent) => void
  onResult: (event: PodiumSpeechResultEvent) => void
}
