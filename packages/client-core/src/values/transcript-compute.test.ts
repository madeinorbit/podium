import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { computeTranscript } from './transcript-compute'

const item = (
  overrides: Partial<TranscriptItem> & Pick<TranscriptItem, 'id' | 'role'>,
): TranscriptItem => ({
  text: '',
  ...overrides,
})

describe('computeTranscript', () => {
  it('returns one paired graph and search state for the loaded window', () => {
    const items = [
      item({ id: 'u1', role: 'user', text: 'Please inspect this' }),
      item({ id: 'a1', role: 'assistant', text: 'The NEEDLE is in the result' }),
    ]

    const result = computeTranscript({
      items,
      verbosity: 'normal',
      query: 'needle',
      cursor: 0,
    })

    expect(result.blocks.map((block) => block.item.id)).toEqual(['u1', 'a1'])
    expect(result.rows).toHaveLength(2)
    expect(result.search).toMatchObject({
      matches: [1],
      activeMatch: 1,
      activeRow: 1,
      position: 1,
      total: 1,
      filtering: true,
    })
  })

  it('applies summary filtering before the platform maps rows', () => {
    const result = computeTranscript({
      items: [
        item({ id: 'u1', role: 'user', text: 'Run it' }),
        item({
          id: 't1',
          role: 'tool',
          toolName: 'Bash',
          toolInput: 'bun test',
          toolResult: 'ok',
        }),
        item({ id: 'a1', role: 'assistant', text: 'Done', answer: true }),
      ],
      verbosity: 'summary',
      query: '',
      cursor: 0,
    })

    expect(
      result.rows.map((row) =>
        row.kind === 'block' ? row.block.item.id : (row.blocks[0]?.item.id ?? 'missing'),
      ),
    ).toEqual(['u1', 'a1'])
  })

  /**
   * FILE ORDER IS NOT TURN ORDER [POD-4639]. Claude Code writes the synthetic
   * "Not logged in" reply to its JSONL BEFORE the prompt that caused it (the
   * real bytes, from a signed-out launch: reply at 07:26:46.376, prompt stamped
   * 07:26:45.756 on the line after). Cursors must stay byte order, so the fix is
   * here, where rows are shaped: a prompt lifts above the replies stamped after it.
   */
  describe('a prompt written after its own reply', () => {
    const ids = (items: TranscriptItem[]) =>
      computeTranscript({ items, verbosity: 'normal', query: '', cursor: 0 }).blocks.map(
        (block) => block.item.id,
      )

    it('renders the prompt before the reply the harness flushed first', () => {
      expect(
        ids([
          item({ id: 'u0', role: 'user', ts: '2026-09-23T07:20:00.000Z', text: 'earlier' }),
          item({ id: 'a0', role: 'assistant', ts: '2026-09-23T07:20:05.000Z', text: 'ok' }),
          item({
            id: 'err',
            role: 'assistant',
            ts: '2026-09-23T07:26:46.376Z',
            text: 'Not logged in · Please run /login',
          }),
          item({
            id: 'u1',
            role: 'user',
            ts: '2026-09-23T07:26:45.756Z',
            text: 'What is 8 times 9?',
          }),
        ]),
      ).toEqual(['u0', 'a0', 'u1', 'err'])
    })

    it('keeps file order when the prompt is stamped after the reply above it', () => {
      expect(
        ids([
          item({ id: 'a0', role: 'assistant', ts: '2026-09-23T07:26:45.000Z', text: 'done' }),
          item({ id: 'u1', role: 'user', ts: '2026-09-23T07:26:46.000Z', text: 'next' }),
        ]),
      ).toEqual(['a0', 'u1'])
    })

    it('never lifts a prompt past an unstamped item', () => {
      expect(
        ids([
          item({ id: 'u0', role: 'user', ts: '2026-09-23T07:26:47.000Z', text: 'first' }),
          item({ id: 'x', role: 'assistant', text: 'no stamp' }),
          item({ id: 'u1', role: 'user', ts: '2026-09-23T07:26:45.000Z', text: 'second' }),
        ]),
      ).toEqual(['u0', 'x', 'u1'])
    })

    it('never lifts a prompt past another prompt, whatever their stamps say', () => {
      expect(
        ids([
          item({ id: 'u0', role: 'user', ts: '2026-09-23T07:26:47.000Z', text: 'first' }),
          item({ id: 'u1', role: 'user', ts: '2026-09-23T07:26:45.000Z', text: 'second' }),
        ]),
      ).toEqual(['u0', 'u1'])
    })
  })
})
