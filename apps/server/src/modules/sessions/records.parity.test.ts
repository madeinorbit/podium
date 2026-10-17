/**
 * A session's durable record, read from the database, answers as the session
 * itself does (POD-6160; design §7 step 3.2).
 *
 * `SessionRecords` restores a row and its satellites (checkpoint, offer, draft
 * time, conversation id, runtime transcript, turn state) as a plain value
 * through the same mapping the boot restore and a lease's materialize use,
 * never building a `Session`. The map holds running sessions only, so a
 * parked session's reference is the object a lease restores from the same
 * row. Over the benchmark corpus (POD-6146: cell h1a1, seed 4443) with every
 * kind of satellite planted, every session's record equals its session: the
 * resident one for a running session, the restored one for a parked one, wire
 * projection and facts, the live plane included. A lifecycle walk (spawn,
 * bind, resume ref, offer, draft, rename, issue, exit, hibernate, archive) is
 * compared in-process and after a reboot. The selections are compared with
 * their predicate applied to every row.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asIssueId, asSessionId, firstAdminMemberId, type SessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { exportedCorpus, seededStore } from '../../test-support/issue-corpus'
import { corpusSessions, seedCorpusSessions } from '../../test-support/session-corpus'
import { openTestStore } from '../../test-support/open-test-store'
import { residentRecords } from '../../test-support/session-records'
import { durableView, isResident, isRunningStatus, type SessionSubject, subjectFacts, subjectMeta } from './records'
import type { Session } from './session'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const reg of registries.splice(0)) await reg.dispose()
})

async function boot(store: SessionStore): Promise<SessionRegistry> {
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  return reg
}

/** Everything a projection reads off a session, the live plane included. */
function fullView(subject: SessionSubject): unknown {
  return { meta: subjectMeta(subject), facts: subjectFacts(subject) }
}

/** What `view` reads off the session itself: the resident one, else the one a
 *  lease restores from its row (and lets go again). */
async function sessionView<T>(reg: SessionRegistry, id: SessionId, view: (s: Session) => T): Promise<T> {
  return await reg.modules.sessions.residency.withSession(id, 'test', (session) => view(session!))
}

describe('durable session records: the database answers as the session does', () => {
  it('over the benchmark corpus', async () => {
    const store = await openTestStore(':memory:')
    const { planted } = await seedCorpusSessions(store)
    const reg = await boot(store)
    // Boot replays stored runtime events, and a turn a human started records
    // input activity in memory; the activity flush writes it to the row within
    // seconds on a running server. Compare after it, as a reader would.
    await reg.modules.sessions.flushActivity()
    const map = reg.modules.sessions.sessions
    const ids = (await store.sessions.loadSessions()).map((row) => row.id)
    const records = await reg.modules.sessions.records.read(ids)
    for (const id of ids) {
      expect({ id, view: fullView(records.get(id)!) }).toEqual({ id, view: await sessionView(reg, id, fullView) })
    }
    // A record is a plain value: reading one never builds a Session.
    expect([...records.values()].filter(isResident)).toEqual([])
    const resolved = await reg.modules.sessions.records.resolve(ids)
    expect(resolved.size).toBe(ids.length)
    const parked = ids.filter((id) => !isRunningStatus(records.get(id)!.status))
    // Only the running ones (and the headless ones, resident while their row
    // exists) are in memory.
    expect(map.size).toBe(ids.filter((id) => isRunningStatus(records.get(id)!.status) || records.get(id)!.headless).length)
    console.log(
      'session record parity over the corpus',
      JSON.stringify({ sessions: ids.length, parked: parked.length, ...planted }),
    )
    expect(ids.length).toBeGreaterThan(100)
    expect(parked.length).toBeGreaterThan(0)
    expect([...records.values()].some((s) => s.offer)).toBe(true)
    expect([...records.values()].some((s) => s.transcriptAvailable)).toBe(true)
    expect([...records.values()].some((s) => s.draftUpdatedAt)).toBe(true)
    expect([...records.values()].some((s) => s.conversationPodiumId)).toBe(true)
  }, 60_000)

  it('over a lifecycle walk, in-process and after a reboot', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-session-records-')), 'state.sqlite')
    const store = await openTestStore(file)
    await store.repos.addRepo('/r/podium', store.hostMachineId)
    const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    await attachHostDaemon(reg)
    const sessions = reg.modules.sessions
    const machine = store.hostMachineId
    const issue = await reg.modules.issues.crud.create({ repoPath: '/r/podium', title: 'T', startNow: false })
    const spawn = async (cwd: string, agentKind: 'shell' | 'codex' | 'claude-code' = 'claude-code') => {
      const { sessionId } = await sessions.createSession({ agentKind, cwd })
      await reg.gateway.routeDaemonFrame(machine, {
        type: 'bind',
        sessionId,
        cmd: agentKind,
        cwd,
        agentKind,
        geometry: { cols: 100, rows: 30 },
      } as never)
      return sessionId
    }
    const ids: SessionId[] = []
    for (let i = 0; i < 6; i++) ids.push(await spawn(`/r/podium/w${i}`, i % 3 === 2 ? 'shell' : 'claude-code'))
    const [exited, hibernated, archived, renamed, attached, running] = ids as [
      SessionId,
      SessionId,
      SessionId,
      SessionId,
      SessionId,
      SessionId,
    ]
    for (const id of [exited, hibernated, archived, renamed]) {
      await reg.gateway.routeDaemonFrame(machine, {
        type: 'sessionResumeRef',
        sessionId: id,
        resume: { kind: 'claude', value: `conv-${id}` },
      })
    }
    await sessions.setOffer({
      sessionId: exited,
      message: 'next',
      actions: [{ label: 'Merge', prompt: 'merge' }],
    } as never)
    await sessions.renameSession({ sessionId: renamed, name: 'Renamed' })
    await sessions.setSessionIssueId(attached, issue.id)
    await reg.gateway.routeDaemonFrame(machine, { type: 'agentExit', sessionId: exited, code: 0 })
    await reg.gateway.routeDaemonFrame(machine, { type: 'agentExit', sessionId: renamed, code: 1 })
    expect((await sessions.hibernateSession({ sessionId: hibernated })).ok).toBe(true)
    await reg.gateway.routeDaemonFrame(machine, { type: 'agentExit', sessionId: archived, code: 0 })
    await sessions.setArchived({ sessionId: archived, archived: true } as never)
    await sessions.flushActivity()

    // In-process: every stopped session's record equals the session (a running
    // one's volatile fields reach its row by a later sweep; resident wins).
    const map = sessions.sessions
    const resolved = await sessions.records.resolve(ids)
    expect([...resolved.keys()]).toEqual(ids)
    for (const id of ids.filter((id) => !isRunningStatus(resolved.get(id)!.status))) {
      expect(durableView((await sessions.records.read([id])).get(id)!)).toEqual(await sessionView(reg, id, durableView))
    }
    expect(isRunningStatus(map.get(running)!.status)).toBe(true)
    // Stopped sessions are not in memory: only the two that still run are.
    expect([...map.keys()].filter((id) => ids.includes(id)).sort()).toEqual([attached, running].sort())
    // D2c: who each session acts for, and the capability built from it.
    for (const id of ids) {
      expect(await sessions.records.ownershipOf(id, 'test')).toMatchObject({ sessionId: id, cwd: resolved.get(id)!.cwd })
      expect((await sessions.capabilityForSession(id)).actorSessionId).toBe(id)
    }
    expect(await sessions.records.ownershipOf(asSessionId('nope'), 'test')).toBeUndefined()

    // After a reboot: full equality, the live plane included.
    await reg.dispose()
    await store.close()
    const store2 = await openTestStore(file)
    const reg2 = await boot(store2)
    await reg2.modules.sessions.flushActivity()
    const records2 = await reg2.modules.sessions.records.read(ids)
    for (const id of ids) {
      expect({ id, view: fullView(records2.get(id)!) }).toEqual({ id, view: await sessionView(reg2, id, fullView) })
    }
    expect(records2.get(renamed)?.name).toBe('Renamed')
    expect(records2.get(attached)?.issueId).toBe(issue.id)
    expect(records2.get(archived)?.archived).toBe(true)
    expect(records2.get(hibernated)?.status).toBe('hibernated')
  })

  it('selects the sessions its predicate selects from every row, over the benchmark corpus', async () => {
    const corpus = await corpusSessions()
    const issues = (await exportedCorpus()).issues
    const repos = [...new Set([...corpus.repos, ...issues.flatMap((row) => (row.repoPath ? [row.repoPath] : []))])]
    const store = await seededStore(issues, repos)
    const admin = await firstAdminMemberId(store)
    const seqOf = new Map(issues.map((issue) => [issue.id, issue.seq]))
    const sessions = [
      ...corpus.sessions,
      // Windows-style roots: membership ignores ASCII case and separator spelling.
      ...['C:\\Repo\\wt\\a', 'c:/repo/wt/b', 'C:\\Repo\\wt', 'C:\\Repo\\wt2\\c'].map((cwd, i) => ({
        ...corpus.sessions[0]!,
        id: `win-${i}`,
        cwd,
        issueId: null,
      })),
    ]
    await store.transact(async () => {
      for (const [index, s] of sessions.entries()) {
        const parent = index % 7 === 3 ? sessions[index - 1]?.id : undefined
        const letter = s.issueId && seqOf.has(s.issueId) && index % 2 === 0 ? String.fromCharCode(65 + (index % 26)) : null
        await store.sessions.upsertSession({
          id: asSessionId(s.id),
          ownerUserId: admin,
          agentKind: s.agentKind,
          cwd: s.cwd,
          title: s.title,
          name: null,
          originKind: 'spawn',
          conversationId: null,
          resumeKind: s.resumeKind,
          resumeValue: s.resumeValue,
          status: s.status as never,
          exitCode: s.status === 'exited' ? 0 : null,
          durableLabel: `podium-${s.id}`,
          createdAt: s.createdAt,
          lastActiveAt: s.lastActiveAt,
          lastOutputAt: null,
          lastInputAt: null,
          lastResumedAt: null,
          archived: s.archived,
          workState: null,
          machineId: store.hostMachineId,
          headless: s.headless,
          issueId: s.issueId === null ? null : asIssueId(s.issueId),
          stoppedAt: s.stoppedAt,
          ...(parent ? { spawnedBy: `session:${parent}` } : {}),
          ...(letter && s.issueId ? { refIssueId: asIssueId(s.issueId), refLetter: letter } : {}),
          ...(!letter && index % 5 === 1 ? { refDraft: (index % 9) + 1 } : {}),
        } as never)
      }
    })
    const reg = await boot(store)
    await reg.modules.sessions.flushActivity()
    const records = reg.modules.sessions.records
    // THE ORACLE: each selection's rule applied to every row's record.
    const every = await records.read((await store.sessions.loadSessions()).map((row) => row.id))
    const oracle = residentRecords(every as unknown as ReadonlyMap<SessionId, Session>)
    const all = [...every.values()]
    let selections = 0
    const nonEmpty: string[] = []
    const ids = (subjects: readonly SessionSubject[]) => subjects.map((s) => s.sessionId).sort()
    const ask = async (label: string, answer: Promise<SessionSubject[]>, expected: Promise<SessionSubject[]> | SessionSubject[]) => {
      const got = await answer
      expect({ label, ids: ids(got) }).toEqual({ label, ids: ids(await expected) })
      selections += 1
      if (got.length > 0) nonEmpty.push(label)
    }
    await ask('all', records.all('test'), oracle.all('test'))
    for (const issue of issues.filter((_, index) => index % 20 === 0)) {
      const issueId = asIssueId(issue.id)
      await ask('issueMembers', records.issueMembers(issue.worktreePath, issueId, 'test'), oracle.issueMembers(issue.worktreePath, issueId, 'test'))
      if (issue.worktreePath) await ask('underPath', records.underPath(issue.worktreePath, 'test'), oracle.underPath(issue.worktreePath, 'test'))
    }
    for (const root of ['C:\\Repo\\wt', 'c:\\REPO\\WT', 'C:/Repo/wt2', '/nowhere']) {
      await ask('underPath.windows', records.underPath(root, 'test'), oracle.underPath(root, 'test'))
    }
    await ask('onMachine', records.onMachine(store.hostMachineId, 'test'), oracle.onMachine(store.hostMachineId, 'test'))
    for (const s of all.filter((_, index) => index % 200 === 0)) {
      for (const length of [2, 4]) {
        const prefix = s.sessionId.slice(0, length)
        await ask('withIdPrefix', records.withIdPrefix(prefix, 'test'), oracle.withIdPrefix(prefix, 'test'))
      }
    }
    for (const s of all.filter((session, index) => session.refLetter && session.refIssueId && index % 10 === 0)) {
      const seq = seqOf.get(s.refIssueId!)!
      // The oracle's letter rule, narrowed to the issues numbered `seq`.
      const expected = (await oracle.birthRefCandidates({ seq, letter: s.refLetter! }, 'test')).filter(
        (candidate) => candidate.refIssueId !== null && seqOf.get(candidate.refIssueId) === seq,
      )
      await ask('birthRef', records.birthRefCandidates({ seq, letter: s.refLetter! }, 'test'), expected)
    }
    for (const draft of [1, 2, 3, 99]) {
      await ask('draftRef', records.birthRefCandidates({ draft }, 'test'), oracle.birthRefCandidates({ draft }, 'test'))
    }
    const parents = all.filter((_, index) => index % 7 === 2).map((s) => s.sessionId)
    await ask('childrenOf', records.childrenOf(parents, 'test'), oracle.childrenOf(parents, 'test'))
    await ask('withStatuses.parked', records.withStatuses(['hibernated', 'exited'], 'test'), oracle.withStatuses(['hibernated', 'exited'], 'test'))
    await ask('withStatuses.running', records.withStatuses(['starting', 'live', 'reconnecting'], 'test'), oracle.withStatuses(['starting', 'live', 'reconnecting'], 'test'))
    for (const s of all.filter((session, index) => session.resume && index % 25 === 0)) {
      await ask('withResume', records.withResume(s.resume!, 'test'), oracle.withResume(s.resume!, 'test'))
    }
    const referenced = [...new Set(all.flatMap((s) => (s.refIssueId ? [s.refIssueId] : [])))].filter((_, index) => index % 5 === 0)
    await ask('referencingIssues', records.referencingIssues(referenced, 'test'), oracle.referencingIssues(referenced, 'test'))
    console.log('session selection parity over the corpus', JSON.stringify({ sessions: all.length, selections }))
    for (const label of ['all', 'issueMembers', 'underPath', 'underPath.windows', 'onMachine', 'withIdPrefix', 'birthRef', 'draftRef', 'childrenOf', 'withStatuses.parked', 'withResume', 'referencingIssues']) {
      expect(nonEmpty, label).toContain(label)
    }
    // The Windows root finds both spellings below it and not its sibling.
    expect((await records.underPath('C:\\Repo\\wt', 'test')).map((s) => s.sessionId).sort()).toEqual(['win-0', 'win-1', 'win-2'])
  }, 120_000)

  it('reads no record for a deleted or unknown session', async () => {
    const store = await openTestStore(':memory:')
    const reg = await boot(store)
    await attachHostDaemon(reg)
    const { sessionId } = await reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/x' })
    await store.sessions.softDeleteSessions([sessionId], '2026-10-01T00:00:00.000Z', 'user' as never)
    const records = await reg.modules.sessions.records.read([sessionId, asSessionId('nope')])
    expect(records.size).toBe(0)
  })
})
