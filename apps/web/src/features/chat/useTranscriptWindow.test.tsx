import {
  beginSwitch,
  getRecentSwitchTraces,
  markSwitch,
  resetSwitchTraces,
} from '@podium/client-core/perf'
import {
  asSessionId,
  type SessionId,
  type SessionMeta,
  type SessionMetaInput,
  type TranscriptItem,
} from '@podium/model'
import type { JSX } from 'react'
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// react-dom's act() needs this flag to drive effects/rAF flushes without warnings.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import {
  LIVE_HEARTBEAT_MS,
  RENDER_WINDOW,
  type UseTranscriptWindowOptions,
  type UseTranscriptWindowResult,
  useTranscriptWindow,
} from './useTranscriptWindow'

// ---------------------------------------------------------------------------
// POD-725: a warm chat panel that stays mounted (with a live delta subscription)
// must NOT re-read its transcript window on every re-activation. These tests
// drive the hook directly with controllable hub/tRPC/replica fakes and assert
// both the read behaviour and the switch-trace lifecycle marks (chat:cache-hit +
// chat:first-paint on a skipped-read activation; ChatView's DOM-level
// chat:interactable sentinel is supplied by the test harness helper).
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

function Probe({
  active,
  session = meta({}),
  deferInitialRead = false,
}: {
  active: boolean
  /** Overridable so the liveness tests below can move the session row's
   *  activity fingerprint (POD-701) between renders. */
  session?: SessionMeta
  deferInitialRead?: boolean
}): JSX.Element | null {
  const scrollerRef = { current: null }
  captured = useTranscriptWindow({
    sessionId: asSessionId('s1'),
    hub: fakeHub,
    trpc: fakeTrpc,
    replica: fakeReplica,
    active,
    session,
    deferInitialRead,
    scrollerRef,
  } as unknown as UseTranscriptWindowOptions)
  return null
}

let container: HTMLDivElement
let root: Root
let visibility: DocumentVisibilityState

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
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
  vi.restoreAllMocks()
  vi.useRealTimers()
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
  // The hook-only probe has no ChatView/DOM composer to produce the real
  // sentinel. Keep these lifecycle tests focused on window reuse and provide
  // the same settled-chat boundary explicitly.
  markSwitch(asSessionId('s1'), 'chat:interactable', {
    composerEnabled: true,
    composerFocusable: true,
    transcriptCommitted: true,
  })
}

function lastTraceMarks(): string[] {
  const t = getRecentSwitchTraces().at(-1)
  return t ? t.marks.map((m) => m.name) : []
}

describe('useTranscriptWindow optimistic session boundary', () => {
  it('keeps the transcript live after root StrictMode rehearses its effect', async () => {
    act(() =>
      root.render(
        <StrictMode>
          <Probe active />
        </StrictMode>,
      ),
    )
    expect(reads).toHaveLength(2)

    await act(async () => {
      reads[0]?.resolve({ items: [item('stale', 'c1', 'stale')], hasMore: false })
      reads[1]?.resolve({
        items: [item('mounted', 'c2', 'mounted')],
        head: 'c2',
        tail: 'c2',
        hasMore: false,
      })
    })
    await flush()

    expect(captured?.initialLoaded).toBe(true)
    expect(captured?.blocks.map((block) => block.item.id)).toEqual(['mounted'])
    expect(fakeHub.subscribes).toHaveLength(1)
  })

  it('waits for server truth before spending the initial read and subscription', async () => {
    act(() => root.render(<Probe active deferInitialRead />))
    expect(reads).toHaveLength(0)
    expect(fakeHub.subscribes).toHaveLength(0)

    act(() => root.render(<Probe active deferInitialRead={false} />))
    expect(reads).toHaveLength(1)
    await act(async () => {
      reads[0]?.resolve({ items: [], hasMore: false })
    })
    await flush()

    expect(fakeHub.subscribes).toHaveLength(1)
  })
})

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

  // POD-1132: an older page is anchored to the head of the window that asked for
  // it. If a tail re-read replaces that window while the page is in flight, the
  // page ends where the OLD head was and the new window starts later — prepending
  // joins them into a list with a silent span missing, which no guard downstream
  // can see (they share no cursors, so every item looks legitimately fresh).
  it('drops an older page whose window was replaced while it was in flight', async () => {
    act(() => root.render(<Probe active={true} />))
    await act(async () => {
      reads[0]?.resolve({
        items: [item('h', 'c5', 'held head'), item('t', 'c6', 'held tail')],
        head: 'c5',
        tail: 'c6',
        hasMore: true,
      })
    })
    await flush()

    // Page up (in flight), then a tail re-read lands FIRST and moves the head
    // forward past the page's far end.
    act(() => captured?.loadOlder())
    expect(reads[1]?.input.anchor).toBe('c5')
    act(() => {
      root.render(
        <Probe active={true} session={meta({ lastActiveAt: '2026-06-03T00:09:00.000Z' })} />,
      )
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450))
    })
    await act(async () => {
      reads[2]?.resolve({
        items: [item('n', 'c9', 'new head')],
        head: 'c9',
        tail: 'c9',
        hasMore: true,
      })
    })
    await flush()

    // The page finally answers, against a window that no longer exists.
    await act(async () => {
      reads[1]?.resolve({ items: [item('o', 'c1', 'stale page')], head: 'c1', hasMore: true })
    })
    await flush()
    expect(captured?.blocks.map((b) => b.item.text)).toEqual(['new head'])
    // The affordance survives, so scrolling up re-pages from the head that is
    // actually there.
    expect(captured?.hasMoreOlder).toBe(true)
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

// ---------------------------------------------------------------------------
// POD-701: the feed must not go quiet. Live deltas are the fast path, but when
// one is dropped the chat used to sit there showing nothing while the sidebar —
// driven by the same session rows — visibly ticked over, and the only recourse
// was to leave the pane and come back (an unmount forces a fresh read). The
// window now reconciles against the session row's own activity fingerprint.
// ---------------------------------------------------------------------------
describe('useTranscriptWindow liveness reconcile (POD-701)', () => {
  /** Advance past the 400ms trailing debounce on the activity signal. */
  async function settleDebounce(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450))
    })
  }

  async function mountLoaded(session?: SessionMeta): Promise<void> {
    act(() => root.render(<Probe active={true} session={session ?? meta({})} />))
    await act(async () => {
      reads[0]?.resolve({
        items: [item('a', 'c1', 'first')],
        head: 'c1',
        tail: 'c1',
        hasMore: false,
      })
    })
    await flush()
  }

  it('re-reads when the session row says there has been activity the feed did not see', async () => {
    await mountLoaded()
    expect(reads).toHaveLength(1)

    // The agent worked; no delta arrived. The row moved anyway.
    act(() => {
      root.render(
        <Probe active={true} session={meta({ lastActiveAt: '2026-06-03T00:05:00.000Z' })} />,
      )
    })
    await settleDebounce()
    expect(reads).toHaveLength(2)
  })

  it('debounces a burst of row updates into ONE read', async () => {
    await mountLoaded()
    for (const minute of [1, 2, 3]) {
      act(() => {
        root.render(
          <Probe
            active={true}
            session={meta({ lastActiveAt: `2026-06-03T00:0${minute}:00.000Z` })}
          />,
        )
      })
    }
    await settleDebounce()
    expect(reads).toHaveLength(2)
  })

  it('lets a delivered live delta satisfy the matching activity update', async () => {
    await mountLoaded()
    act(() => {
      root.render(
        <Probe active={true} session={meta({ lastActiveAt: '2026-06-03T00:05:00.000Z' })} />,
      )
    })
    act(() => {
      fakeHub.subscribes[0]?.cb([item('b', 'c2', 'arrived live')], { reset: false })
    })
    await settleDebounce()

    expect(reads).toHaveLength(1)
    expect(captured?.blocks.map((b) => b.item.id)).toEqual(['a', 'b'])
  })

  it('uses a single-flight one-item heartbeat and expands only when the tail changed', async () => {
    vi.useFakeTimers()
    await mountLoaded()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS)
    })
    expect(reads).toHaveLength(2)
    expect(reads[1]?.input.limit).toBe(1)

    // Several timer ticks while the daemon is slow must not queue more reads.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS * 3)
    })
    expect(reads).toHaveLength(2)

    await act(async () => {
      reads[1]?.resolve({ items: [item('a', 'c1', 'first')], tail: 'c1', hasMore: true })
    })
    await flush()
    expect(reads).toHaveLength(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS)
    })
    expect(reads[2]?.input.limit).toBe(1)
    await act(async () => {
      reads[2]?.resolve({
        items: [item('b', 'c2', 'missed by the live feed')],
        tail: 'c2',
        hasMore: true,
      })
    })
    await flush()

    expect(reads[3]?.input.limit).toBe(200)
    await act(async () => {
      reads[3]?.resolve({
        items: [item('a', 'c1', 'first'), item('b', 'c2', 'missed by the live feed')],
        head: 'c1',
        tail: 'c2',
        hasMore: false,
      })
    })
    await flush()
    expect(captured?.blocks.map((b) => b.item.id)).toEqual(['a', 'b'])
  })

  it('pauses the heartbeat while hidden, refreshes once on return, then resumes', async () => {
    vi.useFakeTimers()
    await mountLoaded()

    act(() => setVisibility('hidden'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS * 3)
    })
    expect(reads).toHaveLength(1)

    act(() => setVisibility('visible'))
    expect(reads).toHaveLength(2)
    expect(reads[1]?.input.limit).toBe(200)

    // The forced visibility read owns catch-up, so heartbeat ticks do not stack
    // probes behind it while the daemon is still responding.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS * 3)
    })
    expect(reads).toHaveLength(2)

    await act(async () => {
      reads[1]?.resolve({
        items: [item('a', 'c1', 'first')],
        head: 'c1',
        tail: 'c1',
        hasMore: false,
      })
    })
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS)
    })
    expect(reads).toHaveLength(3)
    expect(reads[2]?.input.limit).toBe(1)
  })

  it('does not re-read while the pane is in the BACKGROUND — only the foreground pays', async () => {
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
    act(() => {
      root.render(
        <Probe active={false} session={meta({ lastActiveAt: '2026-06-03T00:05:00.000Z' })} />,
      )
    })
    await settleDebounce()
    expect(reads).toHaveLength(1)
  })

  it('leaves POD-725 intact: a warm activation that reused its window does not read 400ms later', async () => {
    // Load in the background so the window is healthy, then activate. The
    // activation cache-hit must NOT be undone by the liveness reconcile.
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
    act(() => root.render(<Probe active={true} />))
    await flush()
    expect(reads).toHaveLength(1)
    await settleDebounce()
    expect(reads).toHaveLength(1)
  })

  it('a reconcile that finds nothing new keeps the SAME rows array — no re-render, no re-derive', async () => {
    await mountLoaded()
    const rowsBefore = captured?.rows
    act(() => {
      root.render(
        <Probe active={true} session={meta({ lastActiveAt: '2026-06-03T00:05:00.000Z' })} />,
      )
    })
    await settleDebounce()
    await act(async () => {
      reads[1]?.resolve({
        items: [item('a', 'c1', 'first')],
        head: 'c1',
        tail: 'c1',
        hasMore: false,
      })
    })
    await flush()
    expect(captured?.rows).toBe(rowsBefore)
  })

  it('a reconcile that finds a new item lands it', async () => {
    await mountLoaded()
    act(() => {
      root.render(
        <Probe active={true} session={meta({ lastActiveAt: '2026-06-03T00:05:00.000Z' })} />,
      )
    })
    await settleDebounce()
    await act(async () => {
      reads[1]?.resolve({
        items: [item('a', 'c1', 'first'), item('b', 'c2', 'the delta that never arrived')],
        head: 'c1',
        tail: 'c2',
        hasMore: false,
      })
    })
    await flush()
    expect(captured?.blocks.map((b) => b.item.id)).toEqual(['a', 'b'])
  })

  /** Load one older page: the pane now holds history a tail re-read would drop.
   *  `active` so the reconcile and heartbeat are otherwise eligible to run. */
  async function pageHistoryIn(active = true): Promise<void> {
    act(() => root.render(<Probe active={active} />))
    await act(async () => {
      // hasMore: there IS history on disk to page back into.
      reads[0]?.resolve({
        items: [item('a', 'c1', 'first')],
        head: 'c1',
        tail: 'c1',
        hasMore: true,
      })
    })
    await flush()
    // Scroll-up back-page: an older page lands ABOVE the held window.
    act(() => captured?.loadOlder())
    await act(async () => {
      reads[1]?.resolve({ items: [item('z', 'c0', 'older')], head: 'c0', hasMore: false })
    })
    await flush()
    expect(captured?.blocks.map((b) => b.item.id)).toEqual(['z', 'a'])
  }

  it('stands down once the reader has paged HISTORY in — a tail re-read would drop it', async () => {
    await pageHistoryIn()

    // The agent keeps working. The reconcile must NOT fire: `readNewest` clears
    // `older`, which would delete the history under the reader's scroll.
    act(() => {
      root.render(
        <Probe active={true} session={meta({ lastActiveAt: '2026-06-03T00:09:00.000Z' })} />,
      )
    })
    await settleDebounce()
    expect(reads).toHaveLength(2)
    expect(captured?.blocks.map((b) => b.item.id)).toEqual(['z', 'a'])
  })

  it('holds the heartbeat off a reader in history too — the probe escalates into that read', async () => {
    vi.useFakeTimers()
    await pageHistoryIn()
    expect(reads).toHaveLength(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_HEARTBEAT_MS * 3)
    })
    expect(reads).toHaveLength(2)
  })

  // POD-1132: the stand-down above is a PAUSE, not a latch. `older` is only ever
  // cleared by a tail re-read, so while the pane sits there the suppressing
  // condition is the only thing the suppressed read could clear. Its escape has
  // always been the next activation — which POD-725 taught to skip the read,
  // turning the pause into a silence for the rest of the mount.
  it('recovers a paged-back pane on the next reveal when it has fallen behind', async () => {
    await pageHistoryIn(false)
    act(() => root.render(<Probe active={false} />))
    await flush()

    // Revealed onto a row that moved with nothing delivered to explain it.
    act(() => {
      root.render(
        <Probe active={true} session={meta({ lastActiveAt: '2026-06-03T00:09:00.000Z' })} />,
      )
    })
    await flush()
    expect(reads[2]?.input.limit).toBe(1)
    await act(async () => {
      reads[2]?.resolve({ items: [item('b', 'c2', 'missed')], tail: 'c2', hasMore: true })
    })
    await flush()
    expect(reads[3]?.input.limit).toBe(200)
  })

  it('leaves a paged-back pane alone on a reveal it has NOT fallen behind on', async () => {
    await pageHistoryIn(false)
    act(() => root.render(<Probe active={true} />))
    await flush()
    await settleDebounce()
    // Still the initial read plus the one older page — the reader keeps both.
    expect(reads).toHaveLength(2)
    expect(captured?.blocks.map((b) => b.item.id)).toEqual(['z', 'a'])
  })
})

// ---------------------------------------------------------------------------
// POD-1132: a warm reveal reuses its window on the strength of an INTACT
// subscription, but `stream.live` is lossy by design — intact is not current.
// The session row is the free evidence that tells the two apart.
// ---------------------------------------------------------------------------
describe('useTranscriptWindow warm reveal over a subscription that fell behind', () => {
  /** Past the 400ms liveness debounce, so a read it wanted has had its chance. */
  async function settleDebounce(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450))
    })
  }

  async function loadedInBackground(): Promise<void> {
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
  }

  it('probes the tail when the row moved while hidden and no delta explained it', async () => {
    await loadedInBackground()

    // Revealed onto a row that has advanced since the read, with nothing
    // delivered on the subscription to account for it.
    act(() => {
      root.render(
        <Probe active={true} session={meta({ lastActiveAt: '2026-06-03T00:05:00.000Z' })} />,
      )
    })
    await flush()

    // The one-item probe, not the 200-item read POD-725 exists to avoid.
    expect(reads).toHaveLength(2)
    expect(reads[1]?.input.limit).toBe(1)
    expect(captured?.transcriptFreshness).toBe('checking')

    // Disk really is ahead → the probe escalates and the missed item lands.
    await act(async () => {
      reads[1]?.resolve({
        items: [item('b', 'c2', 'missed while hidden')],
        tail: 'c2',
        hasMore: true,
      })
    })
    await flush()
    expect(reads[2]?.input.limit).toBe(200)
    expect(captured?.transcriptFreshness).toBe('checking')
    await act(async () => {
      reads[2]?.resolve({
        items: [item('a', 'c1', 'first'), item('b', 'c2', 'missed while hidden')],
        head: 'c1',
        tail: 'c2',
        hasMore: false,
      })
    })
    await flush()
    expect(captured?.blocks.map((b) => b.item.id)).toEqual(['a', 'b'])
    expect(captured?.transcriptFreshness).toBeNull()
  })

  it('does not chase the same signal twice — the probe stands in for the 400ms reconcile', async () => {
    await loadedInBackground()
    act(() => {
      root.render(
        <Probe active={true} session={meta({ lastActiveAt: '2026-06-03T00:05:00.000Z' })} />,
      )
    })
    await flush()
    expect(reads).toHaveLength(2)
    await settleDebounce()
    expect(reads).toHaveLength(2)
  })

  // A stamp claims "the window was current as of this row state". A probe that
  // REJECTED proved nothing, so leaving the claim standing would re-create the
  // original bug on the failure path: the next reveal compares equal and skips,
  // while the heartbeat needs a live session and the 400ms reconcile needs the
  // row to move again — neither of which a finished session offers.
  it('withdraws the stamp when the probe fails, so the next reveal retries', async () => {
    await loadedInBackground()
    const moved = meta({ lastActiveAt: '2026-06-03T00:05:00.000Z' })
    act(() => root.render(<Probe active={true} session={moved} />))
    await flush()
    expect(reads).toHaveLength(2)
    await act(async () => {
      reads[1]?.reject(new Error('offline'))
    })
    await flush()

    // Hide and reveal again over the SAME (now motionless) row: nothing else can
    // trigger a read, so a surviving stamp would leave the pane stale forever.
    act(() => root.render(<Probe active={false} session={moved} />))
    await flush()
    act(() => root.render(<Probe active={true} session={moved} />))
    await flush()
    expect(reads).toHaveLength(3)
    expect(reads[2]?.input.limit).toBe(1)
  })

  it('still skips outright when the row has not moved since the read', async () => {
    await loadedInBackground()
    act(() => root.render(<Probe active={true} />))
    await flush()
    await settleDebounce()
    expect(reads).toHaveLength(1)
  })

  it('a delta delivered while hidden accounts for the row, so the reveal skips', async () => {
    await loadedInBackground()
    act(() => {
      root.render(
        <Probe active={false} session={meta({ lastActiveAt: '2026-06-03T00:05:00.000Z' })} />,
      )
    })
    act(() => {
      fakeHub.subscribes[0]?.cb([item('b', 'c2', 'arrived live')], { reset: false })
    })
    await flush()
    act(() => {
      root.render(
        <Probe active={true} session={meta({ lastActiveAt: '2026-06-03T00:05:00.000Z' })} />,
      )
    })
    await flush()
    await settleDebounce()
    expect(reads).toHaveLength(1)
  })
})
