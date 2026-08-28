import { describe, expect, it } from 'vitest'
import { applySpeechResult, emptyVoiceTranscript } from './voice-transcript'

describe('SpeechTranscriber range reduction', () => {
  it('replaces volatile text for the same audio range', () => {
    const rough = applySpeechResult(emptyVoiceTranscript(), {
      text: 'send teh report',
      startTime: 0,
      endTime: 1.2,
      isFinal: false,
      finalizationTime: 0,
    })
    const corrected = applySpeechResult(rough, {
      text: 'send the report',
      startTime: 0,
      endTime: 1.2,
      isFinal: false,
      finalizationTime: 0,
    })

    expect(corrected.text).toBe('send the report')
    expect(corrected.finalText).toBe('')
    expect(corrected.volatileText).toBe('send the report')
  })

  it('removes a volatile range when Apple revokes it with empty text', () => {
    const rough = applySpeechResult(emptyVoiceTranscript(), {
      text: 'background noise',
      startTime: 2,
      endTime: 2.8,
      isFinal: false,
      finalizationTime: 0,
    })
    const revoked = applySpeechResult(rough, {
      text: '',
      startTime: 2,
      endTime: 2.8,
      isFinal: false,
      finalizationTime: 0,
    })

    expect(revoked.segments).toEqual([])
    expect(revoked.text).toBe('')
  })

  it('promotes prior ranges using resultsFinalizationTime', () => {
    const first = applySpeechResult(emptyVoiceTranscript(), {
      text: 'open settings',
      startTime: 0,
      endTime: 1,
      isFinal: false,
      finalizationTime: 0,
    })
    const next = applySpeechResult(first, {
      text: 'and check logs',
      startTime: 1,
      endTime: 2,
      isFinal: false,
      finalizationTime: 1.1,
    })

    expect(next.finalText).toBe('open settings')
    expect(next.volatileText).toBe('and check logs')
    expect(next.newlyFinalizedText).toBe('open settings')
  })

  it('reports a directly final result once', () => {
    const finalized = applySpeechResult(emptyVoiceTranscript(), {
      text: 'ship it',
      startTime: 0,
      endTime: 0.8,
      isFinal: true,
      finalizationTime: 0.8,
    })
    const later = applySpeechResult(finalized, {
      text: 'tomorrow',
      startTime: 0.8,
      endTime: 1.4,
      isFinal: false,
      finalizationTime: 0.8,
    })

    expect(finalized.newlyFinalizedText).toBe('ship it')
    expect(later.newlyFinalizedText).toBe('')
  })
})
