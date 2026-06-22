import type { TranscriptItem } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Pins the delta-accumulation contract of SuperagentView's <SpawnedFollow>, the
// inline live-tail for spawned workers. The hub now forwards per-frame DELTAS
// (not the full accumulated list); a "treat the delta as the full list" mistake
// here would render only the LATEST delta. We mount the component with a fake
// hub that captures the cb, push delta frames, and assert what renders.
//
// markdown/voice touch browser APIs that are flaky under happy-dom, and store
// has module-load deps — stub them the same way ChatView.test.tsx does so the
// import of ./SuperagentView is side-effect-free.
// ---------------------------------------------------------------------------

type DeltaCb = (items: TranscriptItem[], meta: { reset: boolean }) => void

const fakeHub = {
  subscribes: [] as Array<{ sessionId: string; since: string | undefined; cb: DeltaCb }>,
  subscribeTranscript(sessionId: string, since: string | undefined, cb: DeltaCb): () => void {
    this.subscribes.push({ sessionId, since, cb })
    return () => {}
  },
}

vi.mock('./store', () => ({
  useStore: () => ({ hub: fakeHub }),
}))
vi.mock('./voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))
vi.mock('./markdown', () => ({ renderMarkdown: (t: string) => `<p>${t}</p>` }))

const { SpawnedFollow } = await import('./SuperagentView')

function item(id: string, cursor: string, text: string): TranscriptItem {
  return { id, cursor, role: 'assistant', text }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  fakeHub.subscribes.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('SpawnedFollow delta accumulation', () => {
  it('ACCUMULATES items across two non-reset delta frames (second does not replace first)', () => {
    act(() => {
      root.render(<SpawnedFollow sessionId="s1" hub={fakeHub as never} />)
    })
    expect(fakeHub.subscribes).toHaveLength(1)
    expect(fakeHub.subscribes[0]).toMatchObject({ sessionId: 's1' })
    const cb = fakeHub.subscribes[0]?.cb
    // Frame 1: one item.
    act(() => {
      cb?.([item('a', 'c1', 'first frame line')], { reset: false })
    })
    expect(container.textContent).toContain('first frame line')
    // Frame 2: a SECOND delta. The regression ("delta = full list") would render
    // only this frame and drop the first — assert BOTH are present.
    act(() => {
      cb?.([item('b', 'c2', 'second frame line')], { reset: false })
    })
    expect(container.textContent).toContain('first frame line')
    expect(container.textContent).toContain('second frame line')
  })

  it('a reset frame REPLACES the buffer — only the reset frame content remains', () => {
    act(() => {
      root.render(<SpawnedFollow sessionId="s1" hub={fakeHub as never} />)
    })
    const cb = fakeHub.subscribes[0]?.cb
    act(() => {
      cb?.([item('a', 'c1', 'old content')], { reset: false })
    })
    expect(container.textContent).toContain('old content')
    // A reset (file roll / reattach re-seed) clears the local buffer.
    act(() => {
      cb?.([item('z', 'c9', 'fresh content')], { reset: true })
    })
    expect(container.textContent).toContain('fresh content')
    expect(container.textContent).not.toContain('old content')
  })

  it('dedupes a delta item already held (live repeats the tail) — no duplicate row', () => {
    act(() => {
      root.render(<SpawnedFollow sessionId="s1" hub={fakeHub as never} />)
    })
    const cb = fakeHub.subscribes[0]?.cb
    act(() => {
      cb?.([item('a', 'c1', 'alpha')], { reset: false })
    })
    // Overlapping delta: repeats c1 plus a genuinely new c2.
    act(() => {
      cb?.([item('a', 'c1', 'alpha'), item('b', 'c2', 'bravo')], { reset: false })
    })
    expect(container.textContent).toContain('bravo')
    const occurrences = (container.textContent?.split('alpha').length ?? 0) - 1
    expect(occurrences).toBe(1)
  })
})
