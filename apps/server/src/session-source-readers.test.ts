import {
  asIssueId,
  asMachineId,
  asRepoId,
  asSessionId,
  asThreadId,
  asUserId,
  firstAdminMemberId,
  type SessionMeta,
} from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeOracles, makeOracle } from './modules/sessions/oracle-support'
import { readSessionRefs, type SessionRefFacts } from './modules/sessions/refs'
import { buildSuperagentTools } from './modules/superagent/tools'
import type { IssueRow } from './store'

afterEach(async () => {
  await disposeOracles()
  vi.restoreAllMocks()
})

const MACHINE = asMachineId('machine:a')
const OTHER_MACHINE = asMachineId('machine:b')
const REPO = asRepoId('repo:a')
const OTHER_REPO = asRepoId('repo:b')
const BIRTH = asIssueId('issue:birth')

function refFacts(over: Partial<SessionRefFacts> = {}): SessionRefFacts {
  return {
    sessionId: asSessionId('session:a'),
    machineId: MACHINE,
    cwd: '/repo/worktree',
    refIssueId: BIRTH,
    refLetter: 'A',
    refDraft: null,
    ...over,
  }
}

function refSources() {
  const issue = { id: BIRTH, seq: 13, repoId: REPO, repoPath: '/repo', machineId: MACHINE }
  const rows = new Map<string, Pick<IssueRow, 'id' | 'seq' | 'repoId' | 'repoPath' | 'machineId'>>([
    [BIRTH, issue],
  ])
  const prefixes = new Map([
    [REPO, 'SRC'],
    [OTHER_REPO, 'ALT'],
  ])
  const getIssues = vi.fn(
    async (ids: readonly string[]) =>
      new Map(ids.flatMap((id) => (rows.has(id) ? [[id, rows.get(id)!] as const] : []))),
  )
  // The path alone would select OTHER_REPO. Birth refs must prefer their own
  // repoId; drafts and pre-upgrade issue rows must supply their machine.
  const repoIdForPath = vi.fn((_path: string, machineId?: typeof MACHINE | null) =>
    machineId === MACHINE ? REPO : OTHER_REPO,
  )
  const prefixForRepoId = vi.fn(async (repoId: typeof REPO) => prefixes.get(repoId) ?? null)
  const repoIdResolver = vi.fn(async () => repoIdForPath)
  const store = {
    issues: { getIssues },
    repos: { repoIdResolver, prefixForRepoId },
  } as unknown as Parameters<typeof readSessionRefs>[0]
  return { store, rows, prefixes, getIssues, repoIdResolver, repoIdForPath, prefixForRepoId }
}

describe('S4 session refs from source rows', () => {
  it('uses birth repo identity and current sequence/prefix, with bounded source reads', async () => {
    const f = refSources()
    const sessions = [refFacts(), refFacts({ sessionId: asSessionId('session:b'), refLetter: 'B' })]
    expect([...(await readSessionRefs(f.store, sessions))]).toEqual([
      ['session:a', 'SRC-13-A'],
      ['session:b', 'SRC-13-B'],
    ])
    expect(f.getIssues).toHaveBeenCalledExactlyOnceWith([BIRTH])
    expect(f.prefixForRepoId).toHaveBeenCalledExactlyOnceWith(REPO)
    expect(f.repoIdResolver).not.toHaveBeenCalled()
    f.rows.get(BIRTH)!.seq = 21
    f.prefixes.set(REPO, 'NEW')
    expect((await readSessionRefs(f.store, sessions)).get(asSessionId('session:a'))).toBe(
      'NEW-21-A',
    )
  })

  it('resolves draft zero on its reporting machine even when another machine has the same path', async () => {
    const f = refSources()
    const drafts = [
      refFacts({ refIssueId: null, refLetter: null, refDraft: 0 }),
      refFacts({
        sessionId: asSessionId('other'),
        machineId: OTHER_MACHINE,
        refIssueId: null,
        refLetter: null,
        refDraft: 7,
      }),
    ]
    expect([...(await readSessionRefs(f.store, drafts))]).toEqual([
      ['session:a', 'SRC-DRAFT-0'],
      ['other', 'ALT-DRAFT-7'],
    ])
    expect(f.repoIdResolver).toHaveBeenCalledTimes(1)
    expect(f.repoIdForPath.mock.calls).toEqual([
      ['/repo/worktree', MACHINE],
      ['/repo/worktree', OTHER_MACHINE],
    ])
  })

  it('preserves pre-upgrade repo lookup and omits refs whose issue or prefix is missing', async () => {
    const f = refSources()
    f.rows.get(BIRTH)!.repoId = null
    expect((await readSessionRefs(f.store, [refFacts()])).get(asSessionId('session:a'))).toBe(
      'SRC-13-A',
    )
    expect(f.repoIdForPath).toHaveBeenCalledWith('/repo', MACHINE)
    f.prefixes.delete(REPO)
    expect(await readSessionRefs(f.store, [refFacts()])).toEqual(new Map())
    f.rows.clear()
    expect(await readSessionRefs(f.store, [refFacts({ refDraft: 9 })])).toEqual(new Map())
    expect(await readSessionRefs(f.store, [])).toEqual(new Map())
  })
})

describe('S4 server consumers', () => {
  it('superagent reads its owner row despite stale session snoozes, including absent, null, timed and expired', async () => {
    let now = Date.parse('2026-10-02T12:00:00.000Z')
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const o = await makeOracle({ now: () => now })
    const sessions = o.reg.modules.sessions
    const A = await firstAdminMemberId(o.store)
    const B = asUserId('user:b')
    await o.store.users.create(
      {
        id: B,
        displayName: 'B',
        role: 'member',
        createdAt: '2026-01-01T00:00:00.000Z',
        disabledAt: null,
      },
      'fixture-hash',
    )
    const { sessionId } = await sessions.createSession({ agentKind: 'shell', cwd: '/source' })
    const { sessionId: privateId } = await sessions.createSession({
      agentKind: 'shell',
      cwd: '/private',
    })
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
    await sessions.state.setSnooze(a, sessionId, null)
    await o.store.superagent.upsertSuperagentThread({
      id: 'thread:b',
      ownerUserId: B,
      kind: 'global',
    })
    const list = sessions.listSessions.bind(sessions)
    vi.spyOn(sessions, 'listSessions').mockImplementation(async (principal, caller) =>
      (await list(principal, caller)).map((s) => ({ ...s, snoozedUntil: 'stale-wire' })),
    )
    const tools = await buildSuperagentTools(
      { modules: o.reg.modules, repos: { list: async () => [] }, store: o.store, waitPollMs: 1 },
      '',
      asThreadId('thread:b'),
    )
    const tool = tools.find((t) => t.spec.name === 'list_sessions')!
    const rows = async () => JSON.parse(await tool.run({})) as SessionMeta[]
    expect((await rows()).map((s) => s.sessionId)).not.toContain(privateId)
    expect((await rows()).find((s) => s.sessionId === sessionId)).not.toHaveProperty('snoozedUntil')
    await sessions.state.setSnooze(b, sessionId, null)
    expect((await rows()).find((s) => s.sessionId === sessionId)?.snoozedUntil).toBeNull()
    const until = '2026-10-03T00:00:00.000Z'
    await sessions.state.setSnooze(b, sessionId, until)
    expect((await rows()).find((s) => s.sessionId === sessionId)?.snoozedUntil).toBe(until)
    now = Date.parse(until) + 1
    expect((await rows()).find((s) => s.sessionId === sessionId)).not.toHaveProperty('snoozedUntil')
    const anonymous = await buildSuperagentTools(
      { modules: o.reg.modules, repos: { list: async () => [] }, store: o.store, waitPollMs: 1 },
      '',
    )
    expect(await anonymous.find((t) => t.spec.name === 'list_sessions')!.run({})).toBe('[]')
  })

  it('the wired toolkit observes prefix and machine renames from source while old records remain intact', async () => {
    const o = await makeOracle()
    const machineId = o.store.hostMachineId
    await o.store.repos.addRepo('/source', machineId)
    await o.repos.setPrefix('/source', 'SRC', machineId)
    const issue = await o.reg.issues.create({
      repoPath: '/source',
      title: 'Source refs',
      startNow: false,
    })
    const sessions = o.reg.modules.sessions
    const parent = await sessions.createSession({
      agentKind: 'shell',
      cwd: '/source',
      issueId: issue.id,
    })
    const child = await sessions.createSession({
      agentKind: 'shell',
      cwd: '/source',
      issueId: issue.id,
      spawnedBy: `session:${parent.sessionId}`,
    })
    const toolkit = o.reg.modules.readToolkit
    const sourceRef = `SRC-${issue.seq}-B`
    const byId = sessions.sessionById.bind(sessions)
    const byIds = sessions.sessionsById.bind(sessions)
    vi.spyOn(sessions, 'sessionById').mockImplementation(async (id) => {
      const s = await byId(id)
      return s ? { ...s, machineName: 'stale-machine' } : undefined
    })
    vi.spyOn(sessions, 'sessionsById').mockImplementation(async (ids) =>
      (await byIds(ids)).map((s) => ({ ...s, displayRef: 'OLD-1-A' })),
    )
    expect(await toolkit.resolveIdentifier(sourceRef)).toEqual({
      kind: 'session',
      sessionId: child.sessionId,
    })
    expect((await toolkit.status(parent.sessionId, 'operator')).subagents).toEqual([
      expect.objectContaining({ sessionId: child.sessionId, displayRef: sourceRef }),
    ])
    const before = await o.reg.changeLedger.authority.snapshot('session')
    const cursor = await o.reg.changeLedger.cursor()
    await o.repos.setPrefix('/source', 'NEW', machineId)
    const nextRef = `NEW-${issue.seq}-B`
    expect(await toolkit.resolveIdentifier(sourceRef)).toEqual({ kind: 'absent' })
    expect(await toolkit.resolveIdentifier(nextRef)).toEqual({
      kind: 'session',
      sessionId: child.sessionId,
    })
    expect((await toolkit.status(parent.sessionId, 'operator')).subagents[0]?.displayRef).toBe(
      nextRef,
    )
    expect(await o.reg.changeLedger.authority.snapshot('session')).toEqual(before)
    expect(
      (await o.reg.changeLedger.changesSince(cursor))?.filter((c) => c.entity === 'session'),
    ).toEqual([])
    await o.reg.modules.machines.renameMachine(machineId, 'Source machine')
    expect((await toolkit.status(parent.sessionId, 'operator')).machine).toBe('Source machine')
  })
})
