import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './context'
import { sessionHandlers } from './session'

const SESSION = asSessionId('11111111-1111-4111-8111-111111111111')

function world() {
  const attach = vi.fn(async () => ({
    kind: 'client' as const,
    placement: 'on-machine' as const,
    stream: { id: SESSION },
    warm: { ttlMs: 1_000 },
  }))
  const release = vi.fn(async () => {})
  const clientTerminals = {
    attach: vi.fn(),
    adopt: vi.fn(),
    close: vi.fn(async () => {}),
    viewers: vi.fn(),
    input: vi.fn(() => false),
    resize: vi.fn(() => false),
    redraw: vi.fn(() => false),
    reclaimable: vi.fn(() => 0),
    reclaimUnwatched: vi.fn(async () => 0),
  }
  const handle = {
    binding: { family: 'server', driver: 'opencode-server' },
    attach,
    lease: { release },
  }
  const ctx = {
    outputScheduler: { setPriority: vi.fn() },
    clientTerminals,
    nativeClientRequests: new Set([SESSION]),
    nativeClientTransitions: new Map(),
    pendingResizes: new Map(),
    agentRuntime: { handleFor: (id: string) => (id === SESSION ? handle : undefined) },
    bridges: new Map(),
    observers: { recordInputOrigin: vi.fn() },
    composerEngine: { onInputByte: vi.fn(), onResize: vi.fn() },
  } as unknown as DaemonContext
  return { ctx, attach, release, clientTerminals }
}

describe('server-family native client control', () => {
  it('attaches on a native view and releases the lease on a chat view', async () => {
    const { ctx, attach, release, clientTerminals } = world()
    sessionHandlers.sessionPriority(ctx, {
      type: 'sessionPriority',
      sessionId: SESSION,
      priority: 0,
      nativeView: true,
    })
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1))
    expect(clientTerminals.viewers).toHaveBeenLastCalledWith(SESSION, true)
    expect(attach).toHaveBeenCalledWith({
      mode: 'takeover',
      holder: `podium-native:${SESSION}`,
    })

    sessionHandlers.sessionPriority(ctx, {
      type: 'sessionPriority',
      sessionId: SESSION,
      priority: 0,
      nativeView: false,
    })
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(`podium-native:${SESSION}`))
    expect(clientTerminals.viewers).toHaveBeenLastCalledWith(SESSION, false)
  })

  it('routes terminal input, geometry, and redraw without a PTY bridge', () => {
    const { ctx, clientTerminals } = world()
    clientTerminals.input.mockReturnValue(true)
    clientTerminals.resize.mockReturnValue(true)
    clientTerminals.redraw.mockReturnValue(true)

    sessionHandlers.input(ctx, {
      type: 'input',
      sessionId: SESSION,
      data: 'aGVsbG8=',
      inputOrigin: 'human',
    })
    sessionHandlers.resize(ctx, { type: 'resize', sessionId: SESSION, cols: 91, rows: 33 })
    sessionHandlers.redraw(ctx, { type: 'redraw', sessionId: SESSION })

    expect(clientTerminals.input).toHaveBeenCalledWith(SESSION, 'aGVsbG8=')
    expect(clientTerminals.resize).toHaveBeenCalledWith(SESSION, 91, 33)
    expect(clientTerminals.redraw).toHaveBeenCalledWith(SESSION)
    expect(ctx.pendingResizes.has(SESSION)).toBe(false)
  })

  it('drops stale client-terminal input after Chat releases Native', () => {
    const { ctx, clientTerminals } = world()
    ctx.nativeClientRequests?.delete(SESSION)
    sessionHandlers.input(ctx, {
      type: 'input',
      sessionId: SESSION,
      data: 'c3RhbGU=',
      inputOrigin: 'human',
    })
    expect(clientTerminals.input).not.toHaveBeenCalled()
  })
})
