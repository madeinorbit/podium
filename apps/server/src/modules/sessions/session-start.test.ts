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

import { asSessionId, asUserId, firstAdminMemberId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'

const registries: SessionRegistry[] = []

afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

async function makeRegistry(store?: SessionStore): Promise<{ reg: SessionRegistry; daemon: ControlMessage[] }> {
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  const daemon: ControlMessage[] = []
  await reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (m) => daemon.push(m))
  return { reg, daemon }
}

function spawns(daemon: ControlMessage[]) {
  return daemon.filter((m): m is Extract<ControlMessage, { type: 'spawn' }> => m.type === 'spawn')
}

/**
 * THIS DESCRIBE BLOCK ASSERTED THE OPPOSITE UNTIL B1 (PDM-133), and the
 * inversion is deliberate — it is the task's whole subject, not a fixture that
 * drifted.
 *
 * It used to read: "ADR 1: createSession with issueId and a conflicting
 * ownerUserId lands on the issue owner", with the note "Without this assertion,
 * inverting `parentOwner ?? input.ownerUserId` stays green." That note was
 * right, and it is why the change had to come through here: the precedence was
 * pinned on purpose, so removing it has to be argued rather than discovered.
 *
 * The argument is that ADR 1's per-class inheritance is about issue CONTENT,
 * and a private run is not content. The accepted multi-user architecture keeps
 * a private session with the human who started it across task reassignment, so
 * "the task's owner owns the sessions on it" is the defect: it is how Alice ends
 * up owning Bob's agent (MU-07/08). The `parentOwner` term is gone from
 * `SessionStart.create` and the explicit owner the caller resolved now stands.
 */
describe('SessionStart: the initiating human outranks the attached issue', () => {
  it('createSession with an issueId owned by someone else keeps the initiating human', async () => {
    const issueOwner = asUserId('user:issue-owner')
    const starter = asUserId('user:the-human-who-started-it')
    // The fixture DISCRIMINATES: three distinct users, so neither the issue
    // owner nor the first-enrolled admin can be mistaken for the right answer.
    expect(issueOwner).not.toBe(starter)
    expect(issueOwner).not.toBe(firstAdminMemberId())
    expect(starter).not.toBe(firstAdminMemberId())

    const { reg, daemon } = await makeRegistry()
    const issue = await reg.issues.create({
      repoPath: '/r',
      title: 'Owned issue',
      startNow: false,
      ownerUserId: issueOwner,
    })
    expect((await reg.sessionStore.issues.getIssue(issue.id))?.ownerUserId).toBe(issueOwner)

    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
      issueId: issue.id,
      ownerUserId: starter,
    })

    // The durable row is the STARTER's. Restore `parentOwner ?? input.ownerUserId`
    // in SessionStart.create and this line fails with `issueOwner`.
    const row = (await reg.sessionStore.sessions.loadSessions()).find((r) => r.id === sessionId)
    expect(row?.ownerUserId).toBe(starter)

    // create() feeds ONE ownership answer into the daemon binding as well, so the
    // launched process is bound to the starter and not to the issue's owner.
    const frame = spawns(daemon).at(-1)
    expect(frame?.sessionId).toBe(sessionId)
    expect(frame?.binding?.principal).toEqual({ kind: 'user', userId: starter })

    // AND THE AUTHORITY READ AGREES WITH THE ROW. The durable column being right
    // is not sufficient on its own: `sessionOwner` used to re-derive the issue
    // owner on every read, so a correct row could still be reported as Alice's.
    expect(await reg.modules.sessions.sessionOwner(sessionId)).toEqual({
      owner: starter,
      grants: [],
    })
  })

  it('REASSIGNING the issue afterwards does not move the session', async () => {
    const issueOwner = asUserId('user:issue-owner')
    const starter = asUserId('user:the-human-who-started-it')
    const reassignee = asUserId('user:reassigned-to')

    const { reg } = await makeRegistry()
    const issue = await reg.issues.create({
      repoPath: '/r',
      title: 'Owned issue',
      startNow: false,
      ownerUserId: issueOwner,
    })
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
      issueId: issue.id,
      ownerUserId: starter,
    })

    // Move the task to a third human — the ordinary reassignment the product
    // allows any active member to perform (charter D2).
    await reg.issues.update(issue.id, { ownerUserId: reassignee })
    expect((await reg.sessionStore.issues.getIssue(issue.id))?.ownerUserId).toBe(reassignee)

    // NON-VACUITY: the reassignment really happened above, so this is not a
    // comparison against an unchanged world.
    expect(await reg.modules.sessions.sessionOwner(sessionId)).toEqual({
      owner: starter,
      grants: [],
    })
    const row = (await reg.sessionStore.sessions.loadSessions()).find((r) => r.id === sessionId)
    expect(row?.ownerUserId).toBe(starter)
  })
})

describe('SessionStart: creation-owned first prompt', () => {
  it('queues a non-argv OpenCode prompt and seeds a recoverable draft', async () => {
    const { reg, daemon } = await makeRegistry()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'opencode',
      cwd: '/proj',
      initialPrompt: 'hello',
    })

    const queued = await reg.sessionStore.sync.listQueuedMessages(sessionId)
    expect(queued.map((row) => row.text)).toEqual(['hello'])
    const session = (await reg.modules.sessions.listSessions(undefined, 'rpc')).find((item) => item.sessionId === sessionId)
    expect(session?.draftUpdatedAt).toBeDefined()
    // Non-empty draft writes are intentionally debounced; wait for the durable
    // composer record rather than coupling this launch test to that interval.
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect((await reg.sessionStore.sessions.loadDrafts())[sessionId]).toBe('hello')
    expect(spawns(daemon).at(-1)).not.toHaveProperty('initialPrompt')
  })
})

describe('resolved runtime driver projection', () => {
  it('publishes the actual driver, echoes degradation on reattach, and clears a stale request', async () => {
    const { reg, daemon } = await makeRegistry()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/proj',
    })

    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
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

    const degraded = (await reg.modules.sessions
      .listSessions(undefined, 'rpc'))
      .find((session) => session.sessionId === sessionId)
    expect(degraded).toMatchObject({
      status: 'live',
      driverId: 'codex-app-server',
      requestedDriverId: 'opencode-server',
    })

    reg.gateway.detachDaemon(reg.sessionStore.hostMachineId)
    daemon.length = 0
    await reg.gateway.attachDaemon(reg.sessionStore.hostMachineId, (message) => daemon.push(message))

    const reattach = daemon.find(
      (message): message is Extract<ControlMessage, { type: 'reattach' }> =>
        message.type === 'reattach' && message.sessionId === sessionId,
    )
    expect(reattach?.requestedDriverId).toBe('opencode-server')

    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'codex app-server (codex-app-server)',
      cwd: '/proj',
      agentKind: 'codex',
      geometry: { cols: 80, rows: 24 },
      runtimeContract: true,
      driverId: 'codex-app-server',
    })

    const recovered = (await reg.modules.sessions
      .listSessions(undefined, 'rpc'))
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
    const { reg, daemon } = await makeRegistry(store)
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/proj',
      runtimeContract: 'claude-sdk',
    })
    expect(spawns(daemon).at(-1)).toMatchObject({ sessionId, runtimeContract: 'claude-sdk' })

    const resume = { kind: 'claude-session', value: 'claude-sdk-resume' } as const
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
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
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'sessionResumeRef',
      sessionId,
      resume,
      confidence: 'exact',
    })
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
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
    await reg.dispose()
    const reloaded = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(reloaded)
    daemon.length = 0
    await reloaded.gateway.attachDaemon(reloaded.sessionStore.hostMachineId, (message) =>
      daemon.push(message),
    )
    const reattach = daemon.find(
      (message): message is Extract<ControlMessage, { type: 'reattach' }> =>
        message.type === 'reattach' && message.sessionId === sessionId,
    )
    expect(reattach).toMatchObject({ sessionId, resume, runtimeContract: 'claude-sdk' })
    expect(reattach).toMatchObject({ requestedDriverId: 'claude-sdk' })

    daemon.length = 0
    expect(await reloaded.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
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
    const first = await makeRegistry(store)
    const { sessionId } = await first.reg.modules.sessions.createSession({
      agentKind: 'opencode',
      cwd: '/proj',
    })
    await first.reg.gateway.routeDaemonFrame(first.reg.sessionStore.hostMachineId, {
      type: 'driverSelected',
      sessionId,
      driverId: 'opencode-server',
    })
    expect((await store.sessions.loadSessions()).at(-1)).toMatchObject({
      selectedDriverId: 'opencode-server',
      requestedDriverId: null,
    })
    first.reg.gateway.detachDaemon(first.reg.sessionStore.hostMachineId)
    await first.reg.dispose()

    const reloaded = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(reloaded)
    const daemon: ControlMessage[] = []
    await reloaded.gateway.attachDaemon(reloaded.sessionStore.hostMachineId, (message) =>
      daemon.push(message),
    )
    expect(
      daemon.find((message) => message.type === 'reattach' && message.sessionId === sessionId),
    ).toMatchObject({ runtimeContract: 'opencode-server' })
  })

  it('revives a reloaded legacy headless row with its selected concrete driver', async () => {
    const store = await openTestStore(':memory:')
    const { reg, daemon } = await makeRegistry(store)
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'opencode',
      cwd: '/proj',
    })
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'opencode',
      cwd: '/proj',
      agentKind: 'opencode',
      geometry: { cols: 80, rows: 24 },
      runtimeContract: true,
      driverId: 'opencode-server',
    })
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'opencode-session', value: 'legacy-revival' },
      confidence: 'exact',
    })
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId,
      state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })
    expect((await store.sessions.loadSessions()).at(-1)?.requestedDriverId).toBeNull()
    expect(await reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
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
    const { reg, daemon } = await makeRegistry(store)
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'opencode',
      cwd: '/proj',
      runtimeContract: 'opencode-server',
    })
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'opencode',
      cwd: '/proj',
      agentKind: 'opencode',
      geometry: { cols: 80, rows: 24 },
      runtimeContract: true,
      driverId: 'generic-pty',
    })
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'opencode-session', value: 'legacy-resume' },
      confidence: 'exact',
    })
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId,
      state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })
    expect(await reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
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
    const first = await makeRegistry(store)
    const { sessionId } = await first.reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/proj',
    })
    await first.reg.gateway.routeDaemonFrame(first.reg.sessionStore.hostMachineId, {
      type: 'driverSelected',
      sessionId,
      driverId: 'generic-pty',
    })
    first.reg.gateway.detachDaemon(first.reg.sessionStore.hostMachineId)
    await first.reg.dispose()

    const reloaded = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(reloaded)
    const daemon: ControlMessage[] = []
    await reloaded.gateway.attachDaemon(reloaded.sessionStore.hostMachineId, (message) =>
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
    const { reg, daemon } = await makeRegistry()

    await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/proj',
      sessionId,
      title: 'first',
    })
    // Bind so the session is live — the silent-overwrite harm is orphaning a
    // bound PTY/daemon mapping, not merely losing the error path.
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
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
    expect((await reg.modules.sessions.listSessions(undefined, 'rpc')).find((s) => s.sessionId === sessionId)?.status).toBe(
      'live',
    )
    expect(spawns(daemon).filter((m) => m.sessionId === sessionId)).toHaveLength(1)

    await expect(
      reg.modules.sessions.createSession({
        agentKind: 'shell',
        cwd: '/other',
        sessionId,
        title: 'clobber attempt',
      }),
    ).rejects.toThrow(/refusing to reuse an existing session id/)

    // First session still the only occupant of that id — not overwritten.
    const after = (await reg.sessionStore.sessions.loadSessions()).filter((r) => r.id === sessionId)
    expect(after).toHaveLength(1)
    expect(after[0]?.durableLabel).toBe(durableLabel)
    expect(after[0]?.cwd).toBe('/proj')
    expect(after[0]?.title).toBe('first')
    expect((await reg.modules.sessions.listSessions(undefined, 'rpc')).find((s) => s.sessionId === sessionId)?.status).toBe(
      'live',
    )
    // No second spawn frame — an overwrite would re-fire spawn for the same id.
    expect(spawns(daemon).filter((m) => m.sessionId === sessionId)).toHaveLength(1)
  })
})
