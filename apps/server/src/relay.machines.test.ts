import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlMessage, ServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

function regWithTwoDaemons() {
  const store = new SessionStore(':memory:')
  store.machines.upsertMachine({ id: 'm1', name: 'one', hostname: 'one', tokenHash: 'x' })
  store.machines.upsertMachine({ id: 'm2', name: 'two', hostname: 'two', tokenHash: 'y' })
  const reg = new SessionRegistry(store)
  const m1: ControlMessage[] = []
  const m2: ControlMessage[] = []
  reg.modules.sessions.attachDaemon('m1', (msg) => m1.push(msg))
  reg.modules.sessions.attachDaemon('m2', (msg) => m2.push(msg))
  return { reg, m1, m2 }
}

describe('multi-daemon routing', () => {
  it('routes a spawn to the chosen machine only', () => {
    const { reg, m1, m2 } = regWithTwoDaemons()
    reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/x', machineId: 'm2' })
    expect(m1.filter((m) => m.type === 'spawn')).toHaveLength(0)
    expect(m2.filter((m) => m.type === 'spawn')).toHaveLength(1)
  })

  it('a session carries its machineId in meta', () => {
    const { reg } = regWithTwoDaemons()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/x',
      machineId: 'm2',
    })
    const meta = reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    expect(meta).toBeDefined()
    expect(meta?.machineId).toBe('m2')
    expect(meta?.machineName).toBe('two')
  })

  it('acknowledges an exact native binding back to its owner after storing it', () => {
    const { reg, m1, m2 } = regWithTwoDaemons()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/x',
      machineId: 'm1',
    })
    m1.length = 0

    reg.modules.sessions.onDaemonMessageFrom('m1', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'codex-thread', value: 'thread-a' },
      confidence: 'exact',
      ackRequested: true,
    })

    expect(
      reg.modules.sessions.listSessions().find((session) => session.sessionId === sessionId)
        ?.resume,
    ).toEqual({ kind: 'codex-thread', value: 'thread-a' })
    expect(m1).toContainEqual({
      type: 'sessionResumeRefAck',
      sessionId,
      resume: { kind: 'codex-thread', value: 'thread-a' },
    })
    expect(m2).not.toContainEqual(expect.objectContaining({ type: 'sessionResumeRefAck' }))
  })

  it('rejects a native binding and acknowledgement from a non-owner daemon', () => {
    const { reg, m1, m2 } = regWithTwoDaemons()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/x',
      machineId: 'm1',
    })
    m1.length = 0
    m2.length = 0

    reg.modules.sessions.onDaemonMessageFrom('m2', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'codex-thread', value: 'foreign-thread' },
      confidence: 'exact',
      ackRequested: true,
    })

    expect(
      reg.modules.sessions.listSessions().find((session) => session.sessionId === sessionId)
        ?.resume,
    ).toBeUndefined()
    expect(m1).not.toContainEqual(expect.objectContaining({ type: 'sessionResumeRefAck' }))
    expect(m2).not.toContainEqual(expect.objectContaining({ type: 'sessionResumeRefAck' }))
  })

  it('detaching m1 only marks m1 sessions reconnecting', () => {
    const { reg } = regWithTwoDaemons()
    const a = reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/a',
      machineId: 'm1',
    }).sessionId
    const b = reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/b',
      machineId: 'm2',
    }).sessionId
    // mark both live as a bind would
    reg.modules.sessions.onDaemonMessageFrom('m1', {
      type: 'bind',
      sessionId: a,
      cmd: 'x',
      cwd: '/a',
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })
    reg.modules.sessions.onDaemonMessageFrom('m2', {
      type: 'bind',
      sessionId: b,
      cmd: 'x',
      cwd: '/b',
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })
    reg.modules.sessions.detachDaemon('m1')
    const meta = (id: string) => reg.modules.sessions.listSessions().find((s) => s.sessionId === id)
    expect(meta(a)?.status).toBe('reconnecting')
    expect(meta(b)?.status).toBe('live')
  })

  it('lists machines with their online status from the registry', () => {
    const { reg } = regWithTwoDaemons()
    const machines = reg.modules.machines.listMachines()
    expect(machines.find((m) => m.id === 'm1')?.online).toBe(true)
    expect(machines.find((m) => m.id === 'm2')?.online).toBe(true)
    reg.modules.sessions.detachDaemon('m1')
    const after = reg.modules.machines.listMachines()
    expect(after.find((m) => m.id === 'm1')?.online).toBe(false)
    expect(after.find((m) => m.id === 'm2')?.online).toBe(true)
  })

  it('routes an unresolved spawn (no machineId, unregistered cwd) to an online machine, not __local__', () => {
    const { reg, m1, m2 } = regWithTwoDaemons()
    // No machineId provided, cwd matches no registered repo — must NOT dead-queue under __local__.
    reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/no/repo/here' })
    const spawns = [...m1, ...m2].filter((m) => m.type === 'spawn')
    // The spawn must have reached one of the online daemons, not vanished into __local__.
    expect(spawns).toHaveLength(1)
    // Confirm the session's machineId is one of the two online machines.
    const sessions = reg.modules.sessions.listSessions()
    expect(sessions).toHaveLength(1)
    expect(['m1', 'm2']).toContain(sessions[0]?.machineId)
  })

  it('host metrics are scoped per machine', () => {
    const { reg } = regWithTwoDaemons()
    const sent: import('@podium/protocol').ServerMessage[] = []
    reg.modules.sessions.attachClient((m) => sent.push(m))
    reg.modules.sessions.onDaemonMessageFrom('m1', {
      type: 'hostMetrics',
      hostname: 'one',
      sampledAt: '2026-06-11T00:00:00.000Z',
      memory: { totalBytes: 32, availableBytes: 16, swapTotalBytes: 0, swapFreeBytes: 0 },
    })
    reg.modules.sessions.onDaemonMessageFrom('m2', {
      type: 'hostMetrics',
      hostname: 'two',
      sampledAt: '2026-06-11T00:00:00.000Z',
      memory: { totalBytes: 32, availableBytes: 8, swapTotalBytes: 0, swapFreeBytes: 0 },
    })
    const last = sent
      .filter(
        (
          m,
        ): m is Extract<import('@podium/protocol').ServerMessage, { type: 'hostMetricsChanged' }> =>
          m.type === 'hostMetricsChanged',
      )
      .at(-1)
    const ids = last?.hosts.map((h) => h.machineId).sort()
    expect(ids).toEqual(['m1', 'm2'])
    // detaching m1 drops only its sample
    reg.modules.sessions.detachDaemon('m1')
    const afterDetach = sent
      .filter(
        (
          m,
        ): m is Extract<import('@podium/protocol').ServerMessage, { type: 'hostMetricsChanged' }> =>
          m.type === 'hostMetricsChanged',
      )
      .at(-1)
    expect(afterDetach?.hosts.map((h) => h.machineId)).toEqual(['m2'])
  })
})

function handoffRegistry(opts: { failExport?: boolean } = {}) {
  const store = new SessionStore(':memory:')
  store.machines.upsertMachine({ id: 'm1', name: 'source', hostname: 'source', tokenHash: 'x' })
  store.machines.upsertMachine({ id: 'm2', name: 'target', hostname: 'target', tokenHash: 'y' })
  const inventory = JSON.stringify({
    os: 'linux',
    arch: 'x64',
    agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }],
    tools: [],
  })
  store.machines.setMachineInventory('m1', inventory)
  store.machines.setMachineInventory('m2', inventory)
  store.repos.addRepo('/source/repo', 'm1', 'git@github.com:example/repo.git')
  store.repos.addRepo('/target/repo', 'm2', 'git@github.com:example/repo.git')
  const reg = new SessionRegistry(store)
  const source: ControlMessage[] = []
  const target: ControlMessage[] = []
  const sha = 'a'.repeat(40)
  reg.modules.sessions.attachDaemon('m1', (msg) => {
    source.push(msg)
    if (msg.type === 'handoffExportRequest') {
      const manifest = {
        format: 1 as const,
        sessionId: msg.sessionId,
        agentKind: 'claude-code' as const,
        resume: { kind: 'claude-session' as const, value: 'native-id' },
        transcriptFilename: 'native-id.jsonl',
        repoId: store.repos.listRepos('m1')[0]!.repoId!,
        branch: 'x',
        headSha: sha,
        snapshotSha: null,
        snapshotFlattened: true as const,
        worktreeName: 'x',
        bundleBase: [sha],
        sourceMachineId: 'm1',
        exportedAt: new Date().toISOString(),
      }
      reg.modules.sessions.onDaemonMessageFrom(
        'm1',
        opts.failExport
          ? {
              type: 'handoffExportResult',
              requestId: msg.requestId,
              ok: false,
              error: 'export exploded',
            }
          : {
              type: 'handoffExportResult',
              requestId: msg.requestId,
              ok: true,
              manifest,
              stagePath: '/home/source/.podium/handoff/package.tgz',
              sizeBytes: 3,
            },
      )
    }
    if (msg.type === 'handoffChunkReadRequest')
      reg.modules.sessions.onDaemonMessageFrom('m1', {
        type: 'handoffChunkReadResult',
        requestId: msg.requestId,
        ok: true,
        data: Buffer.from('pkg').toString('base64'),
        sizeBytes: 3,
        eof: true,
      })
  })
  reg.modules.sessions.attachDaemon('m2', (msg) => {
    target.push(msg)
    if (msg.type === 'repoOpRequest')
      reg.modules.sessions.onDaemonMessageFrom('m2', {
        type: 'repoOpResult',
        requestId: msg.requestId,
        ok: msg.args?.ref === 'main',
        output: msg.args?.ref === 'main' ? sha : 'missing',
      })
    if (msg.type === 'handoffImportChunk')
      reg.modules.sessions.onDaemonMessageFrom('m2', {
        type: 'handoffImportChunkResult',
        requestId: msg.requestId,
        ok: true,
        sizeBytes: msg.offset + Buffer.from(msg.data, 'base64').length,
      })
    if (msg.type === 'handoffImportRequest')
      reg.modules.sessions.onDaemonMessageFrom('m2', {
        type: 'handoffImportResult',
        requestId: msg.requestId,
        ok: true,
        newCwd: '/target/repo/.worktrees/x',
      })
  })
  const { sessionId } = reg.modules.sessions.resumeSession({
    agentKind: 'claude-code',
    cwd: '/source/repo/.worktrees/x',
    resume: { kind: 'claude-session', value: 'native-id' },
    conversationId: 'native-id',
    machineId: 'm1',
  })
  return { reg, source, target, sessionId }
}

describe('session handoff orchestration', () => {
  it('re-homes the canonical row and resumes it on the target', async () => {
    const prior = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = mkdtempSync(join(tmpdir(), 'podium-handoff-server-'))
    try {
      const { reg, source, target, sessionId } = handoffRegistry()
      await reg.modules.sessions.handoffSession({ sessionId, machineId: 'm2' })
      expect(reg.modules.sessions.listSessions()).toMatchObject([
        { sessionId, machineId: 'm2', cwd: '/target/repo/.worktrees/x', status: 'starting' },
      ])
      expect(source).toContainEqual(expect.objectContaining({ type: 'kill', sessionId }))
      expect(target).toContainEqual(
        expect.objectContaining({ type: 'spawn', sessionId, cwd: '/target/repo/.worktrees/x' }),
      )
    } finally {
      if (prior === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = prior
    }
  })

  it('invalidates the repo lists on both machines so the moved session stays handoff-eligible', async () => {
    // POD-821: the import runs `git worktree add` on the target, so the moved
    // session's new cwd is a worktree NO client has scanned. Clients re-fetch repos
    // only on boot / a machine coming online / this invalidation, and the handoff
    // gate resolves a session's cwd against that list — without it the session that
    // just arrived cannot be handed back until a reload.
    const prior = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = mkdtempSync(join(tmpdir(), 'podium-handoff-server-'))
    try {
      const { reg, sessionId } = handoffRegistry()
      const client: ServerMessage[] = []
      reg.modules.sessions.attachClient((message) => client.push(message))
      await reg.modules.sessions.handoffSession({ sessionId, machineId: 'm2' })
      expect(client.filter((m) => m.type === 'worktreesChanged')).toEqual([
        { type: 'worktreesChanged', repoPath: '/target/repo', machineId: 'm2' },
        { type: 'worktreesChanged', repoPath: '/source/repo', machineId: 'm1' },
      ])
    } finally {
      if (prior === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = prior
    }
  })

  it('resumes the unchanged source row when export fails', async () => {
    const { reg, source, sessionId } = handoffRegistry({ failExport: true })
    await expect(
      reg.modules.sessions.handoffSession({ sessionId, machineId: 'm2' }),
    ).rejects.toThrow('export exploded')
    expect(reg.modules.sessions.listSessions()).toMatchObject([
      { sessionId, machineId: 'm1', cwd: '/source/repo/.worktrees/x', status: 'starting' },
    ])
    expect(source.filter((message) => message.type === 'spawn')).toHaveLength(2)
  })
})
