// @vitest-environment happy-dom

import type {
  ConnectionState,
  SessionCallbacks,
  SocketHub,
} from '@podium/client-core/socket-transport'
import { asSessionId, type SessionId } from '@podium/model'
import type { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSession } from './session-mount'
import { TerminalView } from './terminal-view'

// happy-dom has no ResizeObserver; DomViewportSource needs one to construct.
function withResizeObserver(): void {
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
}

/** Fake hub exposing the legacy reset and authoritative state callbacks. */
function fakeHub() {
  let cbs: SessionCallbacks = {}
  let current: ConnectionState = {
    role: 'controller',
    controllerId: null,
    cols: 80,
    rows: 24,
    epoch: 0,
    connected: true,
  } as ConnectionState
  const connection = {
    sendInput: vi.fn(),
    // POD-3239 B4: the one ask. Inert here — these suites are about frames,
    // readiness and the colour-scheme report, not about sizing.
    sendViewportRequest: vi.fn(),
    state: vi.fn(() => current),
    echoLatency: vi.fn(() => ({ enabled: false })),
    setEchoLatencyEnabled: vi.fn(),
  }
  const hub = {
    attach: vi.fn((_id: string, cb: SessionCallbacks = {}) => {
      cbs = cb
      return connection
    }),
    detach: vi.fn(),
  } as unknown as SocketHub
  return {
    hub,
    connection,
    reset: () => cbs.onReset?.(),
    attached: () => cbs.onAttached?.(),
    frame: (data: string) => cbs.onFrame?.(new TextEncoder().encode(data)),
    // Keep cols/rows at the mounted 80×24 so onState drives only the epoch/clear path,
    // never a view.resize.
    setState: (patch: Partial<ConnectionState>) => {
      current = { ...current, ...patch }
      cbs.onState?.(current as never)
    },
  }
}

// Pictures reset the screen in their own bytes. Only an older server's explicit
// reset callback clears outside that stream; a takeover must leave it readable.
describe('session-mount clear semantics', () => {
  it.each([
    'normal',
    'alternate',
  ] as const)('preserves an idle %s frame and cursor through a server regrid', async (buffer) => {
    withResizeObserver()
    const { hub, setState, attached, frame } = fakeHub()
    const mounted = mountSession(document.createElement('div'), {
      hub,
      sessionId: asSessionId('s1'),
      active: false, // Hidden viewers must preserve the same authoritative picture.
      initialGeometry: { cols: 106, rows: 33 },
    })
    try {
      setState({ cols: 106, rows: 33 })
      attached()
      // A snapshot restores the program's cursor on the middle row. No output
      // follows: geometry alone cannot assume a SIGWINCH repaint will arrive.
      frame(
        `${buffer === 'alternate' ? '\x1b[?1049h' : ''}\x1b[H` +
          'top row\r\nmiddle row\r\nbottom row\x1b[2;5H',
      )
      const term = (mounted.view as unknown as { term: Terminal }).term
      await new Promise<void>((resolve) => term.write('', resolve))
      const rows = () => mounted.view.screenText().split('\n').slice(0, 3)
      expect(rows()).toEqual(['top row', 'middle row', 'bottom row'])

      setState({ rows: 31 })
      setState({ rows: 33 })

      expect(rows()).toEqual(['top row', 'middle row', 'bottom row'])
      expect(term.buffer.active.cursorY).toBe(1)
      expect(term.buffer.active.cursorX).toBe(4)
    } finally {
      mounted.dispose()
    }
  })

  it('keeps the view on an in-session epoch bump (controller takeover)', () => {
    withResizeObserver()
    const clear = vi.spyOn(TerminalView.prototype, 'clear')
    try {
      const { hub, setState } = fakeHub()
      const mounted = mountSession(document.createElement('div'), {
        hub,
        sessionId: asSessionId('s1'),
        active: false,
      })
      setState({ epoch: 0 })
      clear.mockClear()
      setState({ epoch: 1 })
      expect(clear).not.toHaveBeenCalled()
      mounted.dispose()
    } finally {
      clear.mockRestore()
    }
  })

  it('clears on an older server’s explicit reset signal', () => {
    withResizeObserver()
    const clear = vi.spyOn(TerminalView.prototype, 'clear')
    try {
      const { hub, reset } = fakeHub()
      const mounted = mountSession(document.createElement('div'), {
        hub,
        sessionId: asSessionId('s1'),
        active: false,
      })
      clear.mockClear()
      reset()
      expect(clear).toHaveBeenCalledTimes(1)
      mounted.dispose()
    } finally {
      clear.mockRestore()
    }
  })

  it('keeps the view across disconnect and a new epoch on reconnect', () => {
    withResizeObserver()
    const clear = vi.spyOn(TerminalView.prototype, 'clear')
    try {
      const { hub, setState } = fakeHub()
      const mounted = mountSession(document.createElement('div'), {
        hub,
        sessionId: asSessionId('s1'),
        active: false,
      })
      setState({ epoch: 0, connected: true })
      clear.mockClear()
      setState({ epoch: 5, connected: false })
      setState({ epoch: 5, connected: true })
      expect(clear).not.toHaveBeenCalled()
      mounted.dispose()
    } finally {
      clear.mockRestore()
    }
  })

  it('after the attach, the xterm takes EVERY server grid in arrival order — no revision fence (POD-3190 rev 3)', () => {
    // The mount used to drop a state whose `geometryRevision` was lower than
    // one it had seen. The streams are ordered and a reconnect's attach is a
    // full statement, so nothing is stale: an older peer's leftover revision
    // field must not freeze the view.
    withResizeObserver()
    const host = document.createElement('div')
    const onState = vi.fn()
    const { hub, setState, attached } = fakeHub()
    const mounted = mountSession(host, {
      hub,
      sessionId: asSessionId('s1'),
      active: false,
      onState,
    })
    attached()
    setState({ geometryRevision: 2, cols: 100, rows: 30 } as Partial<ConnectionState>)
    onState.mockClear()

    setState({
      geometryRevision: 1,
      cols: 90,
      rows: 28,
      role: 'spectator',
      epoch: 3,
    } as Partial<ConnectionState>)

    expect(mounted.view.cols()).toBe(90)
    expect(mounted.view.rows()).toBe(28)
    expect(host.dataset.role).toBe('spectator')
    expect(host.dataset.epoch).toBe('3')
    expect(onState).toHaveBeenCalled()
    mounted.dispose()
  })
})

describe('session-mount E2E API handle', () => {
  interface TestApi {
    state(): ConnectionState
    grid(): { cols: number; rows: number }
    echoLatency(): unknown
    diagnostics(): unknown[]
    switchTraces(): unknown[]
    screenHash(opts?: { dropDim?: boolean }): string
    screenText(): string
    composerInputReady(kind: string): boolean
    sendInput(data: string): void
    setEchoLatencyEnabled(enabled: boolean): void
    takeControl(): void
    sessions(): readonly { sessionId: SessionId; title: string }[]
    attach(id: SessionId): unknown
    simulateKeyboard(inset: number): void
  }
  const g = globalThis as unknown as { __podium?: TestApi }

  function currentApi(): TestApi {
    const api = g.__podium
    if (!api) throw new Error('Expected an opt-in terminal API')
    return api
  }

  afterEach(() => {
    delete g.__podium
    vi.restoreAllMocks()
  })

  async function flush(mounted: ReturnType<typeof mountSession>): Promise<void> {
    const term = (mounted.view as unknown as { term: Terminal }).term
    await new Promise<void>((resolve) => term.write('', resolve))
  }

  it('refuses every saved hook method after disposing a live terminal buffer', async () => {
    withResizeObserver()
    const a = fakeHub()
    const sessionId = asSessionId('alice-private')
    const testSessions = vi.fn(() => [{ sessionId, title: 'Alice private terminal' }])
    const host = document.createElement('div')
    const mounted = mountSession(host, { hub: a.hub, sessionId, test: true, testSessions })
    try {
      const api = currentApi()
      a.attached()
      a.frame('ALICE_PRIVATE_PTY_MARKER\r\n\x1b[?2004h')
      await flush(mounted)
      const liveText = api.screenText()
      expect(liveText).toContain('ALICE_PRIVATE_PTY_MARKER')
      expect(api.screenHash()).toBe(mounted.view.screenHash())
      expect(api.state()).toBe(a.connection.state())
      expect(api.grid()).toEqual({ cols: 80, rows: 24 })
      expect(api.echoLatency()).toEqual({ enabled: false })
      expect(api.diagnostics().length).toBeGreaterThan(0)
      expect(api.switchTraces()).toEqual([])
      expect(api.composerInputReady('unknown-harness')).toBe(false)
      expect(api.sessions()).toEqual(testSessions())

      // Keep the real xterm buffer; only supply the layout metric happy-dom lacks.
      vi.spyOn(mounted.view, 'proposeFit').mockReturnValue({ cols: 80, rows: 24 })
      api.takeControl()
      expect(a.connection.sendViewportRequest).toHaveBeenCalledWith(
        expect.objectContaining({ claimControl: true }),
      )
      api.sendInput('live Alice input')
      expect(a.connection.sendInput).toHaveBeenCalledWith('live Alice input', undefined)
      api.setEchoLatencyEnabled(true)
      expect(a.connection.setEchoLatencyEnabled).toHaveBeenCalledWith(true)
      expect(api.attach(asSessionId('live-extra'))).toBe(a.connection)
      api.simulateKeyboard(100)
      expect(host.style.height).not.toBe('')

      // Copy function references before teardown: deleting/replacing the global alone
      // cannot revoke these saved readers or input/attach/control capabilities.
      const saved = { ...api }
      const calls: Record<keyof TestApi, () => unknown> = {
        state: saved.state,
        grid: saved.grid,
        echoLatency: saved.echoLatency,
        diagnostics: saved.diagnostics,
        switchTraces: saved.switchTraces,
        screenHash: () => saved.screenHash({ dropDim: true }),
        screenText: saved.screenText,
        composerInputReady: () => saved.composerInputReady('codex'),
        sendInput: () => saved.sendInput('stale Alice input'),
        setEchoLatencyEnabled: () => saved.setEchoLatencyEnabled(false),
        takeControl: saved.takeControl,
        sessions: saved.sessions,
        attach: () => saved.attach(asSessionId('stale-attach')),
        simulateKeyboard: () => saved.simulateKeyboard(0),
      }
      mounted.dispose()
      vi.clearAllMocks()
      const heightAfterDispose = host.style.height
      const observations = Object.fromEntries(
        Object.entries(calls).map(([name, call]) => {
          try {
            return [name, { value: call() }]
          } catch (error) {
            return [name, { error: String(error) }]
          }
        }),
      )
      console.info(
        'terminal-hook disposal observations',
        JSON.stringify({ liveText, globalRemoved: g.__podium === undefined, observations }),
      )
      for (const [name, result] of Object.entries(observations)) {
        expect.soft(result, `saved ${name}`).toEqual({ error: expect.stringMatching(/disposed/i) })
      }
      expect.soft(g.__podium).toBeUndefined()
      expect.soft(a.hub.attach).not.toHaveBeenCalled()
      expect.soft(a.connection.state).not.toHaveBeenCalled()
      expect.soft(a.connection.sendInput).not.toHaveBeenCalled()
      expect.soft(a.connection.sendViewportRequest).not.toHaveBeenCalled()
      expect.soft(a.connection.setEchoLatencyEnabled).not.toHaveBeenCalled()
      expect.soft(a.connection.echoLatency).not.toHaveBeenCalled()
      expect.soft(testSessions).not.toHaveBeenCalled()
      expect.soft(host.style.height).toBe(heightAfterDispose)
    } finally {
      mounted.dispose()
    }
  })

  it('retires its owned global and saved reader before detaching resources', async () => {
    withResizeObserver()
    const a = fakeHub()
    const mounted = mountSession(document.createElement('div'), {
      hub: a.hub,
      sessionId: asSessionId('alice-teardown'),
      test: true,
      active: false,
    })
    try {
      const api = currentApi()
      a.frame('ALICE_TEARDOWN_MARKER')
      await flush(mounted)
      expect(api.screenText()).toContain('ALICE_TEARDOWN_MARKER')
      const atDetach: unknown[] = []
      vi.mocked(a.hub.detach).mockImplementation(() => {
        atDetach.push(g.__podium)
        try {
          atDetach.push(api.screenText())
        } catch (error) {
          atDetach.push(String(error))
        }
      })
      mounted.dispose()
      expect(atDetach).toEqual([undefined, expect.stringMatching(/disposed/i)])
      expect(g.__podium).toBeUndefined()
    } finally {
      mounted.dispose()
    }
  })

  it('preserves a newer pane handle when an old pane is disposed or reactivated late', async () => {
    withResizeObserver()
    const a = fakeHub()
    const b = fakeHub()
    const mountedA = mountSession(document.createElement('div'), {
      hub: a.hub,
      sessionId: asSessionId('old-alice'),
      test: true,
      active: false,
    })
    const apiA = currentApi()
    const mountedB = mountSession(document.createElement('div'), {
      hub: b.hub,
      sessionId: asSessionId('new-bob'),
      test: true,
    })
    try {
      const apiB = currentApi()
      a.frame('ALICE_OLD_PANE_MARKER')
      b.frame('BOB_NEW_PANE_MARKER')
      await flush(mountedA)
      await flush(mountedB)
      expect(apiA.screenText()).toContain('ALICE_OLD_PANE_MARKER')
      expect(apiB.screenText()).toContain('BOB_NEW_PANE_MARKER')

      mountedA.dispose()
      expect(g.__podium).toBe(apiB)
      expect(apiB.screenText()).toContain('BOB_NEW_PANE_MARKER')
      apiB.sendInput('live Bob input')
      expect(b.connection.sendInput).toHaveBeenCalledWith('live Bob input', undefined)

      // A late activation callback must not republish a retired API over Bob's.
      mountedA.setActive(true)
      expect(g.__podium).toBe(apiB)
      mountedA.dispose()
      expect(g.__podium).toBe(apiB)
      expect(() => apiA.screenText()).toThrow(/disposed/i)
      mountedB.dispose()
      expect(g.__podium).toBeUndefined()
    } finally {
      mountedA.dispose()
      mountedB.dispose()
    }
  })

  it('retargets the opt-in E2E API to whichever warm pane becomes active', () => {
    withResizeObserver()
    let synced = [{ sessionId: asSessionId('a'), title: 'Synced title' }]
    const a = fakeHub()
    const b = fakeHub()
    const mountedA = mountSession(document.createElement('div'), {
      hub: a.hub,
      sessionId: asSessionId('a'),
      test: true,
      testSessions: () => synced,
      active: true,
    })
    const apiA = g.__podium
    expect(apiA).toBeTruthy()
    expect(apiA?.sessions()).toBe(synced)
    synced = [{ sessionId: asSessionId('a'), title: 'Updated from sync' }]
    expect(apiA?.sessions()).toBe(synced)

    // A second warm (hidden) pane mounts and claims the shared handle.
    const mountedB = mountSession(document.createElement('div'), {
      hub: b.hub,
      sessionId: asSessionId('b'),
      test: true,
      active: false,
    })

    // Re-activating A must point the handle back at A's session…
    mountedA.setActive(false)
    mountedA.setActive(true)
    expect(g.__podium).toBe(apiA)

    // …and activating B retargets it to B (the pane a real click brought forward).
    mountedB.setActive(true)
    expect(g.__podium).not.toBe(apiA)

    mountedA.dispose()
    mountedB.dispose()
  })
})
