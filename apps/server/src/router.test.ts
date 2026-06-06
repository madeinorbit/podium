import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'

function caller() {
  const registry = new SessionRegistry()
  registry.attachDaemon(() => {})
  const repos = new RepoRegistry(
    join(tmpdir(), `podium-router-${Math.random().toString(36).slice(2)}.json`),
  )
  return { registry, call: appRouter.createCaller({ registry, repos }) }
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
    const call = appRouter.createCaller({
      registry,
      repos: new RepoRegistry(
        join(tmpdir(), `podium-disc-${Math.random().toString(36).slice(2)}.json`),
      ),
    })
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

async function repoCaller() {
  const dir = await mkdtemp(join(tmpdir(), 'podium-router-'))
  const repos = new RepoRegistry(join(dir, 'repos.json'))
  await repos.load()
  const registry = new SessionRegistry()
  const daemon: import('@podium/protocol').ControlMessage[] = []
  registry.attachDaemon((m) => daemon.push(m))
  return { registry, repos, daemon, call: appRouter.createCaller({ registry, repos }) }
}

describe('repos router', () => {
  it('repos.add then repos.list reflects it', async () => {
    const { call } = await repoCaller()
    await call.repos.add({ path: '/abs/app' })
    expect(await call.repos.list()).toEqual(['/abs/app'])
  })

  it('repos.remove drops it', async () => {
    const { call } = await repoCaller()
    await call.repos.add({ path: '/abs/app' })
    await call.repos.remove({ path: '/abs/app' })
    expect(await call.repos.list()).toEqual([])
  })

  it('repos.add rejects a non-absolute path', async () => {
    const { call } = await repoCaller()
    await expect(call.repos.add({ path: 'relative/path' })).rejects.toThrow()
  })

  it('repos.addMany persists each path and reports failures', async () => {
    const { call } = await repoCaller()
    const res = await call.repos.addMany({ paths: ['/abs/a', '/abs/b', 'relative/bad'] })
    expect(res.repos).toEqual(['/abs/a', '/abs/b'])
    expect(res.failed.map((f) => f.path)).toEqual(['relative/bad'])
    expect(await call.repos.list()).toEqual(['/abs/a', '/abs/b'])
  })

  type ReposReq =
    | { requestId: string; roots: string[]; includeHome?: boolean; maxDepth?: number }
    | undefined

  it('discovery.refreshRepos enriches registered roots in place (no home walk)', async () => {
    const { call, repos, registry, daemon } = await repoCaller()
    await repos.add('/abs/app')
    const p = call.discovery.refreshRepos()
    await Promise.resolve()
    const req = daemon.find((m) => m.type === 'scanReposRequest') as ReposReq
    expect(req?.roots).toEqual(['/abs/app'])
    expect(req?.includeHome).toBe(false)
    expect(req?.maxDepth).toBe(0)
    if (!req) throw new Error('no scanReposRequest')
    registry.onDaemonMessage({
      type: 'scanReposResult',
      requestId: req.requestId,
      repositories: [],
      diagnostics: [],
    })
    await expect(p).resolves.toEqual({ repositories: [], diagnostics: [] })
  })

  it('discovery.scanFolder scans the chosen folder to a bounded depth', async () => {
    const { call, registry, daemon } = await repoCaller()
    const p = call.discovery.scanFolder({ path: '/some/dir' })
    // scanFolder has a Zod input, so its handler runs a tick later than the
    // input-less procedures; a macrotask flushes the validation + handler first.
    await new Promise((resolve) => setTimeout(resolve))
    const req = daemon.find((m) => m.type === 'scanReposRequest') as ReposReq
    expect(req?.roots).toEqual(['/some/dir'])
    expect(req?.includeHome).toBe(false)
    expect(req?.maxDepth).toBe(6)
    if (!req) throw new Error('no scanReposRequest')
    registry.onDaemonMessage({
      type: 'scanReposResult',
      requestId: req.requestId,
      repositories: [],
      diagnostics: [],
    })
    await expect(p).resolves.toEqual({ repositories: [], diagnostics: [] })
  })
})
