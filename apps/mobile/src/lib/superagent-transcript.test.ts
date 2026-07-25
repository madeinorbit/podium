import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { SuperagentMessage } from '../client/trpc'
import {
  dropEchoedTurns,
  legacyToTranscript,
  renderedTranscript,
  settledTranscript,
} from './superagent-transcript'

const legacyRow = (
  partial: Partial<SuperagentMessage> & Pick<SuperagentMessage, 'id' | 'role' | 'content'>,
): SuperagentMessage => ({ createdAt: '2026-07-26T00:00:00.000Z', ...partial })

const item = (
  partial: Partial<TranscriptItem> & Pick<TranscriptItem, 'id' | 'role' | 'text'>,
): TranscriptItem => partial as TranscriptItem

describe('legacyToTranscript', () => {
  it('maps roles and drops blank non-tool rows', () => {
    const out = legacyToTranscript([
      legacyRow({ id: 1, role: 'user', content: ' hello ' }),
      legacyRow({ id: 2, role: 'assistant', content: 'hi' }),
      legacyRow({ id: 3, role: 'system', content: 'note' }),
      legacyRow({ id: 4, role: 'assistant', content: '   ' }),
    ])
    expect(out.map((i) => [i.id, i.role, i.text])).toEqual([
      ['super:1', 'user', 'hello'],
      ['super:2', 'assistant', 'hi'],
      ['super:3', 'system', 'note'],
    ])
  })

  it('collapses a tool row to a quiet line, keeping only its first input line', () => {
    const [tool] = legacyToTranscript([
      legacyRow({ id: 7, role: 'tool', content: 'first\nsecond', toolName: 'Bash' }),
    ])
    expect(tool).toMatchObject({ role: 'tool', text: '', toolName: 'Bash', toolInput: 'first' })
  })

  it('drops a tool row carrying neither a name nor input', () => {
    expect(legacyToTranscript([legacyRow({ id: 8, role: 'tool', content: '  ' })])).toEqual([])
  })
})

describe('settledTranscript', () => {
  // The regression: the screen read ONLY the frozen legacy buffer, so a live
  // turn — which exists solely in the session transcript — was never rendered.
  it('carries the session transcript, not just the frozen legacy buffer', () => {
    const out = settledTranscript(
      [legacyRow({ id: 1, role: 'user', content: 'old question' })],
      [item({ id: 't1', role: 'user', text: 'new turn' })],
    )
    expect(out.map((i) => i.text)).toEqual(['old question', 'new turn'])
  })

  it('renders the transcript alone when the legacy buffer is empty (the live server case)', () => {
    const out = settledTranscript(
      [],
      [
        item({ id: 't1', role: 'user', text: 'do the thing' }),
        item({ id: 't2', role: 'assistant', text: 'done' }),
      ],
    )
    expect(out.map((i) => i.text)).toEqual(['do the thing', 'done'])
  })

  it('orders frozen legacy rows before the live transcript', () => {
    const out = settledTranscript(
      [legacyRow({ id: 1, role: 'assistant', content: 'legacy' })],
      [item({ id: 't1', role: 'assistant', text: 'live' })],
    )
    expect(out.map((i) => i.id)).toEqual(['super:1', 't1'])
  })
})

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
    expect(dropEchoedTurns(pending, [item({ id: 't1', role: 'user', text: 'ship it' })])).toEqual([])
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
