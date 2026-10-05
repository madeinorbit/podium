import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { liveTranscriptItem } from './superagent-transcript'

const item = (
  partial: Partial<TranscriptItem> & Pick<TranscriptItem, 'id' | 'role' | 'text'>,
): TranscriptItem => partial as TranscriptItem

describe('liveTranscriptItem', () => {
  it('returns trimmed in-progress text as a live assistant item while a turn runs', () => {
    expect(liveTranscriptItem(' partial ', true)).toEqual({
      id: 'super:live',
      role: 'assistant',
      text: 'partial',
    })
  })

  it('returns nothing when the turn is idle or the live text is blank', () => {
    expect(liveTranscriptItem('partial', false)).toBeUndefined()
    expect(liveTranscriptItem('   ', true)).toBeUndefined()
  })
})
