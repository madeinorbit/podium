import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type MirrorReadResult, MirrorService } from '@podium/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from './store'
import { TranscriptIndexer } from './transcript-indexer'

// TranscriptIndexer (docs/spec/search-v1.md §2.3) driven end-to-end through a real
// MirrorService over a fake daemon: chunk hooks feed the indexer, so the tests pin
// the mirror↔indexer contract (chunk-boundary safety, truncate→reindex) rather
// than calling the indexer's internals directly.

const userLine = (uuid: string, text: string): string =>
  `${JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-07-01T10:00:00.000Z',
    message: { role: 'user', content: text },
  })}\n`

const assistantLine = (uuid: string, text: string): string =>
  `${JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-07-01T10:00:05.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  })}\n`

/** In-memory daemon fs: ranged reads over one buffer per path. */
class FakeDaemonFs {
  private readonly files = new Map<string, Buffer>()

  set(path: string, content: string | Buffer): void {
    this.files.set(path, Buffer.from(content))
  }

  read = async (
    _machineId: string,
    req: { path: string; offset: number; maxBytes: number },
  ): Promise<MirrorReadResult> => {
    const content = this.files.get(req.path) ?? Buffer.alloc(0)
    const size = content.length
    const end = Math.min(size, req.offset + req.maxBytes)
    const slice = req.offset < size ? content.subarray(req.offset, end) : Buffer.alloc(0)
    return { data: slice.toString('base64'), fileSize: size, eof: end >= size }
  }
}

describe('TranscriptIndexer', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn()
  })

  function setup() {
    const store = new SessionStore(':memory:')
    const lakeDir = mkdtempSync(join(tmpdir(), 'podium-index-'))
    const fs = new FakeDaemonFs()
    const indexer = new TranscriptIndexer(store)
    const mirror = new MirrorService(store.conversations, lakeDir, fs.read, Date.now, {
      chunkDelayMs: 0,
      passBudgetBytes: Number.MAX_SAFE_INTEGER,
      onBytes: (m, n, p) => indexer.onBytes(m, n, p),
      onTruncate: (m, n) => indexer.onTruncate(m, n),
    })
    cleanups.push(() => {
      store.close()
      rmSync(lakeDir, { recursive: true, force: true })
    })
    return { store, fs, mirror, indexer }
  }

  function seed(store: SessionStore, nativeId: string): string {
    const path = `/home/u/.claude/projects/-proj/${nativeId}.jsonl`
    store.conversations.ensureConversationIdentity({
      machineId: 'm1',
      nativeId,
      providerId: 'claude-code-jsonl',
      path,
    })
    return path
  }

  async function settle(mirror: MirrorService, indexer: TranscriptIndexer): Promise<void> {
    await mirror.settled('m1')
    await indexer.settled()
    // One extra turn: the last onBytes may have scheduled a run after settled()
    // sampled an empty map.
    await new Promise((r) => setTimeout(r, 10))
    await indexer.settled()
  }

  it('indexes user/assistant text once, skipping non-message records', async () => {
    const { store, fs, mirror, indexer } = setup()
    const path = seed(store, 'conv')
    const content =
      userLine('u1', 'find the flux capacitor') +
      // Non-message records: tool result, meta, summary — none are prose.
      `${JSON.stringify({ type: 'summary', summary: 'Flux hunt', leafUuid: 'a1' })}\n` +
      `${JSON.stringify({
        type: 'user',
        uuid: 'u2',
        isMeta: true,
        message: { role: 'user', content: 'injected skill body' },
      })}\n` +
      assistantLine('a1', 'It lives in engine.ts')
    fs.set(path, content)

    mirror.enqueue('m1', 'conv', path)
    await settle(mirror, indexer)

    expect(store.conversations.transcriptIndexRows('m1', 'conv').map((r) => r.content)).toEqual([
      'find the flux capacitor',
      'It lives in engine.ts',
    ])
    expect(store.conversations.indexedCursor('m1', 'conv')).toBe(Buffer.byteLength(content))
  })

  it('indexes a record split across two mirror chunks exactly once', async () => {
    const { store, fs, mirror, indexer } = setup()
    const path = seed(store, 'split')
    const first = userLine('u1', 'part one message')
    const second = assistantLine('a1', 'the split record answer')
    // Chunk 1 ends MID-record: the partial trailing line must wait.
    const cut = first.length + Math.floor(second.length / 2)
    const whole = first + second
    fs.set(path, whole.slice(0, cut))

    mirror.enqueue('m1', 'split', path)
    await settle(mirror, indexer)
    expect(store.conversations.transcriptIndexRows('m1', 'split').map((r) => r.content)).toEqual([
      'part one message',
    ])
    expect(store.conversations.indexedCursor('m1', 'split')).toBe(first.length) // partial line waits

    // The rest of the record arrives.
    fs.set(path, whole)
    mirror.enqueue('m1', 'split', path)
    await settle(mirror, indexer)

    expect(store.conversations.transcriptIndexRows('m1', 'split').map((r) => r.content)).toEqual([
      'part one message',
      'the split record answer',
    ])
    expect(store.conversations.indexedCursor('m1', 'split')).toBe(Buffer.byteLength(whole))
  })

  it('truncate (source rewrite) drops the index and reindexes the new content', async () => {
    const { store, fs, mirror, indexer } = setup()
    const path = seed(store, 'rewrite')
    const original =
      userLine('u1', 'original long conversation') + assistantLine('a1', 'old answer')
    fs.set(path, original)
    mirror.enqueue('m1', 'rewrite', path)
    await settle(mirror, indexer)
    expect(store.conversations.transcriptIndexRows('m1', 'rewrite').map((r) => r.content)).toEqual([
      'original long conversation',
      'old answer',
    ])

    // Native file rewritten SHORTER — mirror truncates and re-pulls; the index
    // must drop the stale rows and reindex only what the new file holds.
    const rewritten = userLine('u9', 'fresh rewritten history')
    fs.set(path, rewritten)
    mirror.enqueue('m1', 'rewrite', path)
    await settle(mirror, indexer)

    expect(store.conversations.transcriptIndexRows('m1', 'rewrite').map((r) => r.content)).toEqual([
      'fresh rewritten history',
    ])
    expect(store.conversations.indexedCursor('m1', 'rewrite')).toBe(Buffer.byteLength(rewritten))
  })

  it('degrades to a no-op without throwing when FTS5 is unavailable', async () => {
    const store = new SessionStore(':memory:')
    cleanups.push(() => store.close())
    // Simulate the no-FTS runtime: the availability flag is what gates every path.
    Object.assign(store, { transcriptFtsAvailable: false })
    const indexer = new TranscriptIndexer(store)
    seed(store, 'nofts')
    store.conversations.setMirrorCursor('m1', 'nofts', 100, '2026-07-01T10:00:00Z')

    expect(() => indexer.onBytes('m1', 'nofts', '/nonexistent/lake.jsonl')).not.toThrow()
    await indexer.settled()
    expect(store.conversations.indexedCursor('m1', 'nofts')).toBe(0) // nothing consumed
    expect(() => indexer.onTruncate('m1', 'nofts')).not.toThrow()
  })

  // ---- backfill (pre-P5 lakes): segments fully mirrored before the indexer
  // existed never receive an onBytes hook — backfillMachine sweeps them, paced
  // like the mirror's bootstrap (windows + budget + unref'd delays).

  /** A store + on-disk lake dir seeded with pre-P5 segments: lake file present,
   *  mirrored_bytes set, indexed_bytes 0 — exactly what a deploy inherits. */
  function backfillSetup(
    segments: { nativeId: string; content: string }[],
    options?: ConstructorParameters<typeof TranscriptIndexer>[1],
  ) {
    const store = new SessionStore(':memory:')
    const lakeDir = mkdtempSync(join(tmpdir(), 'podium-backfill-'))
    cleanups.push(() => {
      store.close()
      rmSync(lakeDir, { recursive: true, force: true })
    })
    mkdirSync(join(lakeDir, 'm1'), { recursive: true })
    for (const s of segments) {
      seed(store, s.nativeId)
      writeFileSync(join(lakeDir, 'm1', `${s.nativeId}.jsonl`), s.content)
      store.conversations.setMirrorCursor('m1', s.nativeId, Buffer.byteLength(s.content), '2026-07-01T10:00:00Z')
    }
    const indexer = new TranscriptIndexer(store, { chunkDelayMs: 0, ...options })
    const lakePathFor = (nativeId: string) => join(lakeDir, 'm1', `${nativeId}.jsonl`)
    return { store, indexer, lakePathFor }
  }

  it('backfills pre-existing fully-mirrored segments into the FTS index', async () => {
    const { store, indexer, lakePathFor } = backfillSetup([
      { nativeId: 'old-a', content: userLine('u1', 'ancient history one') },
      {
        nativeId: 'old-b',
        content: userLine('u2', 'ancient history two') + assistantLine('a2', 'and its answer'),
      },
    ])
    indexer.backfillMachine('m1', lakePathFor)
    await indexer.settled()

    expect(store.conversations.transcriptIndexRows('m1', 'old-a').map((r) => r.content)).toEqual([
      'ancient history one',
    ])
    expect(store.conversations.transcriptIndexRows('m1', 'old-b').map((r) => r.content)).toEqual([
      'ancient history two',
      'and its answer',
    ])
    expect(store.conversations.segmentsToIndex('m1')).toEqual([]) // fully caught up
  })

  it('stops a backfill pass at the byte budget and resumes on the next trigger', async () => {
    const segA = userLine('u1', 'first pre-existing conversation body')
    const segB = userLine('u2', 'second pre-existing conversation body')
    const { store, indexer, lakePathFor } = backfillSetup(
      [
        { nativeId: 'pace-a', content: segA },
        { nativeId: 'pace-b', content: segB },
      ],
      // Budget covers segment A only — the pass must stop before B, leaving its
      // cursor at 0 for the next trigger (segmentsToIndex ordering is insertion
      // order, so A drains first).
      { passBudgetBytes: Buffer.byteLength(segA) },
    )
    indexer.backfillMachine('m1', lakePathFor)
    await indexer.settled()

    const cursors = () => store.conversations.segmentsToIndex('m1').map((s) => s.nativeId)
    expect(store.conversations.indexedCursor('m1', 'pace-a')).toBe(Buffer.byteLength(segA))
    expect(store.conversations.indexedCursor('m1', 'pace-b')).toBe(0)
    expect(cursors()).toEqual(['pace-b'])

    // Next scan/attach trigger: resumes from the persisted cursors, finishes B.
    indexer.backfillMachine('m1', lakePathFor)
    await indexer.settled()
    expect(store.conversations.indexedCursor('m1', 'pace-b')).toBe(Buffer.byteLength(segB))
    expect(cursors()).toEqual([])
    expect(store.conversations.transcriptIndexRows('m1', 'pace-b').map((r) => r.content)).toEqual([
      'second pre-existing conversation body',
    ])
  })

  it('splits a large segment across budget-bounded windows without re-indexing', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => userLine(`u${i}`, `message number ${i}`))
    const content = lines.join('')
    const { store, indexer, lakePathFor } = backfillSetup(
      [{ nativeId: 'big', content }],
      // Tiny window: many windows per pass; tiny budget: several passes needed.
      { windowBytes: 256, passBudgetBytes: 1024 },
    )
    let passes = 0
    while (store.conversations.segmentsToIndex('m1').length > 0) {
      passes++
      expect(passes).toBeLessThanOrEqual(20)
      indexer.backfillMachine('m1', lakePathFor)
      await indexer.settled()
    }
    expect(passes).toBeGreaterThan(1) // the budget actually split the work
    expect(store.conversations.transcriptIndexRows('m1', 'big').map((r) => r.content)).toEqual(
      lines.map((_, i) => `message number ${i}`),
    )
    expect(store.conversations.indexedCursor('m1', 'big')).toBe(Buffer.byteLength(content))
  })

  it('leaves already-indexed segments untouched (no duplicate rows)', async () => {
    const { store, indexer, lakePathFor } = backfillSetup([
      { nativeId: 'done', content: userLine('u1', 'index me exactly once') },
    ])
    indexer.backfillMachine('m1', lakePathFor)
    await indexer.settled()
    expect(store.conversations.transcriptIndexRows('m1', 'done')).toHaveLength(1)

    // Second trigger with nothing behind: no new rows, cursor unchanged.
    indexer.backfillMachine('m1', lakePathFor)
    await indexer.settled()
    expect(store.conversations.transcriptIndexRows('m1', 'done')).toHaveLength(1)
  })

  it('stops re-reading an unchanged undrainable gap across sweeps (newline-less tail)', async () => {
    // Production shape: 42 lake files end without a trailing newline, so their
    // segments never leave segmentsToIndex — every sweep used to re-read the same
    // tiny gap. The indexer must skip a segment whose (mirrored, indexed) pair
    // hasn't moved since the last attempt, and retry as soon as either moves.
    const complete = userLine('u1', 'a finished thought')
    const partial = '{"type":"user","uuid":"u2","message":{"role":"user"' // torn mid-record, no \n
    const { store, indexer, lakePathFor } = backfillSetup([
      { nativeId: 'tail', content: complete + partial },
    ])
    // indexedCursor is the first call of every index attempt — its call count is
    // the proxy for "the indexer went back to the file".
    const attempts = vi.spyOn(store.conversations, 'indexedCursor')

    // Sweep 1: drains the complete line, leaves the partial tail unconsumed.
    indexer.backfillMachine('m1', lakePathFor)
    await indexer.settled()
    expect(store.conversations.indexedCursor('m1', 'tail')).toBe(Buffer.byteLength(complete))
    expect(store.conversations.segmentsToIndex('m1').map((s) => s.nativeId)).toEqual(['tail'])

    // Sweep 2: attempts once more, proves zero progress, records the gap.
    indexer.backfillMachine('m1', lakePathFor)
    await indexer.settled()
    const settledCalls = attempts.mock.calls.length

    // Sweeps 3..5: pair unchanged — skipped outright, NO further index attempts
    // (this is the read-call count stopping its per-sweep growth).
    for (let i = 0; i < 3; i++) {
      indexer.backfillMachine('m1', lakePathFor)
      await indexer.settled()
    }
    expect(attempts.mock.calls.length).toBe(settledCalls)

    // The mirror completes the record: cursor moves → the segment re-qualifies.
    const completed = `${complete + partial},"content":"now whole"}}\n`
    writeFileSync(lakePathFor('tail'), completed)
    store.conversations.setMirrorCursor('m1', 'tail', Buffer.byteLength(completed), '2026-07-01T11:00:00Z')
    indexer.backfillMachine('m1', lakePathFor)
    await indexer.settled()
    expect(store.conversations.indexedCursor('m1', 'tail')).toBe(Buffer.byteLength(completed))
    expect(store.conversations.transcriptIndexRows('m1', 'tail').map((r) => r.content)).toEqual([
      'a finished thought',
      'now whole',
    ])
  })

  it('backs off cleanly when the lake file is unreadable (cursor untouched)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { store, indexer } = setup()
      seed(store, 'gone')
      store.conversations.setMirrorCursor('m1', 'gone', 50, '2026-07-01T10:00:00Z')
      indexer.onBytes('m1', 'gone', '/nonexistent/lake.jsonl')
      await indexer.settled()
      expect(store.conversations.indexedCursor('m1', 'gone')).toBe(0)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
