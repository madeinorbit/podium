import {
  asRepoId,
  asThreadId,
  asUserId,
  firstAdminMemberId,
  sessionUserStateRowId,
} from '@podium/model'
import { asCapabilityRef, asDeviceId, type Principal } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FamilyState } from './modules/derived-family'
import { disposeOracles, makeOracle } from './modules/sessions/oracle-support'
import { SESSION_QUERIES } from './modules/sessions/queries'
import { buildSuperagentTools } from './modules/superagent/tools'

const NOW = Date.parse('2026-10-02T12:00:00.000Z')
const B = asUserId('user:b')
const C = asUserId('user:c')
afterEach(async () => {
  await disposeOracles()
  vi.restoreAllMocks()
})
const wirePrincipal = (user: ReturnType<typeof asUserId>): Principal => ({
  kind: 'user',
  user,
  device: asDeviceId(`device:${user}`),
  capability: asCapabilityRef(`cap:${user}`),
})

async function fixture() {
  const o = await makeOracle({ now: () => NOW })
  const A = await firstAdminMemberId(o.store)
  for (const user of [B, C])
    await o.store.users.create(
      {
        id: user,
        displayName: user,
        role: 'member',
        createdAt: '2026-01-01T00:00:00.000Z',
        disabledAt: null,
      },
      'fixture-hash',
    )
  const sessions = o.reg.modules.sessions
  const { sessionId } = await sessions.createSession({ agentKind: 'shell', cwd: '/p' })
  await o.store.grants.upsert({
    resourceKind: 'session',
    resourceId: sessionId,
    grantee: B,
    verb: 'read',
    owner: A,
    visibility: 'personal',
    createdAt: '2026-01-01T00:00:00.000Z',
    actorKind: 'user',
    actorId: A,
    onBehalfOf: A,
  })
  const a = await sessions.view.principalForTrustedUser(A)
  const b = await sessions.view.principalForTrustedUser(B)
  const stateRows = async (user: typeof A) => {
    const snapshot = await sessions.syncChangesSince(null, wirePrincipal(user))
    if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot')
    return snapshot.sessionUserStates ?? []
  }
  return { ...o, sessions, sessionId, A, a, b, stateRows }
}

describe('S1 session companion records', () => {
  it.each([
    'read',
    'unread',
    'snooze',
    'clear',
  ] as const)('publishes the %s mutation as an explicit acting-user row', async (verb) => {
    const f = await fixture()
    if (verb === 'unread') await f.sessions.state.markRead(f.b, f.sessionId)
    if (verb === 'clear') await f.sessions.state.setSnooze(f.b, f.sessionId, null)
    const cursor = await f.reg.changeLedger.cursor()
    if (verb === 'read') await f.sessions.state.markRead(f.b, f.sessionId)
    if (verb === 'unread') await f.sessions.state.markUnread(f.b, f.sessionId)
    if (verb === 'snooze') await f.sessions.state.setSnooze(f.b, f.sessionId, null)
    if (verb === 'clear') await f.sessions.state.clearSnooze(f.b, f.sessionId)
    const result = await f.sessions.syncChangesSince(cursor, wirePrincipal(B))
    if (result.kind !== 'delta') throw new Error('expected delta')
    expect(result.changes.filter((change) => change.entity === 'sessionUserState')).toEqual([
      expect.objectContaining({
        id: sessionUserStateRowId(B, f.sessionId),
        op: 'upsert',
        value: {
          userId: B,
          sessionId: f.sessionId,
          readAt: verb === 'read' ? new Date(NOW).toISOString() : null,
          ...(verb === 'snooze' ? { snoozedUntil: null } : {}),
        },
      }),
    ])
  })

  it('publishes acting-user read and snooze rows to only that principal in snapshot and delta', async () => {
    const f = await fixture()
    const { sessions, sessionId, A, a, b } = f
    const cursor = await f.reg.changeLedger.cursor()
    await sessions.state.markRead(a, sessionId)
    await sessions.state.setSnooze(a, sessionId, null)
    await sessions.state.setSnooze(b, sessionId, '2026-10-03T00:00:00.000Z')
    const rows = await f.stateRows(A)
    expect(rows).toEqual([
      { userId: A, sessionId, readAt: new Date(NOW).toISOString(), snoozedUntil: null },
    ])
    expect(await f.stateRows(B)).toEqual([
      { userId: B, sessionId, readAt: null, snoozedUntil: '2026-10-03T00:00:00.000Z' },
    ])
    expect(await f.stateRows(C)).toEqual([])
    for (const user of [A, B]) {
      const result = await sessions.syncChangesSince(cursor, wirePrincipal(user))
      if (result.kind !== 'delta') throw new Error('expected delta')
      const markers = result.changes.filter((change) => change.entity === 'sessionUserState')
      expect(markers.length).toBeGreaterThan(0)
      expect(markers.every((change) => change.id === sessionUserStateRowId(user, sessionId))).toBe(
        true,
      )
    }
    // Shared sessions are principal-independent; only the personal kind carries markers.
    const shared = await sessions.syncChangesSince(null, wirePrincipal(B))
    if (shared.kind !== 'snapshot') throw new Error('expected snapshot')
    const row = shared.sessions.find((row) => row.sessionId === sessionId)
    expect(row).toBeDefined()
    for (const key of [
      'readAt',
      'unread',
      'snoozedUntil',
      'displayRef',
      'machineName',
      'condition',
      'handoffTarget',
    ])
      expect(row).not.toHaveProperty(key)
    await sessions.state.markRead(b, sessionId)
    expect((await f.stateRows(B))[0]?.readAt).toBe(new Date(NOW).toISOString())
    await sessions.state.markUnread(b, sessionId)
    await sessions.state.clearSnooze(b, sessionId)
    expect(await f.stateRows(B)).toEqual([{ userId: B, sessionId, readAt: null }])
    expect(await f.stateRows(A)).toEqual(rows)
  })

  it('activity snooze clear and terminal unread re-arm update every affected user only', async () => {
    const f = await fixture()
    const { sessions, sessionId, A, a, b } = f
    const { sessionId: other } = await sessions.createSession({ agentKind: 'shell', cwd: '/other' })
    for (const principal of [a, b]) {
      await sessions.state.markRead(principal, sessionId)
      await sessions.state.setSnooze(principal, sessionId, null)
    }
    await sessions.state.setSnooze(a, other, null)
    await sessions.state.clearAllSnoozes(sessionId)
    for (const user of [A, B]) {
      expect((await f.stateRows(user)).find((row) => row.sessionId === sessionId)).toEqual({
        userId: user,
        sessionId,
        readAt: new Date(NOW).toISOString(),
      })
    }
    expect(await sessions.state.isSnoozed(A, other)).toBe(true)
    await sessions.state.rearmUnreadForAll(sessionId)
    for (const user of [A, B])
      expect((await f.stateRows(user)).find((row) => row.sessionId === sessionId)).toEqual({
        userId: user,
        sessionId,
        readAt: null,
      })
    expect((await f.stateRows(A)).find((row) => row.sessionId === other)?.snoozedUntil).toBeNull()
  })

  it('a failed append rolls back the sources and personal authority row', async () => {
    const f = await fixture()
    await f.sessions.state.markRead(f.b, f.sessionId)
    const before = await f.stateRows(B)
    const cursor = await f.reg.changeLedger.cursor()
    const append = vi
      .spyOn(f.store.sync, 'appendChanges')
      .mockRejectedValueOnce(new Error('planted append failure'))
    await expect(f.sessions.state.setSnooze(f.b, f.sessionId, null)).rejects.toThrow(
      'planted append failure',
    )
    append.mockRestore()
    expect(await f.stateRows(B)).toEqual(before)
    expect(await f.store.sessions.sessionUserStateFor(B, f.sessionId, NOW)).toEqual(before[0])
    expect(await f.reg.changeLedger.cursor()).toBe(cursor)
  })

  it('boot reconciliation recovers source markers and retains an explicit cleared row', async () => {
    const f = await fixture()
    await f.sessions.state.markRead(f.b, f.sessionId)
    await f.sessions.state.markUnread(f.b, f.sessionId)
    await f.sessions.state.setSnooze(f.a, f.sessionId, null)
    await f.sessions.loadFromStore()
    expect(await f.stateRows(B)).toEqual([{ userId: B, sessionId: f.sessionId, readAt: null }])
    expect(await f.stateRows(f.A)).toEqual([
      { userId: f.A, sessionId: f.sessionId, readAt: null, snoozedUntil: null },
    ])
  })

  it('sessions.list checks caller visibility and superagent snoozes use the caller source', async () => {
    const f = await fixture()
    await f.sessions.state.markRead(f.a, f.sessionId)
    await f.sessions.state.setSnooze(f.a, f.sessionId, null)
    const family = {
      caller: { userId: B, sessionState: f.b },
      modules: f.reg.modules,
    } as unknown as FamilyState
    const result = await SESSION_QUERIES.list.run(family, {})
    expect(result.find((row) => row.sessionId === f.sessionId)).toBeDefined()
    expect(result.find((row) => row.sessionId === f.sessionId)).not.toHaveProperty('readAt')
    expect(result.find((row) => row.sessionId === f.sessionId)).not.toHaveProperty('unread')
    expect(result.find((row) => row.sessionId === f.sessionId)).not.toHaveProperty('snoozedUntil')
    await f.store.superagent.upsertSuperagentThread({
      id: 'thread:b',
      ownerUserId: B,
      kind: 'global',
    })
    const tools = await buildSuperagentTools(
      { modules: f.reg.modules, repos: { list: async () => [] }, store: f.store, waitPollMs: 1 },
      '',
      asThreadId('thread:b'),
    )
    const tool = tools.find((entry) => entry.spec.name === 'list_sessions')!
    const listed = JSON.parse(await tool.run({})) as {
      sessionId: string
      snoozedUntil?: string | null
    }[]
    expect(listed.find((row) => row.sessionId === f.sessionId)).not.toHaveProperty('snoozedUntil')
    await f.sessions.state.setSnooze(f.b, f.sessionId, '2026-10-03T00:00:00.000Z')
    expect(
      (JSON.parse(await tool.run({})) as typeof listed).find((row) => row.sessionId === f.sessionId)
        ?.snoozedUntil,
    ).toBe('2026-10-03T00:00:00.000Z')
    const anonymous = await buildSuperagentTools(
      { modules: f.reg.modules, repos: { list: async () => [] }, store: f.store, waitPollMs: 1 },
      '',
    )
    expect(await anonymous.find((entry) => entry.spec.name === 'list_sessions')!.run({})).toBe('[]')
  })

  it.each([
    'rename',
    'enroll',
    'revoke',
    'inventory',
  ] as const)('declares one machine and never recaptures sessions on %s', async (verb) => {
    const f = await fixture()
    const id = f.store.hostMachineId
    await f.sessions.flushBroadcasts()
    const capture = vi.spyOn(f.reg.changeLedger, 'capture')
    const dirty = vi.spyOn(f.sessions.repository, 'markVolatileSessionDirty')
    const project = vi.spyOn(f.sessions.view, 'buildProjectionPass')
    if (verb === 'inventory')
      await f.reg.modules.machines.recordInventory(id, {
        os: 'linux',
        arch: 'x64',
        agents: [],
        tools: [],
      })
    if (verb === 'rename') await f.reg.modules.machines.renameMachine(id, 'Renamed')
    if (verb === 'enroll') await f.reg.modules.machines.ensureHostMachine('Enrolled')
    if (verb === 'revoke') await f.reg.modules.machines.revokeMachine(id)
    await f.sessions.flushBroadcasts()
    expect(dirty).not.toHaveBeenCalled()
    expect(project).not.toHaveBeenCalled()
    expect(
      capture.mock.calls.flatMap(([changes]) =>
        changes.filter((change) => change.entity === 'session'),
      ),
    ).toEqual([])
    const declarations = capture.mock.calls.flatMap(([changes]) =>
      changes.filter((change) => change.entity === 'machine'),
    )
    expect(declarations).toEqual([
      {
        entity: 'machine',
        id,
        op: 'upsert',
        value: {
          id,
          name: verb === 'rename' ? 'Renamed' : verb === 'enroll' ? 'Enrolled' : 'Host',
          loggedOutHarnesses: [],
        },
      },
    ])
  })

  it('machine records publish once, remain member-visible, and channel changes do not dirty sessions', async () => {
    const f = await fixture()
    const machine = f.store.hostMachineId
    const cursor = await f.reg.changeLedger.cursor()
    await f.reg.modules.machines.renameMachine(machine, 'Renamed')
    const changes = await f.reg.changeLedger.changesSince(cursor)
    expect(changes?.filter((change) => change.entity === 'machine')).toHaveLength(1)
    const snapshot = await f.sessions.syncChangesSince(null, wirePrincipal(C))
    if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot')
    expect(snapshot.machines).toContainEqual({
      id: machine,
      name: 'Renamed',
      loggedOutHarnesses: [],
    })
    const dirty = vi.spyOn(f.sessions.repository, 'markVolatileSessionDirty')
    dirty.mockClear()
    await f.reg.modules.machines.setUpdateChannel(machine, 'dev')
    expect(dirty).not.toHaveBeenCalled()
    await f.reg.modules.machines.ensureHostMachine('Enrolled')
    expect(await f.reg.changeLedger.authority.snapshot('machine')).toContainEqual({
      id: machine,
      name: 'Enrolled',
      loggedOutHarnesses: [],
    })
    await f.reg.modules.machines.revokeMachine(machine)
    expect(await f.reg.changeLedger.authority.snapshot('machine')).toContainEqual({
      id: machine,
      name: 'Enrolled',
      loggedOutHarnesses: [],
    })
  })

  it('machine inventory records carry logged-out harnesses without copying inventory', async () => {
    const f = await fixture()
    await f.reg.modules.machines.recordInventory(f.store.hostMachineId, {
      os: 'linux',
      arch: 'x64',
      agents: [{ kind: 'codex', installed: true, login: { state: 'out' } }],
      tools: [],
    })
    const rows = await f.reg.changeLedger.authority.snapshot('machine')
    expect(rows).toContainEqual({
      id: f.store.hostMachineId,
      name: 'Host',
      loggedOutHarnesses: ['codex'],
    })
    await f.reg.modules.machines.recordInventory(f.store.hostMachineId, {
      os: 'linux',
      arch: 'x64',
      agents: [{ kind: 'codex', installed: true, login: { state: 'in' } }],
      tools: [],
    })
    expect(await f.reg.changeLedger.authority.snapshot('machine')).toContainEqual({
      id: f.store.hostMachineId,
      name: 'Host',
      loggedOutHarnesses: [],
    })
  })

  it('reference inputs describe drafts and birth issues even after a reattachment', async () => {
    const f = await fixture()
    await f.store.repos.addRepo('/repo', f.store.hostMachineId)
    const repoId = await f.store.repos.resolveRepoIdForPath('/repo', f.store.hostMachineId)
    await f.store.repos.ensurePrefixForRepoId(repoId, 'REF')
    const { sessionId: draft } = await f.sessions.createSession({
      agentKind: 'shell',
      cwd: '/repo',
    })
    expect(await f.sessions.sessionById(draft)).toMatchObject({ refRepoId: repoId, refDraft: 1 })
    const birth = await f.reg.issues.create({ repoPath: '/repo', title: 'Birth', startNow: false })
    await f.sessions.setSessionIssueId(f.sessionId, birth.id)
    const before = await f.sessions.sessionById(f.sessionId)
    expect(before).toMatchObject({ refRepoId: repoId, refSeq: birth.seq, refLetter: 'A' })
    const next = await f.reg.issues.create({ repoPath: '/repo', title: 'Next', startNow: false })
    await f.sessions.setSessionIssueId(f.sessionId, next.id)
    expect(await f.sessions.sessionById(f.sessionId)).toMatchObject({
      refRepoId: repoId,
      refSeq: birth.seq,
      refIssueId: birth.id,
    })
    const newRepo = asRepoId('repo:upgraded')
    const cursor = await f.reg.changeLedger.cursor()
    await f.store.issues.assignRepoIdToIssuesUnder(newRepo, '/repo')
    const changes = await f.reg.changeLedger.changesSince(cursor)
    expect(
      changes?.filter((change) => change.entity === 'session').map((change) => change.id),
    ).toEqual([f.sessionId])
    const published = (await f.reg.changeLedger.authority.snapshot('session')) as {
      sessionId: string
      refRepoId?: string
    }[]
    expect(published.find((row) => row.sessionId === f.sessionId)?.refRepoId).toBe(newRepo)
  })
})
