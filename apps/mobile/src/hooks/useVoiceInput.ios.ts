import { useCallback, useEffect, useRef, useState } from 'react'

import PodiumSpeech, {
  type PodiumSpeechAvailability,
  type PodiumSpeechAvailabilityEvent,
  type PodiumSpeechErrorEvent,
  type PodiumSpeechPhaseEvent,
  type PodiumSpeechResultEvent,
} from '../../modules/podium-speech'
import type { VoiceInput, VoiceInputError, VoiceInputSession } from './voice-input-contract'
import {
  applySpeechResult,
  emptyVoiceTranscript,
  type VoiceTranscriptState,
} from './voice-transcript'

export type { VoiceInput, VoiceInputError, VoiceInputSession } from './voice-input-contract'

interface ActiveSession {
  id: number
  revision: number
  generation: number
  transcript: VoiceTranscriptState
}

interface VoiceInputState {
  supported: boolean
  starting: boolean
  listening: boolean
  error: VoiceInputError | null
  session: VoiceInputSession | null
  statusMessage: string | undefined
  progress: number | undefined
}

const DEVELOPMENT_BUILD_MESSAGE =
  'Private dictation requires an iOS development build and is not available in Expo Go.'
let nextNativeGeneration = 0

function sessionSnapshot(session: ActiveSession, includeInterim: boolean): VoiceInputSession {
  return {
    id: session.id,
    revision: session.revision,
    finalText: session.transcript.finalText,
    interimText: includeInterim ? session.transcript.volatileText : '',
  }
}

function finalSnapshot(session: ActiveSession): VoiceInputSession | null {
  if (!session.transcript.finalText) return null
  if (session.transcript.volatileText) session.revision += 1
  return sessionSnapshot(session, false)
}

function voiceError(error: unknown, fallback: VoiceInputError): VoiceInputError {
  if (typeof error !== 'object' || error === null) return fallback
  const candidate = error as { code?: unknown; message?: unknown }
  return {
    code: typeof candidate.code === 'string' ? candidate.code : fallback.code,
    message: typeof candidate.message === 'string' ? candidate.message : fallback.message,
  }
}

function normalizedProgress(progress: number | null): number | undefined {
  return progress === null || !Number.isFinite(progress)
    ? undefined
    : Math.min(1, Math.max(0, progress))
}

function stateFromAvailability(
  current: VoiceInputState,
  availability: PodiumSpeechAvailability,
): VoiceInputState {
  return {
    ...current,
    supported: availability.supported,
    statusMessage: availability.message,
    progress: normalizedProgress(availability.progress),
  }
}

/**
 * Private iOS 26 dictation backed by the local PodiumSpeech Expo module.
 *
 * The module is intentionally optional: older iOS versions and Expo Go keep the
 * composer usable and report why dictation is unavailable. Native callbacks are
 * tagged with this hook's generation and ignored after stop, clear, or a restart.
 */
export function useVoiceInput(): VoiceInput {
  const [state, setState] = useState<VoiceInputState>({
    supported: PodiumSpeech !== null,
    starting: false,
    listening: false,
    error: null,
    session: null,
    statusMessage: PodiumSpeech ? 'Checking private dictation availability…' : DEVELOPMENT_BUILD_MESSAGE,
    progress: undefined,
  })
  const activeRef = useRef<ActiveSession | null>(null)
  const nextSessionId = useRef(0)
  const actionRevision = useRef(0)
  const teardownRef = useRef<Promise<void> | null>(null)

  useEffect(() => {
    const speech = PodiumSpeech
    if (!speech) return
    let mounted = true

    const matchesActiveGeneration = (generation: number): ActiveSession | null => {
      const active = activeRef.current
      return active?.generation === generation ? active : null
    }

    const availabilitySubscription = speech.addListener(
      'onAvailabilityChanged',
      (availability: PodiumSpeechAvailabilityEvent) => {
        if (!matchesActiveGeneration(availability.generation)) return
        setState((current) => stateFromAvailability(current, availability))
      },
    )
    const phaseSubscription = speech.addListener(
      'onPhaseChanged',
      (event: PodiumSpeechPhaseEvent) => {
        const active = matchesActiveGeneration(event.generation)
        if (!active) return

        if (event.phase === 'idle') {
          activeRef.current = null
          setState((current) => ({
            ...current,
            starting: false,
            listening: false,
            session: finalSnapshot(active),
            progress: undefined,
          }))
          return
        }

        setState((current) => ({
          ...current,
          starting: event.phase === 'preparing' || event.phase === 'downloading',
          listening: event.phase === 'listening',
          statusMessage:
            event.phase === 'downloading'
              ? 'Downloading Apple’s private dictation model…'
              : event.phase === 'preparing'
                ? 'Preparing private dictation…'
                : event.phase === 'listening'
                  ? 'Listening with private on-device dictation.'
                  : current.statusMessage,
          progress: normalizedProgress(event.progress),
        }))
      },
    )
    const resultSubscription = speech.addListener(
      'onResult',
      (event: PodiumSpeechResultEvent) => {
        const active = matchesActiveGeneration(event.generation)
        if (!active) return
        const transcript = applySpeechResult(active.transcript, event)
        if (transcript === active.transcript) return
        active.transcript = transcript
        active.revision += 1
        setState((current) => ({
          ...current,
          session: sessionSnapshot(active, true),
        }))
      },
    )
    const errorSubscription = speech.addListener(
      'onError',
      (event: PodiumSpeechErrorEvent) => {
        const active = matchesActiveGeneration(event.generation)
        if (!active) return
        activeRef.current = null
        setState((current) => ({
          ...current,
          starting: false,
          listening: false,
          error: { code: event.code, message: event.message },
          session: finalSnapshot(active),
          statusMessage: event.message,
          progress: undefined,
        }))
      },
    )

    void speech.getAvailability().then(
      (availability: PodiumSpeechAvailability) => {
        if (!mounted) return
        setState((current) =>
          activeRef.current
            ? { ...current, supported: availability.supported }
            : stateFromAvailability(current, availability),
        )
      },
      () => {
        if (!mounted) return
        setState((current) => ({
          ...current,
          supported: false,
          statusMessage: 'Private dictation availability could not be checked.',
        }))
      },
    )

    return () => {
      mounted = false
      actionRevision.current += 1
      const active = activeRef.current
      activeRef.current = null
      availabilitySubscription.remove()
      phaseSubscription.remove()
      resultSubscription.remove()
      errorSubscription.remove()
      if (active) void speech.cancel(active.generation)
    }
  }, [])

  const start = useCallback(() => {
    if (!PodiumSpeech || activeRef.current || teardownRef.current) return

    const generation = (nextNativeGeneration += 1)
    const session: ActiveSession = {
      id: (nextSessionId.current += 1),
      revision: 0,
      generation,
      transcript: emptyVoiceTranscript(),
    }
    activeRef.current = session
    const revision = (actionRevision.current += 1)
    setState((current) => ({
      ...current,
      starting: true,
      listening: false,
      error: null,
      session: sessionSnapshot(session, true),
      statusMessage: 'Preparing private dictation…',
      progress: undefined,
    }))

    void PodiumSpeech.start(undefined, generation).then(
      (availability: PodiumSpeechAvailability) => {
        if (actionRevision.current !== revision || activeRef.current !== session) return
        setState((current) => stateFromAvailability(current, availability))
      },
      (error: unknown) => {
        if (actionRevision.current !== revision || activeRef.current !== session) return
        activeRef.current = null
        const failure = voiceError(error, {
          code: 'start_failed',
          message: 'Private dictation could not start. Try again.',
        })
        setState((current) => ({
          ...current,
          starting: false,
          listening: false,
          error: failure,
          session: finalSnapshot(session),
          statusMessage: failure.message,
          progress: undefined,
        }))
      },
    )
  }, [])

  const stop = useCallback(() => {
    const session = activeRef.current
    // Stop is intentionally a synchronous UI boundary. Native capture still
    // drains and finalizes for clean analyzer teardown, but any later result is
    // generation-filtered so it cannot leak into this or the next prompt.
    activeRef.current = null
    const revision = (actionRevision.current += 1)
    setState((current) => ({
      ...current,
      starting: false,
      listening: false,
      session: session ? finalSnapshot(session) : current.session,
      progress: undefined,
    }))
    if (!PodiumSpeech || !session) return
    const teardown = PodiumSpeech.stop(session.generation)
    teardownRef.current = teardown
    void teardown.then(
      () => {
        if (teardownRef.current === teardown) teardownRef.current = null
      },
      (error: unknown) => {
        if (teardownRef.current === teardown) teardownRef.current = null
        if (actionRevision.current !== revision) return
        const failure = voiceError(error, {
          code: 'stop_failed',
          message: 'Private dictation could not stop cleanly.',
        })
        setState((current) => ({ ...current, error: failure, statusMessage: failure.message }))
      },
    )
  }, [])

  const clear = useCallback(() => {
    const session = activeRef.current
    activeRef.current = null
    actionRevision.current += 1
    setState((current) => ({
      ...current,
      starting: false,
      listening: false,
      error: null,
      session: null,
      progress: undefined,
    }))
    if (PodiumSpeech && session) {
      const teardown = PodiumSpeech.cancel(session.generation)
      teardownRef.current = teardown
      void teardown.then(
        () => {
          if (teardownRef.current === teardown) teardownRef.current = null
        },
        () => {
          if (teardownRef.current === teardown) teardownRef.current = null
        },
      )
    }
  }, [])

  return {
    supported: state.supported,
    starting: state.starting,
    listening: state.listening,
    error: state.error,
    session: state.session,
    statusMessage: state.statusMessage,
    progress: state.progress,
    start,
    stop,
    clear,
  }
}
