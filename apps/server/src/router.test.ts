import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { appRouter } from './router'

function caller() {
  const registry = new SessionRegistry()
  registry.attachDaemon(() => {})
  return { registry, call: appRouter.createCaller({ registry }) }
}

describe('appRouter', () => {
  it('sessions.create then sessions.list reflects it', async () => {
    const { call } = caller()
    const { sessionId } = await call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    const list = await call.sessions.list()
    expect(list).toMatchObject([{ sessionId, agentKind: 'claude-code', cwd: '/p' }])
  })

  it('sessions.kill removes the session', async () => {
    const { call } = caller()
    const { sessionId } = await call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    await call.sessions.kill({ sessionId })
    expect(await call.sessions.list()).toHaveLength(0)
  })

  it('discovery.scan resolves via the registry', async () => {
    const daemon: import('@podium/protocol').ControlMessage[] = []
    const registry = new SessionRegistry()
    registry.attachDaemon((m) => daemon.push(m))
    const call = appRouter.createCaller({ registry })
    const p = call.discovery.scan()
    // Yield so the tRPC handler's async body (registry.scan → pendingScans.set) runs before we feed the result.
    await Promise.resolve()
    const req = daemon.find((m) => m.type === 'scanRequest') as { requestId: string } | undefined
    expect(req).toBeDefined()
    if (!req) throw new Error('scanRequest not sent')
    registry.onDaemonMessage({
      type: 'scanResult',
      requestId: req.requestId,
      conversations: [],
      diagnostics: [],
    })
    await expect(p).resolves.toEqual({ conversations: [], diagnostics: [] })
  })
})
