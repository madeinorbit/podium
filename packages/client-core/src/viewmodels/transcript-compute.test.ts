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
})
