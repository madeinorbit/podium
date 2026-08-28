import type { PodiumSpeechResultEvent } from '../../modules/podium-speech'

type SpeechResultPayload = Omit<PodiumSpeechResultEvent, 'generation'>

export interface VoiceTranscriptSegment {
  text: string
  startTime: number
  endTime: number
  final: boolean
}

export interface VoiceTranscriptState {
  segments: readonly VoiceTranscriptSegment[]
  text: string
  finalText: string
  volatileText: string
  newlyFinalizedText: string
  finalizationTime: number
}

const EMPTY_TRANSCRIPT: VoiceTranscriptState = {
  segments: [],
  text: '',
  finalText: '',
  volatileText: '',
  newlyFinalizedText: '',
  finalizationTime: 0,
}

export function emptyVoiceTranscript(): VoiceTranscriptState {
  return EMPTY_TRANSCRIPT
}

function segmentKey(segment: Pick<VoiceTranscriptSegment, 'startTime' | 'endTime'>): string {
  return `${segment.startTime}:${segment.endTime}`
}

function overlaps(
  segment: Pick<VoiceTranscriptSegment, 'startTime' | 'endTime'>,
  result: Pick<SpeechResultPayload, 'startTime' | 'endTime'>,
): boolean {
  if (segment.startTime === segment.endTime || result.startTime === result.endTime) {
    return segment.startTime === result.startTime
  }
  return segment.startTime < result.endTime && result.startTime < segment.endTime
}

function joined(segments: readonly VoiceTranscriptSegment[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(' ')
}

/**
 * SpeechTranscriber results replace an audio range. They are not append-only:
 * an empty volatile result revokes the old text, and resultsFinalizationTime can
 * commit older ranges without publishing those ranges again.
 */
export function applySpeechResult(
  previous: VoiceTranscriptState,
  result: SpeechResultPayload,
): VoiceTranscriptState {
  if (
    !Number.isFinite(result.startTime) ||
    !Number.isFinite(result.endTime) ||
    !Number.isFinite(result.finalizationTime) ||
    result.endTime < result.startTime
  ) {
    return previous
  }

  const previouslyFinal = new Set(
    previous.segments.filter((segment) => segment.final).map(segmentKey),
  )
  const segments = previous.segments.filter((segment) => !overlaps(segment, result)).slice()
  if (result.text.trim()) {
    segments.push({
      text: result.text,
      startTime: result.startTime,
      endTime: result.endTime,
      final: result.isFinal || result.endTime <= result.finalizationTime,
    })
  }

  const finalizedThrough = Math.max(previous.finalizationTime, result.finalizationTime)
  const ordered = segments
    .map((segment) =>
      segment.final || segment.endTime > finalizedThrough ? segment : { ...segment, final: true },
    )
    .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime)
  const finalSegments = ordered.filter((segment) => segment.final)
  const volatileSegments = ordered.filter((segment) => !segment.final)
  const newlyFinalized = finalSegments.filter((segment) => !previouslyFinal.has(segmentKey(segment)))

  return {
    segments: ordered,
    text: joined(ordered),
    finalText: joined(finalSegments),
    volatileText: joined(volatileSegments),
    newlyFinalizedText: joined(newlyFinalized),
    finalizationTime: finalizedThrough,
  }
}
