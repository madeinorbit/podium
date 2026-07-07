import { describe, expect, it } from 'vitest'
import { OPERATOR } from './issue-authz'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { SuperagentService } from './superagent'

function caller() {
  const registry = new SessionRegistry()
  registry.attachDaemon('local', () => {})
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = new SuperagentService(registry, repos, registry.sessionStore)
  return {
    registry,
    call: appRouter.createCaller({ registry, repos, superagent, capability: OPERATOR }),
  }
}

describe('appRouter', () => {
  it('sessions.create then sessions.list reflects it', async () => {
    const { call } = caller()
    const { sessionId } = await call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    const list = await call.sessions.list()
    expect(list).toMatchObject([{ sessionId, agentKind: 'claude-code', cwd: '/p' }])
  })

  it('models.refresh + models.catalog return the injected live catalog', async () => {
    const registry = new SessionRegistry(undefined, undefined, {
      modelProbe: async () => ({ grok: [{ value: 'grok-build', label: 'grok-build' }] }),
    })
    registry.attachDaemon('local', () => {})
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = new SuperagentService(registry, repos, registry.sessionStore)
    const call = appRouter.createCaller({ registry, repos, superagent, capability: OPERATOR })
    const refreshed = await call.models.refresh()
    expect(refreshed.byAgent.grok?.[0]?.value).toBe('grok-build')
    expect((await call.models.catalog()).byAgent.grok?.[0]?.value).toBe('grok-build')
    registry.dispose()
  })

  it("sessions.create stamps spawnedBy 'user' (the tRPC seam is the human seam, issue #60)", async () => {
    const { call } = caller()
    const { sessionId } = await call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    const list = await call.sessions.list()
    expect(list.find((s) => s.sessionId === sessionId)?.spawnedBy).toBe('user')
  })

  it("sessions.resume stamps spawnedBy 'user' on its fresh-spawn fallback (issue #60)", async () => {
    const { call } = caller()
    const { sessionId } = await call.sessions.resume({
      agentKind: 'claude-code',
      cwd: '/p',
      resume: { kind: 'claude-session', value: 'r9' },
      conversationId: 'c9',
    })
    const list = await call.sessions.list()
    expect(list.find((s) => s.sessionId === sessionId)?.spawnedBy).toBe('user')
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
    registry.attachDaemon('local', (m) => daemon.push(m))
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const call = appRouter.createCaller({
      registry,
      repos,
      superagent: new SuperagentService(registry, repos, registry.sessionStore),
      capability: OPERATOR,
    })
    const p = call.discovery.scan()
    // Yield so the tRPC handler's async body (registry.scan → pendingScans.set) runs before we feed the result.
    await Promise.resolve()
    const req = daemon.find((m) => m.type === 'scanRequest') as { requestId: string } | undefined
    expect(req).toBeDefined()
    if (!req) throw new Error('scanRequest not sent')
    registry.onDaemonMessageFrom('local', {
      type: 'scanResult',
      requestId: req.requestId,
      conversations: [],
      diagnostics: [],
    })
    await expect(p).resolves.toEqual({ conversations: [], diagnostics: [] })
  })

  it('sessions.transcriptRead delegates to registry.readTranscript (daemon round-trip)', async () => {
    const daemon: import('@podium/protocol').ControlMessage[] = []
    const registry = new SessionRegistry()
    registry.attachDaemon('local', (m) => daemon.push(m))
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const call = appRouter.createCaller({
      registry,
      repos,
      superagent: new SuperagentService(registry, repos, registry.sessionStore),
      capability: OPERATOR,
    })
    const { sessionId } = await call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    const p = call.sessions.transcriptRead({ sessionId, direction: 'before', limit: 100 })
    // Let the tRPC handler's async body (registry.readTranscript → toDaemon) flush.
    await new Promise((r) => setTimeout(r, 0))
    const req = daemon.find((m) => m.type === 'transcriptRead') as { requestId: string } | undefined
    expect(req).toBeDefined()
    if (!req) throw new Error('transcriptRead not sent')
    registry.onDaemonMessageFrom('local', {
      type: 'transcriptReadResult',
      requestId: req.requestId,
      sessionId,
      items: [],
      hasMore: false,
    })
    await expect(p).resolves.toEqual({ items: [], hasMore: false })
  })

  it('settings Telegram setup endpoints delegate to the registry', async () => {
    const registry = new SessionRegistry()
    registry.attachDaemon('local', () => {})
    let polled = ''
    ;(
      registry as unknown as {
        startTelegramSetup: () => Promise<{
          setupId: string
          code: string
          botUsername: string
          telegramUrl: string
          expiresAt: string
        }>
        pollTelegramSetup: (setupId: string) => Promise<{ status: 'pending'; expiresAt: string }>
      }
    ).startTelegramSetup = async () => ({
      setupId: 'setup-1',
      code: 'PODIUM123',
      botUsername: 'mwpodium_bot',
      telegramUrl: 'https://t.me/mwpodium_bot?start=PODIUM123',
      expiresAt: '2026-06-12T10:05:00.000Z',
    })
    ;(
      registry as unknown as {
        pollTelegramSetup: (setupId: string) => Promise<{ status: 'pending'; expiresAt: string }>
      }
    ).pollTelegramSetup = async (setupId) => {
      polled = setupId
      return { status: 'pending', expiresAt: '2026-06-12T10:05:00.000Z' }
    }
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const call = appRouter.createCaller({
      registry,
      repos,
      superagent: new SuperagentService(registry, repos, registry.sessionStore),
      capability: OPERATOR,
    })

    await expect(call.settings.telegramSetupStart()).resolves.toMatchObject({
      setupId: 'setup-1',
      code: 'PODIUM123',
    })
    await expect(call.settings.telegramSetupPoll({ setupId: 'setup-1' })).resolves.toEqual({
      status: 'pending',
      expiresAt: '2026-06-12T10:05:00.000Z',
    })
    expect(polled).toBe('setup-1')
  })

  it('the old sessions.transcript / transcriptPage procedures are gone', () => {
    // tRPC v11 keeps a flat record of procedures keyed by dotted path — assert against
    // it directly (the caller proxy returns a callable for any path, so it can't tell
    // a missing procedure from a present one).
    const procedures = Object.keys(
      (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures,
    )
    expect(procedures).toContain('sessions.transcriptRead')
    expect(procedures).not.toContain('sessions.transcript')
    expect(procedures).not.toContain('sessions.transcriptPage')
  })
})

function repoCaller() {
  const registry = new SessionRegistry()
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const daemon: import('@podium/protocol').ControlMessage[] = []
  registry.attachDaemon('local', (m) => daemon.push(m))
  return {
    registry,
    repos,
    daemon,
    call: appRouter.createCaller({
      registry,
      repos,
      superagent: new SuperagentService(registry, repos, registry.sessionStore),
      capability: OPERATOR,
    }),
  }
}

describe('markRead mutations (#124)', () => {
  it('issues.markRead flips unread and stamps readAt', async () => {
    const { call } = repoCaller()
    const iss = await call.issues.create({ repoPath: '/r', title: 'X', startNow: false })
    expect(iss.unread).toBe(true)
    const read = await call.issues.markRead({ id: iss.id })
    expect(read.unread).toBe(false)
    expect(read.readAt).not.toBeNull()
  })

  it('sessions.markRead flips a session to read', async () => {
    const { call, registry } = repoCaller()
    const { sessionId } = registry.createSession({ agentKind: 'claude-code', cwd: '/p' })
    expect(registry.listSessions().find((s) => s.sessionId === sessionId)?.unread).toBe(true)
    await call.sessions.markRead({ sessionId })
    const s = registry.listSessions().find((x) => x.sessionId === sessionId)
    expect(s?.unread).toBe(false)
    expect(s?.readAt).not.toBeNull()
  })
})

describe('repos router', () => {
  it('repos.add then repos.list reflects it', async () => {
    const { call } = repoCaller()
    await call.repos.add({ path: '/abs/app' })
    expect(await call.repos.list()).toEqual(['/abs/app'])
  })

  it('repos.remove drops it', async () => {
    const { call } = repoCaller()
    await call.repos.add({ path: '/abs/app' })
    await call.repos.remove({ path: '/abs/app' })
    expect(await call.repos.list()).toEqual([])
  })

  it('repos.add rejects a non-absolute path', async () => {
    const { call } = repoCaller()
    await expect(call.repos.add({ path: 'relative/path' })).rejects.toThrow()
  })

  it('repos.addMany persists each path and reports failures', async () => {
    const { call } = repoCaller()
    const res = await call.repos.addMany({ paths: ['/abs/a', '/abs/b', 'relative/bad'] })
    expect(res.repos).toEqual(['/abs/a', '/abs/b'])
    expect(res.failed.map((f) => f.path)).toEqual(['relative/bad'])
    expect(await call.repos.list()).toEqual(['/abs/a', '/abs/b'])
  })

  type ReposReq =
    | { requestId: string; roots: string[]; includeHome?: boolean; maxDepth?: number }
    | undefined

  it('discovery.refreshRepos enriches registered roots in place (no home walk)', async () => {
    const { call, repos, registry, daemon } = repoCaller()
    await repos.add('/abs/app')
    const p = call.discovery.refreshRepos()
    await Promise.resolve()
    const req = daemon.find((m) => m.type === 'scanReposRequest') as ReposReq
    expect(req?.roots).toEqual(['/abs/app'])
    expect(req?.includeHome).toBe(false)
    expect(req?.maxDepth).toBe(0)
    if (!req) throw new Error('no scanReposRequest')
    registry.onDaemonMessageFrom('local', {
      type: 'scanReposResult',
      requestId: req.requestId,
      repositories: [],
      diagnostics: [],
    })
    await expect(p).resolves.toEqual({ repositories: [], diagnostics: [] })
  })

  it('discovery.scanFolder scans the chosen folder to a bounded depth', async () => {
    const { call, registry, daemon } = repoCaller()
    const p = call.discovery.scanFolder({ path: '/some/dir' })
    // scanFolder has a Zod input, so its handler runs a tick later than the
    // input-less procedures; a macrotask flushes the validation + handler first.
    await new Promise((resolve) => setTimeout(resolve))
    const req = daemon.find((m) => m.type === 'scanReposRequest') as ReposReq
    expect(req?.roots).toEqual(['/some/dir'])
    expect(req?.includeHome).toBe(false)
    expect(req?.maxDepth).toBe(6)
    if (!req) throw new Error('no scanReposRequest')
    registry.onDaemonMessageFrom('local', {
      type: 'scanReposResult',
      requestId: req.requestId,
      repositories: [],
      diagnostics: [],
    })
    await expect(p).resolves.toEqual({ repositories: [], diagnostics: [] })
  })

  it('superagent.listThreads includes the global thread', async () => {
    const { call } = caller()
    const threads = await call.superagent.listThreads()
    expect(threads.some((t) => t.id === 'global')).toBe(true)
  })

  it('superagent.startBtw re-opens an existing btw thread without re-seeding', async () => {
    const { registry, call } = caller()
    const store = registry.sessionStore
    store.upsertSuperagentThread({ id: 'btw_s9', kind: 'btw', originSessionId: 's9' })
    store.setThreadWatermark('btw_s9', 'item-1', '2026-06-16T00:00:00Z')
    // Unknown session → empty transcript → no delta → re-open path, no backend call.
    const res = await call.superagent.startBtw({ sessionId: 's9' })
    expect(res).toEqual({ threadId: 'btw_s9', isNew: false })
  })

  it('snoozes.set / list / clear round-trip', async () => {
    const { call } = caller()
    const { sessionId } = await call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })

    expect(await call.snoozes.list()).toEqual({})
    expect(await call.snoozes.set({ sessionId, until: null })).toEqual({ [sessionId]: null })
    expect(await call.snoozes.list()).toEqual({ [sessionId]: null })
    expect(await call.snoozes.clear({ sessionId })).toEqual({})
  })
})
