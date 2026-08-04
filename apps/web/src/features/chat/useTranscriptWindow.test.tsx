import { beginSwitch, getRecentSwitchTraces, resetSwitchTraces } from '@podium/client-core/perf'
import {
  asSessionId,
  type SessionId,
  type SessionMeta,
  type SessionMetaInput,
  type TranscriptItem,
} from '@podium/model'
import type { JSX } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// react-dom's act() needs this flag to drive effects/rAF flushes without warnings.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import {
  RENDER_WINDOW,
  type UseTranscriptWindowOptions,
  type UseTranscriptWindowResult,
  useTranscriptWindow,
} from './useTranscriptWindow'

// ---------------------------------------------------------------------------
// POD-725: a warm chat panel that stays mounted (with a live delta subscription)
// must NOT re-read its transcript window on every re-activation. These tests
// drive the hook directly with controllable hub/tRPC/replica fakes and assert
// both the read behaviour and the switch-trace mark contract (chat:cache-hit +
// chat:first-paint on a skipped-read activation; a full re-read otherwise).
// ---------------------------------------------------------------------------

type DeltaCb = (items: TranscriptItem[], meta: { reset: boolean }) => void

const fakeHub = {
  subscribes: [] as Array<{ sessionId: SessionId; since: string | undefined; cb: DeltaCb }>,
  subscribeTranscript(sessionId: SessionId, since: string | undefined, cb: DeltaCb): () => void {
    this.subscribes.push({ sessionId, since, cb })
    return () => {}
  },
}

interface ReadCall {
  input: { sessionId: SessionId; anchor?: string; direction: 'before' | 'after'; limit: number }
  resolve: (r: { items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean }) => void
  reject: (err: unknown) => void
}

const reads: ReadCall[] = []
const fakeTrpc = {
  sessions: {
    transcriptRead: {
      query(input: ReadCall['input']) {
        return new Promise((resolve, reject) => {
          reads.push({ input, resolve, reject })
        })
      },
    },
  },
}

/** Recording replica fake: cached windows served by key + a log of write-throughs. */
const fakeReplica = {
  windows: new Map<string, { items: TranscriptItem[]; savedAt: number }>(),
  puts: [] as Array<{ key: string; items: TranscriptItem[] }>,
  transcriptWindow(key: string) {
    return this.windows.get(key)
  },
  putTranscriptWindow(key: string, items: TranscriptItem[]) {
    this.puts.push({ key, items })
    this.windows.set(key, { items, savedAt: Date.now() })
  },
}

function meta(over: Partial<SessionMetaInput>): SessionMeta {
  return {
    sessionId: asSessionId('s1'),
    agentKind: 'claude-code',
    title: 't',
    cwd: '/w',
    status: 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-06-03T00:00:00.000Z',
    lastActiveAt: '2026-06-03T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...over,
  } as unknown as SessionMeta
}

function item(id: string, cursor: string, text: string): TranscriptItem {
  return { id, cursor, role: 'assistant', text }
}

let captured: UseTranscriptWindowResult | null = null

function Probe({ active }: { active: boolean }): JSX.Element | null {
  const scrollerRef = { current: null }
  captured = useTranscriptWindow({
    sessionId: asSessionId('s1'),
    hub: fakeHub,
    trpc: fakeTrpc,
    replica: fakeReplica,
    active,
    session: meta({}),
    scrollerRef,
  } as unknown as UseTranscriptWindowOptions)
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  reads.length = 0
  fakeHub.subscribes.length = 0
  fakeReplica.windows.clear()
  fakeReplica.puts.length = 0
  captured = null
  resetSwitchTraces()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetSwitchTraces()
  vi.clearAllMocks()
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Let the double-rAF chat:first-paint fire (happy-dom drives rAF off a timer). */
async function flushFrames(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40))
    await new Promise((r) => setTimeout(r, 40))
    await new Promise((r) => setTimeout(r, 40))
  })
}

function lastTraceMarks(): string[] {
  const t = getRecentSwitchTraces().at(-1)
  return t ? t.marks.map((m) => m.name) : []
}

describe('useTranscriptWindow warm-switch reuse (POD-725)', () => {
  it('(a) a warm activation with a healthy window skips the re-read and marks a cache hit', async () => {
    act(() => root.render(<Probe active={false} />))
    expect(reads).toHaveLength(1)
    await act(async () => {
      reads[0]?.resolve({
        items: [item('a', 'c1', 'first'), item('b', 'c2', 'second')],
        head: 'c1',
        tail: 'c2',
        hasMore: false,
      })
    })
    await flush()
    const rowsBefore = captured?.rows

    // Gesture: begin the trace, then re-activate the still-mounted panel.
    beginSwitch({ sessionId: asSessionId('s1') })
    act(() => root.render(<Probe active={true} />))
    await flush()
    // No new disk read — the held window is reused.
    expect(reads).toHaveLength(1)
    await flushFrames()

    const names = lastTraceMarks()
    expect(names).toContain('chat:cache-hit')
    expect(names).toContain('chat:first-paint')
    expect(names).not.toContain('transcript:read-start')
    expect(names).not.toContain('transcript:read-end')
    expect(getRecentSwitchTraces().at(-1)?.meta?.items).toBe(2)
    // Point 3: derived rows are reused (same reference) across the skip — the
    // useMemo chain already covers this once the re-read is gone.
    expect(captured?.rows).toBe(rowsBefore)
    expect(captured?.rows).toHaveLength(2)
  })

  it('(b) an activation after a subscription reset does a full re-read (no cache hit)', async () => {
    act(() => root.render(<Probe active={false} />))
    await act(async () => {
      reads[0]?.resolve({
        items: [item('a', 'c1', 'first')],
        head: 'c1',
        tail: 'c1',
        hasMore: false,
      })
    })
    await flush()
    // A reset delta breaks window health and triggers its own re-read (unresolved).
    await act(async () => {
      fakeHub.subscribes[0]?.cb([], { reset: true })
    })
    await flush()
    expect(reads).toHaveLength(2)

    beginSwitch({ sessionId: asSessionId('s1') })
    act(() => root.render(<Probe active={true} />))
    await flush()
    // Health is broken → the activation re-reads rather than reusing the window.
    expect(reads).toHaveLength(3)
    await flushFrames()

    const names = lastTraceMarks()
    expect(names).not.toContain('chat:cache-hit')
    expect(names).toContain('transcript:read-start')
  })

  it('(c) an activation over an empty window re-reads', async () => {
    act(() => root.render(<Probe active={false} />))
    await act(async () => {
      reads[0]?.resolve({ items: [], hasMore: false })
    })
    await flush()

    beginSwitch({ sessionId: asSessionId('s1') })
    act(() => root.render(<Probe active={true} />))
    await flush()
    expect(reads).toHaveLength(2)
    await flushFrames()

    const names = lastTraceMarks()
    expect(names).not.toContain('chat:cache-hit')
    expect(names).toContain('transcript:read-start')
  })

  it('(d) a replica-served (offline) window re-reads on the next activation', async () => {
    fakeReplica.windows.set('s1', {
      items: [item('a', 'c1', 'cached one'), item('b', 'c2', 'cached two')],
      savedAt: Date.parse('2026-07-01T10:00:00.000Z'),
    })
    act(() => root.render(<Probe active={false} />))
    expect(reads).toHaveLength(1)
    await act(async () => {
      reads[0]?.reject(new Error('offline'))
    })
    await flush()
    // The offline copy is showing — potentially stale, so health must be broken.
    expect(captured?.offlineAsOf).not.toBeNull()

    beginSwitch({ sessionId: asSessionId('s1') })
    act(() => root.render(<Probe active={true} />))
    await flush()
    expect(reads).toHaveLength(2)
    await flushFrames()

    const names = lastTraceMarks()
    expect(names).not.toContain('chat:cache-hit')
    expect(names).toContain('transcript:read-start')

    // A successful re-read clears the offline notice.
    await act(async () => {
      reads[1]?.resolve({
        items: [item('z', 'c9', 'fresh from server')],
        head: 'c9',
        tail: 'c9',
        hasMore: false,
      })
    })
    await flush()
    expect(captured?.offlineAsOf).toBeNull()
  })

  it('(e) a delta arriving while hidden advances the window; the next activation still skips and shows it', async () => {
    act(() => root.render(<Probe active={false} />))
    await act(async () => {
      reads[0]?.resolve({
        items: [item('a', 'c1', 'first'), item('b', 'c2', 'second')],
        head: 'c1',
        tail: 'c2',
        hasMore: false,
      })
    })
    await flush()
    // A live delta lands while the panel is hidden (still subscribed).
    await act(async () => {
      fakeHub.subscribes[0]?.cb([item('c', 'c3', 'third')], { reset: false })
    })
    await flush()
    expect(captured?.blocks.some((b) => b.item.text === 'third')).toBe(true)

    beginSwitch({ sessionId: asSessionId('s1') })
    act(() => root.render(<Probe active={true} />))
    await flush()
    // Still a healthy window — no re-read, and the delta is on screen.
    expect(reads).toHaveLength(1)
    await flushFrames()

    const names = lastTraceMarks()
    expect(names).toContain('chat:cache-hit')
    expect(names).not.toContain('transcript:read-start')
    expect(getRecentSwitchTraces().at(-1)?.meta?.items).toBe(3)
    expect(captured?.blocks.some((b) => b.item.text === 'third')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// POD-341: back-paging must only ever ADD earlier items. An anchored `before`
// read whose anchor names a rolled-away transcript file comes back as the
// NEWEST window (the disk reader's documented fallback), and prepending that
// pushed newer items above older ones — the superagent's answer rendered above
// the prompt that produced it.
// ---------------------------------------------------------------------------
describe('useTranscriptWindow back-paging (POD-341)', () => {
  async function seedWindow(): Promise<void> {
    act(() => root.render(<Probe active={true} />))
    await act(async () => {
      reads[0]?.resolve({
        items: [item('b', 'c2', 'prompt'), item('c', 'c3', 'answer')],
        head: 'c2',
        tail: 'c3',
        hasMore: true,
      })
    })
    await flush()
  }

  it('prepends a genuinely older page (its seam overlap is not duplicated)', async () => {
    await seedWindow()
    act(() => captured?.loadOlder())
    await act(async () => {
      reads[1]?.resolve({
        items: [item('a', 'c1', 'earlier'), item('b', 'c2', 'prompt')],
        head: 'c1',
        tail: 'c2',
        hasMore: false,
      })
    })
    await flush()
    expect(captured?.blocks.map((b) => b.item.text)).toEqual(['earlier', 'prompt', 'answer'])
    expect(captured?.hasMoreOlder).toBe(false)
  })

  it('discards a page that is entirely already held (rolled-away anchor → newest window)', async () => {
    // A window that straddles a file roll: two items read off the pre-roll file,
    // then the fresh turn live-tailed from the new one.
    act(() => root.render(<Probe active={true} />))
    await act(async () => {
      reads[0]?.resolve({
        items: [item('o1', 'o1', 'older one'), item('o2', 'o2', 'older two')],
        head: 'o1',
        tail: 'o2',
        hasMore: true,
      })
    })
    await flush()
    await act(async () => {
      fakeHub.subscribes[0]?.cb([item('p', 'n1', 'prompt'), item('a', 'n2', 'answer')], {
        reset: false,
      })
    })
    await flush()

    // Paging up asks with the pre-roll head cursor; the reader has lost that file
    // and answers with the NEWEST window — every item of which is already held.
    act(() => captured?.loadOlder())
    await act(async () => {
      reads[1]?.resolve({
        items: [item('p', 'n1', 'prompt'), item('a', 'n2', 'answer')],
        head: 'n1',
        tail: 'n2',
        hasMore: true,
      })
    })
    await flush()
    // Prepending it would hoist the fresh turn above the older items; the page is
    // dropped instead, and paging stops rather than re-fetching it forever.
    expect(captured?.blocks.map((b) => b.item.text)).toEqual([
      'older one',
      'older two',
      'prompt',
      'answer',
    ])
    expect(captured?.hasMoreOlder).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// POD-1631: the initial window is sized for time-to-first-paint (200 items —
// measured p50 21ms vs 69ms at 1000, and exactly REPLICA_TRANSCRIPT_ITEM_CAP so
// the offline write-through keeps the depth it always had). The depth search
// used to get for free is bought back on demand by `ensureSearchDepth`.
// ---------------------------------------------------------------------------
describe('useTranscriptWindow initial depth and search deepen (POD-1631)', () => {
  /** N synthetic items, cursors c1..cN, so a page can be sized without listing it. */
  function page(from: number, count: number): TranscriptItem[] {
    return Array.from({ length: count }, (_, i) => {
      const n = from + i
      return item(`i${n}`, `c${n}`, `msg ${n}`)
    })
  }

  it('reads a paint-sized initial window, not the search-sized one', async () => {
    act(() => root.render(<Probe active={true} />))
    expect(reads[0]?.input.limit).toBe(200)
    // No anchor on the initial read — it is the newest window off the tail.
    expect(reads[0]?.input.anchor).toBeUndefined()
  })

  it('deepens the LOADED window to search depth on the first query, without rendering it', async () => {
    act(() => root.render(<Probe active={true} />))
    await act(async () => {
      reads[0]?.resolve({ items: page(801, 200), head: 'c801', tail: 'c1000', hasMore: true })
    })
    await flush()

    act(() => captured?.ensureSearchDepth())
    await flush()
    expect(captured?.deepeningSearch).toBe(true)

    // Two 400-item pages take the loaded window from 200 to 1000 and it stops.
    for (let p = 0; p < 2; p++) {
      const call = reads.at(-1)
      expect(call?.input.limit).toBe(400)
      const from = 801 - 400 * (p + 1)
      await act(async () => {
        call?.resolve({
          items: page(from, 400),
          head: `c${from}`,
          tail: `c${from + 399}`,
          hasMore: true,
        })
      })
      await flush()
    }

    expect(captured?.blocks).toHaveLength(1000)
    expect(captured?.deepeningSearch).toBe(false)
    // Depth reached → it stops paging (the initial read + exactly two pages).
    expect(reads).toHaveLength(3)
    // The deepen is for MATCHING, not for painting. `loadOlder` bumps renderCount
    // by each page's size so a scrolled-to page stays on screen; this must NOT —
    // the 800 new rows stay windowed OUT and the DOM stays at RENDER_WINDOW,
    // instead of growing 800 rows behind a user who only typed in the search box.
    expect(captured?.visibleRows.length).toBe(RENDER_WINDOW)
    expect(captured?.renderStart).toBe(1000 - RENDER_WINDOW)
  })

  it('deepens once per session — a second query does not re-page', async () => {
    act(() => root.render(<Probe active={true} />))
    await act(async () => {
      reads[0]?.resolve({ items: page(1, 200), head: 'c1', tail: 'c200', hasMore: true })
    })
    await flush()

    act(() => captured?.ensureSearchDepth())
    await flush()
    await act(async () => {
      // Disk runs out immediately: an empty page ends the deepen.
      reads[1]?.resolve({ items: [], hasMore: false })
    })
    await flush()
    expect(captured?.hasMoreOlder).toBe(false)
    expect(captured?.deepeningSearch).toBe(false)

    act(() => captured?.ensureSearchDepth())
    await flush()
    expect(reads).toHaveLength(2)
  })

  it('offline write-through keeps its full depth — the read now matches the replica cap', async () => {
    act(() => root.render(<Probe active={true} />))
    await act(async () => {
      reads[0]?.resolve({ items: page(1, 200), head: 'c1', tail: 'c200', hasMore: false })
    })
    await flush()
    // The old 1000-item read was sliced to 200 by REPLICA_TRANSCRIPT_ITEM_CAP, so
    // an offline reopen served 200 then and serves 200 now: no depth was lost.
    expect(fakeReplica.puts.at(-1)?.items).toHaveLength(200)
  })
})
