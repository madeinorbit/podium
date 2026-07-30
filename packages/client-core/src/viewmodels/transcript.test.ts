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

/** A real Podium cursor: base64url `[fileId, offset, uuid, sub]`, the encoding
 *  packages/transcript/src/cursor-codec.ts stamps every item with. */
function cursor(fileId: string, offset: number, sub = 0): string {
  return Buffer.from(JSON.stringify([fileId, offset, null, sub]), 'utf8').toString('base64url')
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

  // POD-343 (the mobile half of POD-341): a delta frame is not always newer. The
  // server replays its whole per-session transcript cache to a resubscribing
  // client whose `since` cursor it can't find — routine on a phone, whose socket
  // drops constantly — so a frame can carry items that belong above the held
  // tail. Appending them showed a reply above the message that produced it.
  it('places a replayed OLDER item at its cursor position, not on the end', () => {
    const merged = mergeTranscriptItems(
      [item({ id: 'answer', cursor: cursor('f1', 900), text: 'answer' })],
      [
        item({ id: 'prompt', cursor: cursor('f1', 100), text: 'prompt' }),
        item({ id: 'tool', cursor: cursor('f1', 400), text: 'tool' }),
      ],
    )
    expect(merged.map((entry) => entry.text)).toEqual(['prompt', 'tool', 'answer'])
  })

  it('still appends across a file roll (a new file is newer, whatever its offsets)', () => {
    const merged = mergeTranscriptItems(
      [item({ id: 'old', cursor: cursor('f1', 9000), text: 'pre-roll' })],
      [item({ id: 'new', cursor: cursor('f2', 0), text: 'post-roll' })],
    )
    expect(merged.map((entry) => entry.text)).toEqual(['pre-roll', 'post-roll'])
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
