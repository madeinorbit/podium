import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { dropEchoedTurns, markTurnsFailed, renderedTranscript } from './superagent-transcript'

const item = (
  partial: Partial<TranscriptItem> & Pick<TranscriptItem, 'id' | 'role' | 'text'>,
): TranscriptItem => partial as TranscriptItem

describe('renderedTranscript', () => {
  it('appends the in-progress text as a live assistant item while a turn runs', () => {
    const out = renderedTranscript([item({ id: 't1', role: 'user', text: 'q' })], ' partial ', true)
    expect(out.map((i) => [i.id, i.text])).toEqual([
      ['t1', 'q'],
      ['super:live', 'partial'],
    ])
  })

  it('adds nothing when the turn is idle or the live text is blank', () => {
    const settled = [item({ id: 't1', role: 'user', text: 'q' })]
    expect(renderedTranscript(settled, 'partial', false)).toHaveLength(1)
    expect(renderedTranscript(settled, '   ', true)).toHaveLength(1)
  })
})

describe('dropEchoedTurns', () => {
  // The other half of the bug: with nothing ever echoing the turn, the
  // optimistic row stayed on screen as "sending" forever.
  it('drops a pending turn once the transcript echoes it', () => {
    const pending = [{ id: 'p1', text: 'ship it' }]
    expect(dropEchoedTurns(pending, [item({ id: 't1', role: 'user', text: 'ship it' })])).toEqual(
      [],
    )
  })

  it('matches on trimmed text', () => {
    const pending = [{ id: 'p1', text: 'ship it' }]
    expect(dropEchoedTurns(pending, [item({ id: 't1', role: 'user', text: ' ship it ' })])).toEqual(
      [],
    )
  })

  it('keeps a turn the transcript has not echoed, and ignores assistant echoes', () => {
    const pending = [{ id: 'p1', text: 'ship it' }]
    expect(
      dropEchoedTurns(pending, [item({ id: 't1', role: 'assistant', text: 'ship it' })]),
    ).toEqual(pending)
  })

  it('returns the SAME array when nothing changed, so setState stays a no-op', () => {
    const pending = [{ id: 'p1', text: 'ship it' }]
    expect(dropEchoedTurns(pending, [])).toBe(pending)
    expect(dropEchoedTurns([], [item({ id: 't1', role: 'user', text: 'x' })])).toHaveLength(0)
  })

  it('drops only the echoed turn when several are in flight', () => {
    const pending = [
      { id: 'p1', text: 'first' },
      { id: 'p2', text: 'second' },
    ]
    expect(dropEchoedTurns(pending, [item({ id: 't1', role: 'user', text: 'first' })])).toEqual([
      { id: 'p2', text: 'second' },
    ])
  })
})

describe('markTurnsFailed', () => {
  // The route POD-346's rejection handling cannot reach: a turn that is
  // ACCEPTED and then dies resolves the mutation, so no catch marks its row,
  // and a dead turn writes no transcript for dropEchoedTurns to match. Without
  // this the row reads "sending…" for ever.
  it('marks a pending turn failed with the reason, keeping its words', () => {
    const pending = [{ id: 'p1', text: 'do the thing' }]
    expect(markTurnsFailed(pending, 'harness died')).toEqual([
      { id: 'p1', text: 'do the thing', failed: 'harness died' },
    ])
  })

  it('marks every unmarked turn — a dead turn owns everything still pending', () => {
    const pending: { id: string; text: string; failed?: string }[] = [
      { id: 'p1', text: 'first' },
      { id: 'p2', text: 'second' },
    ]
    expect(markTurnsFailed(pending, 'boom').map((t) => t.failed)).toEqual(['boom', 'boom'])
  })

  it('leaves an already-failed row on its ORIGINAL reason', () => {
    const pending = [
      { id: 'p1', text: 'rejected earlier', failed: 'a turn is already running' },
      { id: 'p2', text: 'died now' },
    ]
    expect(markTurnsFailed(pending, 'harness died').map((t) => t.failed)).toEqual([
      'a turn is already running',
      'harness died',
    ])
  })

  it('returns the SAME array when every row is already failed, so setState stays a no-op', () => {
    const pending = [{ id: 'p1', text: 'x', failed: 'earlier' }]
    expect(markTurnsFailed(pending, 'later')).toBe(pending)
  })

  it('is a no-op on an empty list', () => {
    const empty: { id: string; text: string; failed?: string }[] = []
    expect(markTurnsFailed(empty, 'boom')).toBe(empty)
  })
})
