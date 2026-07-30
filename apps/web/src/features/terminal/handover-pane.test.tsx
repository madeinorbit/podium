// @vitest-environment happy-dom
import { asSessionId, type SessionMeta, type SessionMetaInput } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The move parks the session server-side, so the panel under test would fall
// through to the parked-transcript view — the flicker POD-337 removes. This
// suite drives the panel through a whole move (transit → arrival → dissolve) and
// through a failed one (rolled back to the source).

vi.mock('@podium/terminal-client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    mountSession: () => ({
      connection: {
        state: () => ({ role: 'controller' }),
        sendInput: vi.fn(),
        requestControl: vi.fn(),
      },
      view: {
        setFileLinks: vi.fn(),
        setRefLinks: vi.fn(),
        onScroll: () => () => {},
        atBottom: () => true,
        focus: vi.fn(),
        screenText: () => '',
        scrollToBottom: vi.fn(),
        requestPaste: vi.fn(),
        fit: () => null,
      },
      setActive: vi.fn(),
      setAppearance: vi.fn(),
      dispose: vi.fn(),
    }),
  }
})

vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))
vi.mock('@/lib/voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))

let storeSessions: SessionMeta[] = []
const fakeHub = { subscribeTranscript: (): (() => void) => () => {} }
const fakeTrpc = {
  settings: {
    get: { query: vi.fn(async () => ({ sessionDefaults: { startScreen: 'native' as const } })) },
  },
}
const stableStoreFns = {
  startBtw: vi.fn(async () => {}),
  setSessionDraft: vi.fn(),
  hibernateSession: vi.fn(async () => {}),
  openFile: vi.fn(),
  setPanelMode: vi.fn(),
  setPanelRenderMode: vi.fn(),
  uiState: { get: () => null, set: () => {}, subscribe: () => () => {} },
  resurrectSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
}
vi.mock('@/app/store', () => {
  const useStore = () => ({
    hub: fakeHub,
    sessions: storeSessions,
    machines: [],
    pendingSpawnIds: new Set<string>(),
    repos: [],
    trpc: fakeTrpc,
    drafts: {},
    panelMode: { s1: 'native' as const },
    ...stableStoreFns,
  })
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

const { AgentPanel } = await import('./AgentPanel')
const { HANDOVER_ARRIVED_HOLD_MS, formatHandoverElapsed } = await import('./HandoverPane')

function meta(over: Partial<SessionMetaInput>): SessionMeta {
  return {
    sessionId: asSessionId('s1'),
    agentKind: 'claude-code',
    title: 't',
    cwd: '/w',
    status: 'live',
    controllerId: 'c0',
    machineId: 'm-home',
    machineName: 'podium-local',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-07-25T00:00:00.000Z',
    lastActiveAt: '2026-07-25T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    transcriptAvailable: true,
    resumable: true,
    ...over,
  } as unknown as SessionMeta
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  storeSessions = [meta({})]
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(<AgentPanel sessionId={asSessionId('s1')} active />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function setSession(over: Partial<SessionMetaInput>): Promise<void> {
  storeSessions = [meta(over)]
  await render()
}

function pane(): HTMLElement | null {
  return container.querySelector('[data-testid="handover-pane"]')
}

describe('handover takeover', () => {
  it('covers the pane while the session is in flight, instead of the parked transcript', async () => {
    // The server parks the session as part of the move, which is exactly the
    // state that used to flip the panel into its read-only chat view.
    await setSession({ status: 'hibernated', handoffTarget: 'hetzner-vps' })

    expect(pane()?.textContent).toContain('Handing over to hetzner-vps')
    expect(container.textContent).not.toContain('Hibernated —')
  })

  it('names both ends of the move', async () => {
    await setSession({ handoffTarget: 'hetzner-vps' })

    const text = pane()?.textContent ?? ''
    expect(text).toContain('podium-local')
    expect(text).toContain('hetzner-vps')
  })

  it('confirms the arrival, then dissolves into the reattached terminal', async () => {
    vi.useFakeTimers()
    try {
      await setSession({ handoffTarget: 'hetzner-vps' })
      // The move landed: the server clears the overlay and the session's machine
      // is the target it was sent to.
      await setSession({ status: 'starting', machineId: 'm-vps', machineName: 'hetzner-vps' })

      expect(pane()?.textContent).toContain('Resumed on hetzner-vps')

      await act(async () => {
        vi.advanceTimersByTime(HANDOVER_ARRIVED_HOLD_MS + 50)
      })
      expect(pane()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('claims no arrival when the move failed and the session rolled back', async () => {
    await setSession({ handoffTarget: 'hetzner-vps' })
    // Rollback: the overlay is gone but the session never left its machine.
    await setSession({ status: 'hibernated', machineName: 'podium-local' })

    expect(pane()).toBeNull()
  })
})

describe('formatHandoverElapsed', () => {
  it('pads seconds so the column never jumps', () => {
    expect(formatHandoverElapsed(0)).toBe('0:00')
    expect(formatHandoverElapsed(9)).toBe('0:09')
    expect(formatHandoverElapsed(75)).toBe('1:15')
  })
})
