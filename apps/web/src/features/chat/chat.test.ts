import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  accumulateFileLinkPaths,
  buildChatRows,
  dedupeByCursor,
  freshOlderPage,
  isBatchableTool,
  mergeByCursor,
  pairToolResults,
  reconcileReset,
} from './chat'

const tool = (toolName: string, id: string): TranscriptItem => ({
  id,
  role: 'tool',
  text: '',
  toolName,
})

describe('isBatchableTool', () => {
  it('folds ordinary tools', () => {
    expect(isBatchableTool(tool('Read', 'r'))).toBe(true)
  })
  it('does not fold AskUserQuestion or SendUserFile', () => {
    expect(isBatchableTool(tool('AskUserQuestion', 'a'))).toBe(false)
    expect(isBatchableTool(tool('SendUserFile', 's'))).toBe(false)
  })
})

describe('buildChatRows with SendUserFile', () => {
  it('renders SendUserFile as its own row, breaking a tool run', () => {
    const blocks = pairToolResults([
      tool('Read', 'r1'),
      tool('SendUserFile', 'suf'),
      tool('Read', 'r2'),
    ])
    const rows = buildChatRows(blocks)
    // Read | SendUserFile (single) | Read — three rows, SendUserFile not folded.
    expect(rows.map((r) => r.kind)).toEqual(['tools', 'block', 'tools'])
    const mid = rows[1]
    expect(mid?.kind === 'block' && mid.block.item.toolName).toBe('SendUserFile')
  })
})

/** A real Podium cursor: base64url `[fileId, offset, uuid, sub]` — the encoding
 *  packages/transcript/src/cursor-codec.ts stamps every item with. */
const cursor = (fileId: string, offset: number, sub = 0): string =>
  btoa(JSON.stringify([fileId, offset, null, sub]))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const it_ = (id: string, cursor?: string): TranscriptItem => ({
  id,
  ...(cursor !== undefined ? { cursor } : {}),
  role: 'assistant',
  text: id,
})

describe('pairToolResults media-marker folding', () => {
  const user = (over: Partial<TranscriptItem>): TranscriptItem => ({
    id: 'u1',
    role: 'user',
    text: 'look at this',
    ...over,
  })
  const marker: TranscriptItem = {
    id: 'm1',
    role: 'user',
    text: '',
    toolPaths: ['/home/u/.podium/uploads/s1/shot.png'],
    tags: [{ kind: 'image', label: 'shot.png' }],
  }

  it('folds a media marker into the preceding user block', () => {
    const blocks = pairToolResults([user({}), marker])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.item.text).toBe('look at this')
    expect(blocks[0]!.item.toolPaths).toEqual(['/home/u/.podium/uploads/s1/shot.png'])
    expect(blocks[0]!.item.tags).toEqual([{ kind: 'image', label: 'shot.png' }])
  })

  it('keeps a marker standalone when no user block precedes it', () => {
    const blocks = pairToolResults([marker])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.item.toolPaths).toEqual(['/home/u/.podium/uploads/s1/shot.png'])
  })
})

describe('mergeByCursor', () => {
  it('appends delta items not already present (by cursor)', () => {
    const prev = [it_('a', 'c1'), it_('b', 'c2')]
    const merged = mergeByCursor(prev, [it_('c', 'c3')])
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('dedupes a delta item whose cursor is already in prev (live repeats read window)', () => {
    const prev = [it_('a', 'c1'), it_('b', 'c2')]
    // c2 repeats the last read-window item; only the genuinely new c3 appends.
    const merged = mergeByCursor(prev, [it_('b', 'c2'), it_('c', 'c3')])
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('returns prev unchanged when every delta item is a duplicate', () => {
    const prev = [it_('a', 'c1'), it_('b', 'c2')]
    const merged = mergeByCursor(prev, [it_('b', 'c2')])
    expect(merged).toBe(prev)
  })

  it('falls back to id when a cursor is missing', () => {
    const prev = [it_('a')]
    const merged = mergeByCursor(prev, [it_('a'), it_('b')])
    expect(merged.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('replaces a same-cursor item in place when its content grew (truncated→complete)', () => {
    // The tailer flushes an unterminated trailing record, then re-emits it at the
    // SAME cursor with the completed (longer) content once its newline lands.
    const prev = [
      it_('a', 'c1'),
      { id: 'b', cursor: 'c2', role: 'assistant' as const, text: 'partial' },
    ]
    const merged = mergeByCursor(prev, [
      { id: 'b', cursor: 'c2', role: 'assistant' as const, text: 'partial then complete' },
    ])
    expect(merged.map((i) => i.text)).toEqual(['a', 'partial then complete'])
    expect(merged).not.toBe(prev) // content changed → fresh array (re-render)
  })

  it('returns prev unchanged when a same-cursor re-emit is byte-identical (no re-render)', () => {
    const prev = [it_('a', 'c1'), it_('b', 'c2')]
    const merged = mergeByCursor(prev, [it_('b', 'c2'), it_('c', 'c3')])
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
    const merged = mergeByCursor(prev, [
      it_('prompt', cursor('f1', 100)),
      it_('tool', cursor('f1', 400)),
    ])
    expect(merged.map((i) => i.id)).toEqual(['prompt', 'tool', 'answer'])
  })

  it('keeps a replayed run in transcript order around held items', () => {
    const prev = [it_('b', cursor('f1', 200)), it_('d', cursor('f1', 400))]
    const merged = mergeByCursor(prev, [
      it_('a', cursor('f1', 100)),
      it_('c', cursor('f1', 300)),
      it_('e', cursor('f1', 500)),
    ])
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('orders by sub-index within one record (parallel tool results)', () => {
    const prev = [it_('r2', cursor('f1', 100, 2))]
    const merged = mergeByCursor(prev, [it_('r1', cursor('f1', 100, 1))])
    expect(merged.map((i) => i.id)).toEqual(['r1', 'r2'])
  })

  it('appends across a file roll — a new file is newer, whatever its offsets', () => {
    // Post-roll cursors restart at offset 0 in a DIFFERENT file; they must not sort
    // themselves in among the previous file's items.
    const prev = [it_('old', cursor('f1', 9000))]
    const merged = mergeByCursor(prev, [it_('new', cursor('f2', 0))])
    expect(merged.map((i) => i.id)).toEqual(['old', 'new'])
  })
})

const pathItem = (id: string, paths: string[]): TranscriptItem => ({
  id,
  role: 'tool',
  text: '',
  toolName: 'Read',
  toolPaths: paths,
})

describe('accumulateFileLinkPaths (AgentPanel file-link delta contract)', () => {
  it('ACCUMULATES toolPaths across two non-reset delta frames (second does not replace first)', () => {
    // Frame 1: the hub forwards a delta, not the full list.
    const afterFirst = accumulateFileLinkPaths(new Set(), [pathItem('a', ['/repo/a.ts'])], false)
    expect([...afterFirst]).toEqual(['/repo/a.ts'])
    // Frame 2: a SECOND delta. The regression we guard against ("treat the delta
    // as the whole list") would drop /repo/a.ts here — assert both survive.
    const afterSecond = accumulateFileLinkPaths(afterFirst, [pathItem('b', ['/repo/b.ts'])], false)
    expect([...afterSecond].sort()).toEqual(['/repo/a.ts', '/repo/b.ts'])
  })

  it('a reset frame CLEARS the set — only the reset frame paths remain', () => {
    const accumulated = accumulateFileLinkPaths(
      new Set(['/repo/a.ts', '/repo/b.ts']),
      [pathItem('c', ['/repo/c.ts'])],
      true,
    )
    expect([...accumulated]).toEqual(['/repo/c.ts'])
  })

  it('returns a FRESH Set (never the prev identity) so callers can hand it on safely', () => {
    const prev = new Set(['/repo/a.ts'])
    const next = accumulateFileLinkPaths(prev, [pathItem('b', ['/repo/b.ts'])], false)
    expect(next).not.toBe(prev)
    // Mutating the result must not bleed back into the accumulator we were given.
    expect([...prev]).toEqual(['/repo/a.ts'])
  })

  it('folds multiple paths per item and dedupes a path seen across frames', () => {
    const f1 = accumulateFileLinkPaths(new Set(), [pathItem('a', ['/x.ts', '/y.ts'])], false)
    const f2 = accumulateFileLinkPaths(f1, [pathItem('b', ['/y.ts', '/z.ts'])], false)
    expect([...f2].sort()).toEqual(['/x.ts', '/y.ts', '/z.ts'])
  })
})

describe('dedupeByCursor', () => {
  it('drops later items sharing a cursor with an earlier one (paging/live seam)', () => {
    // [...older, ...items] where the boundary item overlaps.
    const seam = [it_('a', 'c1'), it_('b', 'c2'), it_('b', 'c2'), it_('c', 'c3')]
    expect(dedupeByCursor(seam).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('preserves order and items without cursors (dedupes by id)', () => {
    const list = [it_('a'), it_('a'), it_('b', 'c2')]
    expect(dedupeByCursor(list).map((i) => i.id)).toEqual(['a', 'b'])
  })
})

describe('freshOlderPage', () => {
  it('keeps a genuinely older page (only the one-item seam overlap is dropped)', () => {
    const held = [it_('b', 'c2'), it_('c', 'c3')]
    const page = [it_('a', 'c1'), it_('b', 'c2')]
    expect(freshOlderPage(page, held).map((i) => i.id)).toEqual(['a'])
  })

  // POD-341: an anchored `before` read whose anchor names a rolled-away file comes
  // back as the NEWEST window instead of an older page. Every item in it is already
  // held, so the page is empty and nothing gets prepended above older content.
  it('drops a fully-held page (the reader is echoing the newest window back)', () => {
    const held = [it_('a', 'c1'), it_('b', 'c2'), it_('c', 'c3')]
    expect(freshOlderPage([it_('b', 'c2'), it_('c', 'c3')], held)).toEqual([])
  })

  it('passes an empty page straight through', () => {
    expect(freshOlderPage([], [it_('a', 'c1')])).toEqual([])
  })
})

describe('reconcileReset', () => {
  it('keeps a locally-held in-flight item the re-read snapshot dropped', () => {
    // The live tail flushed an unterminated trailing record (C); a reset-driven
    // disk re-read drops it (slice reader skips a final line without a newline),
    // so the snapshot tail is the last COMPLETE record (B). C must survive.
    const prev = [it_('a', 'c1'), it_('b', 'c2'), it_('c', 'c3')]
    const snapshot = [it_('a', 'c1'), it_('b', 'c2')]
    expect(reconcileReset(prev, snapshot, 'c2').map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('does NOT wipe the view when the re-read returns empty (no-resume / failed read)', () => {
    const prev = [it_('a', 'c1'), it_('b', 'c2')]
    expect(reconcileReset(prev, [], undefined)).toBe(prev)
  })

  it('replaces fully on a file roll (snapshot tail absent from held items)', () => {
    // Genuine resume→new-file: held items carry stale cursors; the snapshot's tail
    // is a brand-new cursor not in `prev`, so the held items are dropped wholesale.
    const prev = [it_('old1', 'o1'), it_('old2', 'o2')]
    const snapshot = [it_('new1', 'n1'), it_('new2', 'n2')]
    expect(reconcileReset(prev, snapshot, 'n2').map((i) => i.id)).toEqual(['new1', 'new2'])
  })

  it('adopts the snapshot when it is a superset of the held window', () => {
    const prev = [it_('a', 'c1'), it_('b', 'c2')]
    const snapshot = [it_('a', 'c1'), it_('b', 'c2'), it_('c', 'c3')]
    expect(reconcileReset(prev, snapshot, 'c3').map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
})
