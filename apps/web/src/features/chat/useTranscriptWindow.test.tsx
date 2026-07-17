import { beginSwitch, getRecentSwitchTraces, resetSwitchTraces } from '@podium/client-core/perf'
import type { SessionMeta, TranscriptItem } from '@podium/protocol'
import type { JSX } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// react-dom's act() needs this flag to drive effects/rAF flushes without warnings.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import {
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
  subscribes: [] as Array<{ sessionId: string; since: string | undefined; cb: DeltaCb }>,
  subscribeTranscript(sessionId: string, since: string | undefined, cb: DeltaCb): () => void {
    this.subscribes.push({ sessionId, since, cb })
    return () => {}
  },
}

interface ReadCall {
  input: { sessionId: string; anchor?: string; direction: 'before' | 'after'; limit: number }
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

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: 's1',
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
  }
}

function item(id: string, cursor: string, text: string): TranscriptItem {
  return { id, cursor, role: 'assistant', text }
}

let captured: UseTranscriptWindowResult | null = null

function Probe({ active }: { active: boolean }): JSX.Element | null {
  const scrollerRef = { current: null }
  captured = useTranscriptWindow({
    sessionId: 's1',
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
    beginSwitch({ sessionId: 's1' })
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

    beginSwitch({ sessionId: 's1' })
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

    beginSwitch({ sessionId: 's1' })
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

    beginSwitch({ sessionId: 's1' })
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

    beginSwitch({ sessionId: 's1' })
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
