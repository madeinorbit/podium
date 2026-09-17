import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { dedupeTranscriptItems, freshOlderTranscriptPage, reconcileTranscriptSnapshot, sameTranscriptItems, mergeTranscriptItems, prependTranscriptItems, transcriptDisplayText } from './transcript'

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

describe('shared transcript helpers', () => {
  it('merges live transcript deltas without duplicating ids', () => {
    const merged = mergeTranscriptItems(
      [
        item({ id: 'a', cursor: 'c1', text: 'old' }),
        item({ id: 'b', cursor: 'c2', text: 'current' }),
      ],
      [
        item({ id: 'b', cursor: 'c2', text: 'current duplicate' }),
        item({ id: 'c', cursor: 'c3', text: 'new' }),
      ],
    )

    expect(merged.map((entry) => entry.text)).toEqual(['old', 'current duplicate', 'new'])
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

const it_ = (id: string, cursor?: string): TranscriptItem => ({
  id,
  ...(cursor !== undefined ? { cursor } : {}),
  role: 'assistant',
  text: id,
})

describe('mergeTranscriptItems', () => {
  it('appends delta items not already present (by id)', () => {
    const prev = [it_('a', 'c1'), it_('b', 'c2')]
    const merged = mergeTranscriptItems(prev, [it_('c', 'c3')])
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('dedupes a delta item whose id is already in prev (live repeats read window)', () => {
    const prev = [it_('a', 'c1'), it_('b', 'c2')]
    // c2 repeats the last read-window item; only the genuinely new c3 appends.
    const merged = mergeTranscriptItems(prev, [it_('b', 'c2'), it_('c', 'c3')])
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps distinct positional rows when provider UUID is null', () => {
    const first = it_('first', cursor('same-file', 10))
    const second = it_('second', cursor('same-file', 20))

    const merged = mergeTranscriptItems([first], [second])

    expect(merged.map((item) => item.id)).toEqual(['first', 'second'])
  })

  it('returns prev unchanged when every delta item is a duplicate', () => {
    const prev = [it_('a', 'c1'), it_('b', 'c2')]
    const merged = mergeTranscriptItems(prev, [it_('b', 'c2')])
    expect(merged).toBe(prev)
  })

  it('uses id when a cursor is missing', () => {
    const prev = [it_('a')]
    const merged = mergeTranscriptItems(prev, [it_('a'), it_('b')])
    expect(merged.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('replaces a same-id item in place when its content grew (truncated→complete)', () => {
    // The tailer flushes an unterminated trailing record, then re-emits it at the
    // SAME cursor with the completed (longer) content once its newline lands.
    const prev = [
      it_('a', 'c1'),
      { id: 'b', cursor: 'c2', role: 'assistant' as const, text: 'partial' },
    ]
    const merged = mergeTranscriptItems(prev, [
      { id: 'b', cursor: 'c2', role: 'assistant' as const, text: 'partial then complete' },
    ])
    expect(merged.map((i) => i.text)).toEqual(['a', 'partial then complete'])
    expect(merged).not.toBe(prev) // content changed → fresh array (re-render)
  })

  it('returns prev unchanged when a same-id re-emit is byte-identical (no re-render)', () => {
    const prev = [it_('a', 'c1'), it_('b', 'c2')]
    const merged = mergeTranscriptItems(prev, [it_('b', 'c2'), it_('c', 'c3')])
    // c2 is identical → no replace; only c3 is genuinely new.
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  // POD-341: a delta is not always newer. The server replays its WHOLE per-session
  // transcript cache to a (re)subscribing client whose `since` cursor it can't find
  // — routine after a file roll or a socket drop — so a frame can carry items that
  // belong ABOVE the held tail. Appending those rendered the superagent's answer
  // above the prompt that produced it.
  it('inserts an item that is OLDER than the held tail at its cursor position', () => {
    const prev = [it_('answer', cursor('f1', 900))]
    const merged = mergeTranscriptItems(prev, [
      it_('prompt', cursor('f1', 100)),
      it_('tool', cursor('f1', 400)),
    ])
    expect(merged.map((i) => i.id)).toEqual(['prompt', 'tool', 'answer'])
  })

  it('keeps a replayed run in transcript order around held items', () => {
    const prev = [it_('b', cursor('f1', 200)), it_('d', cursor('f1', 400))]
    const merged = mergeTranscriptItems(prev, [
      it_('a', cursor('f1', 100)),
      it_('c', cursor('f1', 300)),
      it_('e', cursor('f1', 500)),
    ])
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('orders by sub-index within one record (parallel tool results)', () => {
    const prev = [it_('r2', cursor('f1', 100, 2))]
    const merged = mergeTranscriptItems(prev, [it_('r1', cursor('f1', 100, 1))])
    expect(merged.map((i) => i.id)).toEqual(['r1', 'r2'])
  })

  it('appends across a file roll — a new file is newer, whatever its offsets', () => {
    // Post-roll cursors restart at offset 0 in a DIFFERENT file; they must not sort
    // themselves in among the previous file's items.
    const prev = [it_('old', cursor('f1', 9000))]
    const merged = mergeTranscriptItems(prev, [it_('new', cursor('f2', 0))])
    expect(merged.map((i) => i.id)).toEqual(['old', 'new'])
  })
})

describe('dedupeTranscriptItems', () => {
  it('merges UUID-less replay overlap while retaining distinct file positions', () => {
    const at = (offset: number, sub: number) => {
      const position = cursor('claude-file', offset, sub)
      return it_(position, position)
    }
    const first = [at(0, 0), at(100, 0), at(100, 1)]
    const replay = [at(100, 0), at(100, 1), at(200, 0)]
    expect(dedupeTranscriptItems([...first, ...replay])).toEqual([...first, at(200, 0)])
  })

  it('drops later items sharing an id with an earlier one (paging/live seam)', () => {
    // [...older, ...items] where the boundary item overlaps.
    const seam = [it_('a', 'c1'), it_('b', 'c2'), it_('b', 'c2'), it_('c', 'c3')]
    expect(dedupeTranscriptItems(seam).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('preserves order and items without cursors (dedupes by id)', () => {
    const list = [it_('a'), it_('a'), it_('b', 'c2')]
    expect(dedupeTranscriptItems(list).map((i) => i.id)).toEqual(['a', 'b'])
  })
})

describe('freshOlderTranscriptPage', () => {
  it('keeps a genuinely older page (only the one-item seam overlap is dropped)', () => {
    const held = [it_('b', 'c2'), it_('c', 'c3')]
    const page = [it_('a', 'c1'), it_('b', 'c2')]
    expect(freshOlderTranscriptPage(page, held).map((i) => i.id)).toEqual(['a'])
  })

  // POD-341: an anchored `before` read whose anchor names a rolled-away file comes
  // back as the NEWEST window instead of an older page. Every item in it is already
  // held, so the page is empty and nothing gets prepended above older content.
  it('drops a fully-held page (the reader is echoing the newest window back)', () => {
    const held = [it_('a', 'c1'), it_('b', 'c2'), it_('c', 'c3')]
    expect(freshOlderTranscriptPage([it_('b', 'c2'), it_('c', 'c3')], held)).toEqual([])
  })

  it('passes an empty page straight through', () => {
    expect(freshOlderTranscriptPage([], [it_('a', 'c1')])).toEqual([])
  })
})

describe('reconcileTranscriptSnapshot', () => {
  it('keeps a locally-held in-flight item the re-read snapshot dropped', () => {
    // The live tail flushed an unterminated trailing record (C); a reset-driven
    // disk re-read drops it (slice reader skips a final line without a newline),
    // so the snapshot tail is the last COMPLETE record (B). C must survive.
    const prev = [it_('a', 'c1'), it_('b', 'c2'), it_('c', 'c3')]
    const snapshot = [it_('a', 'c1'), it_('b', 'c2')]
    expect(reconcileTranscriptSnapshot(prev, snapshot, 'c2').map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('does NOT wipe the view when the re-read returns empty (no-resume / failed read)', () => {
    const prev = [it_('a', 'c1'), it_('b', 'c2')]
    expect(reconcileTranscriptSnapshot(prev, [], undefined)).toBe(prev)
  })

  it('replaces fully on a file roll (snapshot tail absent from held items)', () => {
    // Genuine resume→new-file: held items carry stale cursors; the snapshot's tail
    // is a brand-new cursor not in `prev`, so the held items are dropped wholesale.
    const prev = [it_('old1', 'o1'), it_('old2', 'o2')]
    const snapshot = [it_('new1', 'n1'), it_('new2', 'n2')]
    expect(reconcileTranscriptSnapshot(prev, snapshot, 'n2').map((i) => i.id)).toEqual(['new1', 'new2'])
  })

  it('adopts the snapshot when it is a superset of the held window', () => {
    const prev = [it_('a', 'c1'), it_('b', 'c2')]
    const snapshot = [it_('a', 'c1'), it_('b', 'c2'), it_('c', 'c3')]
    expect(reconcileTranscriptSnapshot(prev, snapshot, 'c3').map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('sameTranscriptItems', () => {
  it('holds for a re-read that returned the identical transcript in a fresh array', () => {
    // The guard that makes the liveness reconcile free: reconcileTranscriptSnapshot hands back
    // a NEW array for an unchanged transcript, and without this every heartbeat
    // would re-derive rows and re-render the feed.
    expect(sameTranscriptItems([it_('a', 'c1'), it_('b', 'c2')], [it_('a', 'c1'), it_('b', 'c2')])).toBe(true)
  })

  it('fails on a grown window, so a genuinely new item still lands', () => {
    expect(sameTranscriptItems([it_('a', 'c1')], [it_('a', 'c1'), it_('b', 'c2')])).toBe(false)
  })

  it('fails when a same-id record grew — the re-emitted complete text', () => {
    const partial: TranscriptItem = { id: 'a', cursor: 'c1', role: 'assistant', text: 'Hel' }
    const complete: TranscriptItem = { id: 'a', cursor: 'c1', role: 'assistant', text: 'Hello' }
    expect(sameTranscriptItems([partial], [complete])).toBe(false)
  })

  it('fails when the same length holds different items', () => {
    expect(sameTranscriptItems([it_('a', 'c1')], [it_('b', 'c2')])).toBe(false)
  })
})

