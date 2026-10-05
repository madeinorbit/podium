import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  appendedTranscriptArrivals,
  buildMobileTranscript,
  matchMobileTranscript,
  positionMobileTranscriptSearch,
  quoteTranscriptText,
  searchMobileTranscript,
} from './transcript-feed'

const item = (
  id: string,
  role: TranscriptItem['role'],
  text: string,
  extra: Partial<TranscriptItem> = {},
): TranscriptItem => ({ id, role, text, ...extra })

describe('mobile transcript feed', () => {
  // POD-4868: auto-continue and an automation's prompt arrive in the short
  // frame, and the phone shows them as Podium's, never as the person's turn.
  it("shows auto-continue's short frame as an envelope, not as the person's turn", () => {
    const model = buildMobileTranscript([
      item(
        'u1',
        'user',
        '[podium message msg_c · from system:auto-continue · to your session]\ncontinue\n[end podium message msg_c]',
      ),
    ])

    expect(model.rows.map((row) => row.kind)).toEqual(['envelope'])
    expect(model.rows[0]?.envelope).toMatchObject({
      id: 'msg_c',
      from: 'system:auto-continue',
      body: 'continue',
    })
  })

  it('spends space at turn boundaries and binds work inside the exchange', () => {
    const model = buildMobileTranscript([
      item('u1', 'user', 'Please update the screen'),
      item('a1', 'assistant', 'I will inspect it.'),
      item('t1', 'tool', '', { toolName: 'Read', toolInput: 'Screen.tsx', toolResult: 'ok' }),
      item('t2', 'tool', '', { toolName: 'Edit', toolInput: 'Screen.tsx', toolResult: 'ok' }),
      item('a2', 'assistant', 'Done.', { answer: true }),
    ])

    expect(model.rows.map((row) => [row.kind, row.turn])).toEqual([
      ['user', 'open'],
      ['prose', 'beat'],
      ['tools', 'bind'],
      ['answer', 'beat'],
    ])
    expect(model.rows[2]?.blocks).toHaveLength(2)
  })

  it('finds text inside a folded result and maps it back to the work row', () => {
    const model = buildMobileTranscript([
      item('t1', 'tool', '', {
        toolName: 'Bash',
        toolInput: 'bun test',
        toolResult: 'The hidden NEEDLE is in this result',
      }),
      item('a1', 'assistant', 'All done.', { answer: true }),
    ])
    const search = searchMobileTranscript(model, 'needle', 0)

    expect(search.total).toBe(1)
    expect(search.activeRow).toBe(0)
    expect([...search.matchingRows]).toEqual([0])
  })

  it('maps every envelope row sharing a match and selects its first row when wrapping', () => {
    const model = buildMobileTranscript([
      item(
        'batch',
        'user',
        '[podium message msg_a · from system:auto-continue · to your session]\nneedle\n[end podium message msg_a]\n[podium message msg_b · from system:auto-continue · to your session]\nalso needle\n[end podium message msg_b]',
      ),
      item('answer', 'assistant', 'Another needle', { answer: true }),
    ])
    const answer = matchMobileTranscript(model, 'needle')
    expect(answer.matches).toEqual([0, 1])
    expect([...answer.matchingRows]).toEqual([0, 1, 2])
    expect(positionMobileTranscriptSearch(answer, 0)).toMatchObject({
      activeRow: 0,
      position: 1,
      total: 2,
    })
    expect(positionMobileTranscriptSearch(answer, -1)).toMatchObject({ activeRow: 2, position: 2 })
    expect(positionMobileTranscriptSearch(answer, 2)).toMatchObject({ activeRow: 0, position: 1 })
    const noRows = matchMobileTranscript({ ...model, rows: [] }, 'needle')
    expect(positionMobileTranscriptSearch(noRows, 0)).toMatchObject({
      activeRow: undefined,
      position: 1,
      total: 2,
    })
  })

  it('makes an empty or unmatched answer selectable without transcript demand', () => {
    const model = buildMobileTranscript([item('answer', 'assistant', 'No matches here')])
    expect(searchMobileTranscript(model, 'missing', 100)).toMatchObject({
      activeRow: undefined,
      position: 0,
      total: 0,
    })
    const closed = matchMobileTranscript(model, '   ')
    expect(closed.matches).toEqual([])
    expect(positionMobileTranscriptSearch(closed, -100)).toMatchObject({
      activeRow: undefined,
      position: 0,
      total: 0,
    })
  })

  it('quotes every source line for composer insertion', () => {
    expect(quoteTranscriptText('one\ntwo')).toBe('> one\n> two\n\n')
  })

  it('animates only genuine tail arrivals, never initial or prepended history', () => {
    expect([...appendedTranscriptArrivals([], new Set(), ['a', 'b'])]).toEqual([])
    expect([
      ...appendedTranscriptArrivals(['a', 'b'], new Set(['a', 'b']), ['a', 'b', 'c']),
    ]).toEqual(['c'])
    expect([
      ...appendedTranscriptArrivals(['a', 'b'], new Set(['a', 'b']), ['older', 'a', 'b']),
    ]).toEqual([])
  })
})
