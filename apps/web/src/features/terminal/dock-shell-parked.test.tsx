// @vitest-environment happy-dom
import { asSessionId, type SessionMeta } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * POD-4429 regression guard: a hibernated dock shell is PARKED, not dead.
 * The dock must not archive it, must not spawn a replacement, and must offer
 * resume of the SAME session id in place.
 */

const createMutate = vi.fn(async () => ({ sessionId: asSessionId('new-shell') }))
const setArchivedMutate = vi.fn(async () => undefined)
const resurrectSession = vi.fn(async () => ({ ok: true }))
const setDockShell = vi.fn()
const setDockVisibleSession = vi.fn()

let storeSessions: SessionMeta[] = []
const dockShells: Record<string, ReturnType<typeof asSessionId>> = {}

const mockState = {
  hub: { subscribeTranscript: () => () => {} },
  trpc: {
    sessions: {
      create: { mutate: createMutate },
      setArchived: { mutate: setArchivedMutate },
    },
  },
  sessions: storeSessions,
  machines: [],
  reposLoaded: true,
  dockShells,
  setDockShell,
  setDockVisibleSession,
  resurrectSession,
  killSession: vi.fn(async () => {}),
  issues: [],
}

vi.mock('@/app/store', () => ({
  useStoreSelector: (sel: (s: unknown) => unknown) => sel(mockState),
  useReplicaIssues: () => [],
}))

vi.mock('@podium/terminal-client-react', () => ({
  useTerminalSession: () => ({
    containerRef: { current: null },
    viewportRef: { current: null },
    mountedRef: { current: null },
    ready: true,
  }),
}))

vi.mock('./use-terminal-appearance', () => ({
  useTerminalAppearance: () => ({
    settings: {},
    appearance: {},
  }),
}))

const { DockShellPanel } = await import('./DockShellPanel')
const lifecycle = await import('./dock-shell-lifecycle')

function shellMeta(over: Omit<Partial<SessionMeta>, 'sessionId'> & { sessionId: string }): SessionMeta {
  const { sessionId, ...rest } = over
  return {
    sessionId: asSessionId(sessionId),
    agentKind: 'shell',
    archived: false,
    status: 'live',
    cwd: '/repo/a',
    ...rest,
  } as unknown as SessionMeta
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  createMutate.mockClear()
  setArchivedMutate.mockClear()
  resurrectSession.mockClear()
  setDockShell.mockClear()
  setDockVisibleSession.mockClear()
  for (const key of Object.keys(dockShells)) delete dockShells[key]
  storeSessions = []
  mockState.sessions = storeSessions
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('POD-4429 parked dock shell', () => {
  it("a hibernated shell is parked, not dead", () => {
    expect(
      lifecycle.dockShellIsDead(shellMeta({ sessionId: 'h', status: 'hibernated' })),
    ).toBe(false)
    expect(lifecycle.dockShellIsParked(shellMeta({ sessionId: 'h', status: 'hibernated' }))).toBe(
      true,
    )
    expect(lifecycle.dockShellIsDead(shellMeta({ sessionId: 'e', status: 'exited' }))).toBe(true)
    expect(
      lifecycle.dockShellIsDead(shellMeta({ sessionId: 'a', status: 'live', archived: true })),
    ).toBe(true)
  })

  it('excludes a parked shell from the stale set the lifecycle would archive', () => {
    const ids = lifecycle.staleDockShellIds(
      { '/repo/a': asSessionId('parked') },
      [shellMeta({ sessionId: 'parked', status: 'hibernated' })],
    )
    expect(ids).toEqual([])
  })

  it('keeps the SAME session id and offers resume instead of spawning', async () => {
    dockShells['/repo/a'] = asSessionId('dock1')
    storeSessions.push(shellMeta({ sessionId: 'dock1', status: 'live' }))
    mockState.sessions = storeSessions

    await act(async () => {
      root.render(<DockShellPanel cwd="/repo/a" />)
    })
    await flush()
    expect(createMutate).not.toHaveBeenCalled()

    // The dock shell goes quiet past the threshold and is parked.
    storeSessions[0] = shellMeta({ sessionId: 'dock1', status: 'hibernated' })
    mockState.sessions = [...storeSessions]
    await act(async () => {
      root.render(<DockShellPanel cwd="/repo/a" />)
    })
    await flush()

    // No replacement is spawned and nothing is archived away.
    expect(createMutate).not.toHaveBeenCalled()
    expect(setArchivedMutate).not.toHaveBeenCalled()
    // The mapping still points at the same session.
    expect(dockShells['/repo/a']).toBe(asSessionId('dock1'))
    // A resume affordance is on screen (the hibernated pane's resume control).
    const resume = container.querySelector('[data-testid="lifecycle-resume"]')
    expect(resume).not.toBeNull()

    // Clicking resume wakes the SAME session id in place.
    await act(async () => {
      ;(resume as HTMLButtonElement)?.click()
      await Promise.resolve()
    })
    expect(resurrectSession).toHaveBeenCalledWith(asSessionId('dock1'))
    expect(setDockShell).not.toHaveBeenCalled()
  })
})
