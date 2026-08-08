import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  appendedTranscriptArrivals,
  buildMobileTranscript,
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

  it('keeps failures in summary while dropping quiet successful work', () => {
    const successful = buildMobileTranscript(
      [
        item('u1', 'user', 'Run it'),
        item('t1', 'tool', '', { toolName: 'Bash', toolInput: 'bun test', toolResult: 'ok' }),
        item('a1', 'assistant', 'Green.', { answer: true }),
      ],
      { verbosity: 'summary' },
    )
    expect(successful.rows.map((row) => row.kind)).toEqual(['user', 'answer'])

    const failed = buildMobileTranscript(
      [
        item('t1', 'tool', '', {
          toolName: 'Bash',
          toolInput: 'bun test',
          toolResult: 'Error: red',
        }),
      ],
      { verbosity: 'summary' },
    )
    expect(failed.rows.map((row) => row.kind)).toEqual(['tools'])
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

  it('temporarily restores normal detail while searching from summary', () => {
    const model = buildMobileTranscript(
      [item('t1', 'tool', '', { toolName: 'Read', toolInput: 'Needle.tsx', toolResult: 'ok' })],
      { verbosity: 'summary', searching: true },
    )
    expect(model.rows).toHaveLength(1)
  })

  it('quotes every source line for composer insertion', () => {
    expect(quoteTranscriptText('one\ntwo')).toBe('> one\n> two\n\n')
  })

  it('animates only genuine tail arrivals, never initial or prepended history', () => {
    expect([...appendedTranscriptArrivals([], new Set(), ['a', 'b'])]).toEqual([])
    expect([...appendedTranscriptArrivals(['a', 'b'], new Set(['a', 'b']), ['a', 'b', 'c'])]).toEqual([
      'c',
    ])
    expect(
      [...appendedTranscriptArrivals(['a', 'b'], new Set(['a', 'b']), ['older', 'a', 'b'])],
    ).toEqual([])
  })
})
