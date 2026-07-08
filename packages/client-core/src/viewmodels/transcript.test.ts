import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { mergeTranscriptItems, prependTranscriptItems, transcriptDisplayText } from './transcript'

function item(overrides: Partial<TranscriptItem> & { id: string }): TranscriptItem {
  return {
    role: 'assistant',
    text: '',
    ...overrides,
  }
}

describe('mobile transcript helpers', () => {
  it('merges live transcript deltas without duplicating cursors', () => {
    const merged = mergeTranscriptItems(
      [
        item({ id: 'a', cursor: 'c1', text: 'old' }),
        item({ id: 'b', cursor: 'c2', text: 'current' }),
      ],
      [
        item({ id: 'b2', cursor: 'c2', text: 'current duplicate' }),
        item({ id: 'c', cursor: 'c3', text: 'new' }),
      ],
    )

    expect(merged.map((entry) => entry.text)).toEqual(['old', 'current', 'new'])
  })

  it('prepends older pages without duplicating the overlap', () => {
    const prepended = prependTranscriptItems(
      [item({ id: 'b', cursor: 'c2', text: 'current' })],
      [
        item({ id: 'a', cursor: 'c1', text: 'older' }),
        item({ id: 'b', cursor: 'c2', text: 'dup' }),
      ],
    )
    expect(prepended.map((entry) => entry.text)).toEqual(['older', 'current'])
    // No fresh items → the same array back (no re-render churn).
    expect(prependTranscriptItems(prepended, [item({ id: 'a', cursor: 'c1', text: 'x' })])).toBe(
      prepended,
    )
  })

  it('renders tool transcript rows with the useful human-facing text', () => {
    expect(
      transcriptDisplayText(
        item({
          id: 'tool',
          role: 'tool',
          toolTitle: 'Run typecheck',
          toolInput: 'bun run typecheck',
          toolResult: 'passed',
        }),
      ),
    ).toBe('Run typecheck')
    expect(
      transcriptDisplayText(item({ id: 'result', role: 'tool', toolResult: 'all good' })),
    ).toBe('all good')
    expect(transcriptDisplayText(item({ id: 'empty', role: 'system' }))).toBe('Event')
  })
})
