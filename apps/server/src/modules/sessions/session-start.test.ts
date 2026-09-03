/**
 * SessionStart seams that mutation found silent after the POD-1396 extract
 * (POD-1433). Both rules predate the cut and moved with the code; neither had
 * an assertion that would fail if inverted/disabled.
 *
 *   1. create(): issue owner wins over an explicit ownerUserId
 *      (parentOwner ?? input.ownerUserId ?? …). Authorization-shaped: an
 *      issue-owned child inherits the issue owner (ADR 1).
 *   2. spawn(): refuse a client-supplied sessionId that already maps to a live
 *      Session. Without the guard the registry overwrites the live object and
 *      orphans its PTY/daemon binding.
 */

import { asSessionId, asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'

const registries: SessionRegistry[] = []

afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

function makeRegistry(store?: SessionStore): { reg: SessionRegistry; daemon: ControlMessage[] } {
  const reg = SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  const daemon: ControlMessage[] = []
  reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (m) => daemon.push(m))
  return { reg, daemon }
}

function spawns(daemon: ControlMessage[]) {
  return daemon.filter((m): m is Extract<ControlMessage, { type: 'spawn' }> => m.type === 'spawn')
}

describe('SessionStart: issue owner precedence', () => {
  // ADR 1: ownership per class — an issue-owned child inherits the issue owner.
  // Without this assertion, inverting parentOwner ?? input.ownerUserId stays green.
  it('ADR 1: createSession with issueId and a conflicting ownerUserId lands on the issue owner', async () => {
    const issueOwner = asUserId('user:issue-owner')
    const conflicting = asUserId('user:explicit-conflict')
    expect(issueOwner).not.toBe(conflicting)
    expect(issueOwner).not.toBe(FIRST_ADMIN_USER_ID)

    const { reg, daemon } = makeRegistry()
    const issue = reg.issues.create({
      repoPath: '/r',
      title: 'Owned issue',
      startNow: false,
      ownerUserId: issueOwner,
    })
    expect((await reg.sessionStore.issues.getIssue(issue.id))?.ownerUserId).toBe(issueOwner)

    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
      issueId: issue.id,
      ownerUserId: conflicting,
    })

    // Durable row is the issue's owner — not the conflicting input.
    const row = (await reg.sessionStore.sessions.loadSessions()).find((r) => r.id === sessionId)
    expect(row?.ownerUserId).toBe(issueOwner)

    // create() feeds one ownership answer into the daemon binding as well.
    const frame = spawns(daemon).at(-1)
    expect(frame?.sessionId).toBe(sessionId)
    expect(frame?.binding?.principal).toEqual({ kind: 'user', userId: issueOwner })
  })
})

describe('SessionStart: creation-owned first prompt', () => {
  it('queues a non-argv OpenCode prompt and seeds a recoverable draft', async () => {
    const { reg, daemon } = makeRegistry()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'opencode',
      cwd: '/proj',
      initialPrompt: 'hello',
    })

    const queued = await reg.sessionStore.sync.listQueuedMessages(sessionId)
    expect(queued.map((row) => row.text)).toEqual(['hello'])
    const session = reg.modules.sessions.listSessions().find((item) => item.sessionId === sessionId)
    expect(session?.draftUpdatedAt).toBeDefined()
    // Non-empty draft writes are intentionally debounced; wait for the durable
    // composer record rather than coupling this launch test to that interval.
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect((await reg.sessionStore.sessions.loadDrafts())[sessionId]).toBe('hello')
    expect(spawns(daemon).at(-1)).not.toHaveProperty('initialPrompt')
  })
})

describe('resolved runtime driver projection', () => {
  it('publishes the actual driver, echoes degradation on reattach, and clears a stale request', () => {
    const { reg, daemon } = makeRegistry()
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/proj',
    })

    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'codex app-server (codex-app-server)',
      cwd: '/proj',
      agentKind: 'codex',
      geometry: { cols: 80, rows: 24 },
      runtimeContract: true,
      driverId: 'codex-app-server',
      requestedDriverId: 'opencode-server',
    })

    const degraded = reg.modules.sessions
      .listSessions()
      .find((session) => session.sessionId === sessionId)
    expect(degraded).toMatchObject({
      status: 'live',
      driverId: 'codex-app-server',
      requestedDriverId: 'opencode-server',
    })

    reg.gateway.detachDaemon(reg.sessionStore.hostMachineId)
    daemon.length = 0
    reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (message) => daemon.push(message))

    const reattach = daemon.find(
      (message): message is Extract<ControlMessage, { type: 'reattach' }> =>
        message.type === 'reattach' && message.sessionId === sessionId,
    )
    expect(reattach?.requestedDriverId).toBe('opencode-server')

    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'codex app-server (codex-app-server)',
      cwd: '/proj',
      agentKind: 'codex',
      geometry: { cols: 80, rows: 24 },
      runtimeContract: true,
      driverId: 'codex-app-server',
    })

    const recovered = reg.modules.sessions
      .listSessions()
      .find((session) => session.sessionId === sessionId)
    expect(recovered).toMatchObject({
      status: 'live',
      driverId: 'codex-app-server',
    })
    expect(recovered?.requestedDriverId).toBe('opencode-server')
  })
})

describe('Claude SDK continuity projection', () => {
  it('carries the persisted selected driver and exact resume ref through reload and resurrection', async () => {
    const store = await openTestStore(':memory:')
    const { reg, daemon } = makeRegistry(store)
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/proj',
      runtimeContract: 'claude-sdk',
    })
    expect(spawns(daemon).at(-1)).toMatchObject({ sessionId, runtimeContract: 'claude-sdk' })

    const resume = { kind: 'claude-session', value: 'claude-sdk-resume' } as const
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'Claude Agent SDK (embedded)',
      cwd: '/proj',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
      runtimeContract: true,
      driverId: 'claude-sdk',
      requestedDriverId: 'claude-pty',
    })
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'sessionResumeRef',
      sessionId,
      resume,
      confidence: 'exact',
    })
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId,
      state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })

    expect(
      (await store.sessions.loadSessions()).find((row) => row.id === sessionId)?.selectedDriverId,
    ).toBe('claude-sdk')
    expect(
      (await store.sessions.loadSessions()).find((row) => row.id === sessionId)?.requestedDriverId,
    ).toBe('claude-sdk')
    reg.gateway.detachDaemon(reg.sessionStore.hostMachineId)
    reg.dispose()
    const reloaded = SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(reloaded)
    daemon.length = 0
    reloaded.gateway.attachDaemon(reloaded.sessionStore.hostMachineId, (message) =>
      daemon.push(message),
    )
    const reattach = daemon.find(
      (message): message is Extract<ControlMessage, { type: 'reattach' }> =>
        message.type === 'reattach' && message.sessionId === sessionId,
    )
    expect(reattach).toMatchObject({ sessionId, resume, runtimeContract: 'claude-sdk' })
    expect(reattach).toMatchObject({ requestedDriverId: 'claude-sdk' })

    daemon.length = 0
    expect(reloaded.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
    daemon.length = 0
    await expect(
      reloaded.modules.issueSessionLifecycle.resurrectSession({ sessionId }),
    ).resolves.toEqual({
      ok: true,
    })
    expect(spawns(daemon).at(-1)).toMatchObject({
      sessionId,
      resume,
      runtimeContract: 'claude-sdk',
    })
  })
})
describe('legacy selected-driver lifecycle compatibility', () => {
  it('reattaches a reloaded legacy headless row with its selected concrete driver', async () => {
    const store = await openTestStore(':memory:')
    const first = makeRegistry(store)
    const { sessionId } = first.reg.modules.sessions.createSession({
      agentKind: 'opencode',
      cwd: '/proj',
    })
    first.reg.gateway.routeDaemonFrame(first.reg.sessionStore.hostMachineId, {
      type: 'driverSelected',
      sessionId,
      driverId: 'opencode-server',
    })
    expect((await store.sessions.loadSessions()).at(-1)).toMatchObject({
      selectedDriverId: 'opencode-server',
      requestedDriverId: null,
    })
    first.reg.gateway.detachDaemon(first.reg.sessionStore.hostMachineId)
    first.reg.dispose()

    const reloaded = SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(reloaded)
    const daemon: ControlMessage[] = []
    reloaded.gateway.attachDaemon(reloaded.sessionStore.hostMachineId, (message) =>
      daemon.push(message),
    )
    expect(
      daemon.find((message) => message.type === 'reattach' && message.sessionId === sessionId),
    ).toMatchObject({ runtimeContract: 'opencode-server' })
  })

  it('revives a reloaded legacy headless row with its selected concrete driver', async () => {
    const store = await openTestStore(':memory:')
    const { reg, daemon } = makeRegistry(store)
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'opencode',
      cwd: '/proj',
    })
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'opencode',
      cwd: '/proj',
      agentKind: 'opencode',
      geometry: { cols: 80, rows: 24 },
      runtimeContract: true,
      driverId: 'opencode-server',
    })
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'opencode-session', value: 'legacy-revival' },
      confidence: 'exact',
    })
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId,
      state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })
    expect((await store.sessions.loadSessions()).at(-1)?.requestedDriverId).toBeNull()
    expect(reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
    daemon.length = 0
    await expect(
      reg.modules.issueSessionLifecycle.resurrectSession({ sessionId }),
    ).resolves.toEqual({
      ok: true,
    })
    expect(spawns(daemon).at(-1)).toMatchObject({
      sessionId,
      runtimeContract: 'opencode-server',
    })
  })

  it('lets explicit requested configuration override a degraded selected driver', async () => {
    const store = await openTestStore(':memory:')
    const { reg, daemon } = makeRegistry(store)
    const { sessionId } = reg.modules.sessions.createSession({
      agentKind: 'opencode',
      cwd: '/proj',
      runtimeContract: 'opencode-server',
    })
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'opencode',
      cwd: '/proj',
      agentKind: 'opencode',
      geometry: { cols: 80, rows: 24 },
      runtimeContract: true,
      driverId: 'generic-pty',
    })
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'opencode-session', value: 'legacy-resume' },
      confidence: 'exact',
    })
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId,
      state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })
    expect(reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
    daemon.length = 0
    await expect(
      reg.modules.issueSessionLifecycle.resurrectSession({ sessionId }),
    ).resolves.toEqual({
      ok: true,
    })
    expect(spawns(daemon).at(-1)).toMatchObject({
      sessionId,
      runtimeContract: 'opencode-server',
    })
  })

  it('does not turn a legacy selected terminal driver into an explicit request', async () => {
    const store = await openTestStore(':memory:')
    const first = makeRegistry(store)
    const { sessionId } = first.reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/proj',
    })
    first.reg.gateway.routeDaemonFrame(first.reg.sessionStore.hostMachineId, {
      type: 'driverSelected',
      sessionId,
      driverId: 'generic-pty',
    })
    first.reg.gateway.detachDaemon(first.reg.sessionStore.hostMachineId)
    first.reg.dispose()

    const reloaded = SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(reloaded)
    const daemon: ControlMessage[] = []
    reloaded.gateway.attachDaemon(reloaded.sessionStore.hostMachineId, (message) =>
      daemon.push(message),
    )
    expect(
      daemon.find((message) => message.type === 'reattach' && message.sessionId === sessionId),
    ).not.toHaveProperty('runtimeContract')
  })
})

describe('SessionStart: live session-id collision guard', () => {
  // Property is survival of the first live session, not merely that an error is thrown.
  it('refusing a live sessionId leaves the first session live and bound (not only throws)', async () => {
    const sessionId = asSessionId('client-supplied-id')
    const { reg, daemon } = makeRegistry()

    reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/proj',
      sessionId,
      title: 'first',
    })
    // Bind so the session is live — the silent-overwrite harm is orphaning a
    // bound PTY/daemon mapping, not merely losing the error path.
    reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'bash',
      cwd: '/proj',
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })

    const first = (await reg.sessionStore.sessions.loadSessions()).find((r) => r.id === sessionId)
    expect(first).toBeDefined()
    const durableLabel = first!.durableLabel
    expect(reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe(
      'live',
    )
    expect(spawns(daemon).filter((m) => m.sessionId === sessionId)).toHaveLength(1)

    expect(() =>
      reg.modules.sessions.createSession({
        agentKind: 'shell',
        cwd: '/other',
        sessionId,
        title: 'clobber attempt',
      }),
    ).toThrow(/refusing to reuse an existing session id/)

    // First session still the only occupant of that id — not overwritten.
    const after = (await reg.sessionStore.sessions.loadSessions()).filter((r) => r.id === sessionId)
    expect(after).toHaveLength(1)
    expect(after[0]?.durableLabel).toBe(durableLabel)
    expect(after[0]?.cwd).toBe('/proj')
    expect(after[0]?.title).toBe('first')
    expect(reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe(
      'live',
    )
    // No second spawn frame — an overwrite would re-fire spawn for the same id.
    expect(spawns(daemon).filter((m) => m.sessionId === sessionId)).toHaveLength(1)
  })
})
