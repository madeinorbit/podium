/**
 * A session's durable record, read from the database, answers as the session
 * map does (POD-6160 D2a; design §7 step 3.2).
 *
 * `SessionRecords` restores a row and its satellites (checkpoint, offer, draft
 * time, conversation id, runtime transcript) as a plain value through the same
 * mapping the boot restore uses, never building a `Session`. This file boots
 * the session map over the benchmark corpus (POD-6146: cell h1a1, seed 4443)
 * with every kind of satellite planted, and
 * compares every session's record with its map object: wire projection and
 * facts, the live plane included, because a session restored at boot and one
 * restored as a record are the same restore. A lifecycle walk (spawn, bind,
 * resume ref, offer, draft, rename, issue, exit, hibernate, archive) is then
 * compared in-process, where stopped sessions keep their live plane in the map
 * (not compared, see `LIVE_PLANE_META_FIELDS`), and again after a reboot. The
 * last case plants a difference to prove the comparison is armed.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asIssueId, asSessionId, asUserId, firstAdminMemberId, type SessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import type { SessionStore } from '../../store'
import { RUNTIME_EVENT_LOG_KIND } from '../../store/events'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { exportedCorpus, seededStore } from '../../test-support/issue-corpus'
import { openTestStore } from '../../test-support/open-test-store'
import { SessionMapParityError, sessionMapParityMode } from './map-parity'
import { durableView, isResident, isRunningStatus, type SessionSubject, subjectFacts, subjectMeta } from './records'

interface CorpusSession {
  id: string
  agentKind: string
  title: string
  cwd: string
  status: string
  archived: boolean
  createdAt: string
  lastActiveAt: string
  issueId: string | null
  headless: boolean
  resumeKind: string | null
  resumeValue: string | null
  stoppedAt: string | null
}

async function corpusSessions(): Promise<{ sessions: CorpusSession[]; repos: string[] }> {
  const module = fileURLToPath(
    new URL('../../../../../scripts/server-data-bench/corpus-export.ts', import.meta.url),
  )
  const { exportCorpus } = (await import(module)) as {
    exportCorpus(cell: string, seed: number): Promise<{ sessions: CorpusSession[]; repos: string[] }>
  }
  return await exportCorpus('h1a1', 4443)
}

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

const at = (minute: number) => `2026-09-01T00:${String(minute % 60).padStart(2, '0')}:00.000Z`

async function plantSatellites(store: SessionStore, ids: readonly string[], resumes: Map<string, string>) {
  let offers = 0
  let drafts = 0
  let transcripts = 0
  let conversations = 0
  for (const [index, raw] of ids.entries()) {
    const id = asSessionId(raw)
    if (index % 5 === 0) {
      // Every other offer predates the row's last input, which the boot install
      // clears and a record reads as absent.
      await store.sessions.setOffer(id, {
        message: `offer ${index}`,
        actions: [{ label: 'Go', prompt: 'go' }],
        ...(index % 10 === 0 ? { artifacts: ['shot.png'] } : {}),
        createdAt: index % 10 === 0 ? '2026-08-01T00:00:00.000Z' : '2026-10-01T00:00:00.000Z',
      })
      offers += 1
    }
    if (index % 7 === 0) {
      await store.sessions.setDraft(id, `draft ${index}`)
      drafts += 1
    }
    // The causal envelope every stored runtime event carries (the boot replay
    // parses it; an event without it is skipped there).
    const event = (body: Record<string, unknown>) =>
      store.events.appendEvent({
        ts: at(index),
        kind: RUNTIME_EVENT_LOG_KIND,
        subject: id,
        payload: {
          ...body,
          at: at(index),
          provenance: 'live',
          observerGeneration: 1,
          turnEpoch: 1,
          cursor: { segmentId: 'segment', components: { seq: index } },
        },
      })
    const complete = (n: number) => ({
      t: 'item',
      item: { kind: 'complete', item: { id: `item-${index}-${n}`, role: 'assistant', text: 'hi', ts: at(index) } },
    })
    switch (index % 6) {
      case 1: // items, no reset
        await event(complete(1))
        transcripts += 1
        break
      case 2: // items, then a reset with none: nothing since the reset
        await event(complete(1))
        await event({ t: 'transcript-reset', items: [] })
        transcripts += 1
        break
      case 3: // a reset carrying items
        await event({
          t: 'transcript-reset',
          items: [{ id: `seed-${index}`, role: 'user', text: 'seed', ts: at(index) }],
        })
        transcripts += 1
        break
      case 4: // a reset with none, then items
        await event({ t: 'transcript-reset', items: [] })
        await event(complete(2))
        transcripts += 1
        break
      case 5: // runtime events that are not transcript items
        await event({ t: 'turn', ev: { ev: 'started', turnEpoch: 1, origin: 'human' } })
        break
    }
    const resume = resumes.get(raw)
    if (resume && index % 3 === 0) {
      await store.conversations.registry.ensure({
        machineId: store.hostMachineId,
        nativeId: resume,
        providerId: 'claude-code',
      })
      conversations += 1
    }
  }
  return { offers, drafts, transcripts, conversations }
}

describe('durable session records: the database answers as the session map', () => {
  it('compares in throw mode under vitest', () => {
    expect(sessionMapParityMode()).toBe('throw')
  })

  it('over the benchmark corpus', async () => {
    const corpus = await corpusSessions()
    const store = await openTestStore(':memory:')
    for (const repo of corpus.repos) await store.repos.addRepo(repo, store.hostMachineId)
    const resumes = new Map<string, string>()
    const admin = await firstAdminMemberId(store)
    await store.transact(async () => {
      for (const [index, s] of corpus.sessions.entries()) {
        if (s.resumeValue) resumes.set(s.id, s.resumeValue)
        await store.sessions.upsertSession({
          id: asSessionId(s.id),
          ownerUserId: index % 6 === 0 ? asUserId('user:other') : admin,
          agentKind: s.agentKind,
          cwd: s.cwd,
          title: s.title,
          name: index % 4 === 0 ? `named ${index}` : null,
          ...(index % 4 === 0 ? { nameSource: index % 8 === 0 ? 'user' : 'agent' } : {}),
          originKind: s.resumeValue ? 'resume' : 'spawn',
          conversationId: s.resumeValue,
          resumeKind: s.resumeKind,
          resumeValue: s.resumeValue,
          status: s.status as never,
          exitCode: s.status === 'exited' ? index % 3 : null,
          durableLabel: `podium-${s.id}`,
          createdAt: s.createdAt,
          lastActiveAt: s.lastActiveAt,
          lastOutputAt: null,
          lastInputAt: index % 10 === 0 ? '2026-09-01T00:00:00.000Z' : null,
          lastResumedAt: null,
          archived: s.archived,
          workState: index % 9 === 0 ? 'done' : null,
          machineId: store.hostMachineId,
          headless: s.headless,
          issueId: s.issueId === null ? null : asIssueId(s.issueId),
          stoppedAt: s.stoppedAt,
          ...(s.stoppedAt ? { stopReason: 'self' as const } : {}),
          ...(index % 11 === 0 ? { workingMsTotal: index * 1000 } : {}),
          ...(index % 13 === 0 ? { conversationBinding: 'never' as const } : {}),
        } as never)
      }
    })
    const planted = await plantSatellites(
      store,
      corpus.sessions.map((s) => s.id),
      resumes,
    )
    const reg = await boot(store)
    // Boot replays stored runtime events, and a turn a human started records
    // input activity in memory; the activity flush writes it to the row within
    // seconds on a running server. Compare after it, as a reader would.
    await reg.modules.sessions.flushActivity()
    const map = reg.modules.sessions.sessions
    const ids = [...map.keys()]
    const records = await reg.modules.sessions.records.read(ids)
    for (const id of ids) {
      expect({ id, view: fullView(records.get(id)!) }).toEqual({ id, view: fullView(map.get(id)!) })
    }
    // A record is a plain value: reading one never builds a Session.
    expect([...records.values()].filter(isResident)).toEqual([])
    // The resolve path compares the parked ones itself, and throws on a difference.
    const resolved = await reg.modules.sessions.records.resolve(ids)
    expect(resolved.size).toBe(ids.length)
    const parked = ids.filter((id) => !isRunningStatus(map.get(id)!.status))
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

    // In-process: every stopped session is read as a record and compared (throws).
    const map = sessions.sessions
    const resolved = await sessions.records.resolve(ids)
    expect([...resolved.keys()]).toEqual(ids)
    for (const id of ids.filter((id) => !isRunningStatus(map.get(id)!.status))) {
      expect(durableView((await sessions.records.read([id])).get(id)!)).toEqual(durableView(map.get(id)!))
    }
    expect(isRunningStatus(map.get(running)!.status)).toBe(true)

    // After a reboot the map is the boot restore: full equality.
    await reg.dispose()
    await store.close()
    const store2 = await openTestStore(file)
    const reg2 = await boot(store2)
    await reg2.modules.sessions.flushActivity()
    const map2 = reg2.modules.sessions.sessions
    const records2 = await reg2.modules.sessions.records.read(ids)
    for (const id of ids) {
      expect({ id, view: fullView(records2.get(id)!) }).toEqual({ id, view: fullView(map2.get(id)!) })
    }
    expect(records2.get(renamed)?.name).toBe('Renamed')
    expect(records2.get(attached)?.issueId).toBe(issue.id)
    expect(records2.get(archived)?.archived).toBe(true)
    expect(records2.get(hibernated)?.status).toBe('hibernated')
  })

  it('selects the same sessions as the map, over the benchmark corpus', async () => {
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
    const map = reg.modules.sessions.sessions
    const resident = [...map.values()]
    let selections = 0
    const nonEmpty: string[] = []
    const ask = async (label: string, answer: Promise<SessionSubject[]>) => {
      const got = await answer
      selections += 1
      if (got.length > 0) nonEmpty.push(label)
    }
    await ask('all', records.all('test'))
    for (const issue of issues.filter((_, index) => index % 20 === 0)) {
      await ask('issueMembers', records.issueMembers(issue.worktreePath, asIssueId(issue.id), 'test'))
      if (issue.worktreePath) await ask('underPath', records.underPath(issue.worktreePath, 'test'))
    }
    for (const root of ['C:\\Repo\\wt', 'c:\\REPO\\WT', 'C:/Repo/wt2', '/nowhere']) {
      await ask('underPath.windows', records.underPath(root, 'test'))
    }
    await ask('onMachine', records.onMachine(store.hostMachineId, 'test'))
    for (const s of resident.filter((_, index) => index % 200 === 0)) {
      for (const length of [2, 4]) await ask('withIdPrefix', records.withIdPrefix(s.sessionId.slice(0, length), 'test'))
    }
    for (const s of resident.filter((session, index) => session.refLetter && session.refIssueId && index % 10 === 0)) {
      await ask('birthRef', records.birthRefCandidates({ seq: seqOf.get(s.refIssueId!)!, letter: s.refLetter! }, 'test'))
    }
    for (const draft of [1, 2, 3, 99]) await ask('draftRef', records.birthRefCandidates({ draft }, 'test'))
    await ask('childrenOf', records.childrenOf(resident.filter((_, index) => index % 7 === 2).map((s) => s.sessionId), 'test'))
    await ask('withStatuses.parked', records.withStatuses(['hibernated', 'exited'], 'test'))
    await ask('withStatuses.running', records.withStatuses(['starting', 'live', 'reconnecting'], 'test'))
    console.log('session selection parity over the corpus', JSON.stringify({ sessions: resident.length, selections }))
    for (const label of ['all', 'issueMembers', 'underPath', 'underPath.windows', 'onMachine', 'withIdPrefix', 'birthRef', 'draftRef', 'childrenOf', 'withStatuses.parked']) {
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

  it('is armed: a parked session that differs from its row throws', async () => {
    const store = await openTestStore(':memory:')
    const reg = await boot(store)
    await attachHostDaemon(reg)
    const { sessionId } = await reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/x' })
    await reg.gateway.routeDaemonFrame(store.hostMachineId, { type: 'agentExit', sessionId, code: 0 })
    await reg.modules.sessions.flushActivity()
    await reg.modules.sessions.records.resolve([sessionId])
    // Planted: the map says a title the row never got.
    reg.modules.sessions.sessions.get(sessionId)!.title = 'only in memory'
    await expect(reg.modules.sessions.records.resolve([sessionId])).rejects.toBeInstanceOf(SessionMapParityError)
  })
})
