/**
 * SESSIONS AND USER STATE ARE A WORKSPACE'S (POD-6959 design 2.4, 2.5; task POD-7015).
 *
 * Two workspaces over one database (`openWorkspaceStores`), each seeded through its own
 * repositories with its own sessions, pins, snoozes, read markers, offers, tab orders, drafts,
 * layout, dock shells, preferences and read positions.
 * The ids differ between the workspaces, so a read or write aimed at the other workspace's ids
 * has ids only that workspace holds to miss. Since the key migration (POD-7024) every key
 * leads with workspace_id and the same id is two rows; the cases that hold the same ids in
 * both are marked below, and the rest of the conversion is POD-7025's.
 *
 * For every repository method of the group:
 *   - a read answers only its own workspace's rows, including the reads across people and the
 *     boot reconcile pages;
 *   - an update, delete or upsert in one workspace leaves the other's rows unchanged, including
 *     a write in A addressed at B's own ids (purge, tombstone, clear, remove), which must find
 *     nothing to change;
 *   - the written-columns hint stays per repository, so a write in A forgets nothing in B.
 */

import {
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  type IssueId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openWorkspaceStores } from '../test-support/workspace-stores'
import type { SessionRow } from './types'

type Tag = 'a' | 'b'
const WS: Record<Tag, string> = { a: 'ws_a', b: 'ws_b' }
const AT = '2026-11-17T10:00:00.000Z'
const LATER = '2099-01-01T00:00:00.000Z'
const scope = fixtureWriteScope()

const user = (tag: Tag, name = 'alice'): UserId => asUserId(`user:${tag}-${name}`)
const sid = (tag: Tag, n: number): SessionId => asSessionId(`${tag}-s${n}`)
const iss = (tag: Tag, n: number): IssueId => asIssueId(`${tag}-iss-${n}`)
const machine = (tag: Tag) => asMachineId(`${tag}-machine`)
const root = (tag: Tag) => `/repo-${tag}`
/** An issue only `tag`'s workspace holds, which the OTHER workspace's s5 names. */
const heldBy = (tag: Tag): IssueId => asIssueId(`held-by-${tag}`)

let opened: SessionStore | undefined

afterEach(async () => {
  await opened?.close()
  opened = undefined
})

interface RawDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
}
const rawDb = (store: SessionStore): RawDb => (store as unknown as { db: RawDb }).db

/** The tables this group owns, read raw per workspace, for "unchanged" comparisons. */
const TABLES = [
  'sessions',
  'pins',
  'snoozes',
  'session_user_state',
  'offers',
  'tab_order',
  'session_drafts',
  'runtime_event_checkpoints',
  'user_layout',
  'user_dock_shell',
  'user_preferences',
  'user_read_position',
  'issues',
] as const

function rowsOf(store: SessionStore, tag: Tag): Record<string, unknown[]> {
  const db = rawDb(store)
  return Object.fromEntries(
    TABLES.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY rowid`).all(WS[tag]),
    ]),
  )
}

function session(tag: Tag, n: number, patch: Partial<SessionRow> = {}): SessionRow {
  return {
    id: sid(tag, n),
    ownerUserId: user(tag),
    agentKind: 'codex',
    cwd: `${root(tag)}/w${n}`,
    title: `${tag} session ${n}`,
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: 'codex',
    resumeValue: `${tag}-resume-${n}`,
    status: 'live',
    exitCode: null,
    spawnFailure: null,
    durableLabel: `podium-${tag}-${n}`,
    createdAt: `2026-11-0${n}T00:00:00.000Z`,
    lastActiveAt: `2026-11-0${n}T00:00:00.000Z`,
    geometry: { cols: 120, rows: 40 },
    archived: false,
    workState: null,
    machineId: machine(tag),
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    spawnedBy: `${tag}-parent`,
    headless: false,
    issueId: null,
    refIssueId: null,
    refLetter: null,
    refDraft: null,
    stoppedAt: null,
    stopReason: null,
    workflowRunId: null,
    workflowStepId: null,
    agentProfileId: null,
    deletedAt: null,
    deletionSource: null,
    deletedByIssueId: null,
    ...patch,
  }
}

/** An issue row, raw: the issues repository is another task's (B2). */
function insertIssue(store: SessionStore, tag: Tag, id: IssueId, seq: number): void {
  rawDb(store)
    .prepare(
      `INSERT INTO issues (workspace_id, id, owner_user_id, created_by_actor, repo_path, repo_id, seq, title,
         stage, default_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'backlog', 'codex', ?, ?)`,
    )
    .run(
      WS[tag],
      id,
      user(tag),
      user(tag),
      root(tag),
      `${tag}-repo`,
      seq,
      `${tag} issue ${seq}`,
      AT,
      AT,
    )
}

/**
 * One workspace's rows, written through its own repositories. Sessions:
 *   s1 live, ref-less, on the machine;     s2 live, born on issue 1 (letter A), bound to it;
 *   s3 headless, draft ref 7, child of s1; s4 tombstoned by issue 2 (bound to it);
 *   s5 live, ref-less, bound to an issue only the OTHER workspace holds.
 */
async function seed(store: SessionStore, tag: Tag): Promise<void> {
  const other: Tag = tag === 'a' ? 'b' : 'a'
  insertIssue(store, tag, iss(tag, 1), 1)
  insertIssue(store, tag, iss(tag, 2), 2)
  insertIssue(store, tag, heldBy(tag), 9)
  await store.sessions.upsertSessions(scope, [
    session(tag, 1),
    session(tag, 2, { refIssueId: iss(tag, 1), refLetter: 'A', issueId: iss(tag, 1) }),
    session(tag, 3, { headless: true, refDraft: 7, spawnedBy: sid(tag, 1), status: 'hibernated' }),
    session(tag, 4, { issueId: iss(tag, 2) }),
  ])
  await store.sessions.upsertSession(
    scope,
    session(tag, 5, {
      issueId: heldBy(other),
      lifecycle: {
        desired: 'stopped',
        force: false,
        revision: 2,
        observedRevision: 1,
        failure: null,
        byUser: user(tag),
        byAgent: null,
      },
    }),
  )
  await store.sessions.softDeleteForIssue(scope, [sid(tag, 4)], iss(tag, 2), AT)

  const alice = user(tag)
  const bob = user(tag, 'bob')
  await store.sessions.addPin(alice, 'panel', sid(tag, 1), AT)
  await store.sessions.addPin(bob, 'issue', iss(tag, 1), AT)
  await store.sessions.markSessionRead(scope, alice, sid(tag, 1), AT)
  await store.sessions.markSessionRead(scope, bob, sid(tag, 1), AT)
  await store.sessions.setSnooze(scope, alice, sid(tag, 2), LATER)
  await store.sessions.setSnooze(scope, bob, sid(tag, 1), null)
  await store.sessions.setOffer(scope, sid(tag, 1), {
    message: `${tag} offer`,
    actions: [{ label: 'Go', prompt: 'go' }],
    createdAt: AT,
  })
  await store.sessions.setTabOrder(alice, root(tag), [sid(tag, 2), sid(tag, 1)])
  await store.sessions.setTabOrder(bob, root(tag), [sid(tag, 1)])
  await store.sessions.setDraft(sid(tag, 1), `${tag} draft`)
  await store.sessions.setDraftDoc(sid(tag, 2), {
    text: `${tag} doc`,
    updatedAt: AT,
    rev: 3,
    origin: `${tag}-device`,
    history: [`${tag}-h1`],
  })
  rawDb(store)
    .prepare(
      `INSERT INTO runtime_event_checkpoints (workspace_id, session_id, observer_generation,
         cursor_json, turn_epoch, updated_at) VALUES (?, ?, 1, '{}', 1, ?)`,
    )
    .run(WS[tag], sid(tag, 1), AT)

  await store.layout.set(scope, alice, 'dockTab', `${tag}-files`, AT)
  await store.layout.set(scope, bob, 'superOpen', tag === 'a', AT)
  await store.dockShells.set(alice, `${root(tag)}/w1`, sid(tag, 1), AT)
  await store.dockShells.set(bob, `${root(tag)}/w2`, sid(tag, 2), AT)
  await store.settings.userPreferences.set(alice, 'roles.coding.model', `${tag}-model`, AT)
  await store.settings.userPreferences.set(bob, 'notifications.ntfyTopic', `${tag}-topic`, AT)
  await store.readPositions.advance(
    scope,
    alice,
    'issueEvents',
    { lastEventId: tag === 'a' ? 10 : 20, seenAt: AT },
    AT,
  )
  await store.readPositions.advance(scope, bob, 'issueEvents', { lastEventId: 5, seenAt: null }, AT)
}

async function twoSeeded(): Promise<readonly [SessionStore, SessionStore]> {
  const stores = await openWorkspaceStores([WS.a, WS.b], { path: ':memory:' })
  opened = stores[0]
  await seed(stores[0], 'a')
  await seed(stores[1], 'b')
  return stores
}

const ids = (rows: Iterable<{ id: string }>) => [...rows].map((row) => row.id).sort()

/** Every string in `value` that names a seeded thing starts with the workspace's tag. */
function onlyOwn(value: unknown, tag: Tag): void {
  const other = tag === 'a' ? 'b' : 'a'
  const text = JSON.stringify(value)
  expect(text).not.toMatch(
    new RegExp(
      `\\b${other}-(s\\d|iss-|machine|resume|alice|bob|files|model|topic|offer|draft|doc)|"${other} `,
    ),
  )
}

describe('the sessions repository reads only its own workspace', () => {
  it('writes every row under its own workspace', async () => {
    const [a] = await twoSeeded()
    for (const tag of ['a', 'b'] as const) {
      const rows = rowsOf(a, tag)
      for (const table of TABLES) {
        expect({ table, rows: rows[table]!.length > 0 }).toEqual({ table, rows: true })
        onlyOwn(rows[table], tag)
      }
    }
  })

  it('answers the session reads with its own rows', async () => {
    const [a, b] = await twoSeeded()
    for (const [store, tag] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      const s = store.sessions
      const live = [sid(tag, 1), sid(tag, 2), sid(tag, 3), sid(tag, 5)].sort()
      expect(ids(await s.loadSessions())).toEqual(live)
      expect(ids(await s.sessionsPage('', 100))).toEqual(live)
      expect(ids(await s.sessionsWithoutRef())).toEqual([sid(tag, 1), sid(tag, 5)])
      expect(ids(await s.loadDeletedSessions())).toEqual([sid(tag, 4)])
      expect(ids(await s.loadDeletedSessionsForIssue(iss(tag, 2)))).toEqual([sid(tag, 4)])
      const other: Tag = tag === 'a' ? 'b' : 'a'
      expect(await s.loadDeletedSessionsForIssue(iss(other, 2))).toEqual([])

      // By id: own ids answer, the other workspace's are misses.
      expect((await s.getSession(sid(tag, 4)))?.id).toBe(sid(tag, 4))
      expect(await s.getSession(sid(other, 1))).toBeUndefined()
      expect((await s.loadSession(sid(tag, 1)))?.id).toBe(sid(tag, 1))
      expect(await s.loadSession(sid(other, 2))).toBeUndefined()
      expect([...(await s.getSessions([sid(tag, 1), sid(other, 1)])).keys()]).toEqual([sid(tag, 1)])

      // Resume values, issues, paths, prefixes, statuses.
      expect((await s.findSessionByResumeValue(`${tag}-resume-1`))?.id).toBe(sid(tag, 1))
      expect(await s.findSessionByResumeValue(`${other}-resume-1`)).toBeUndefined()
      const resumes = [`${tag}-resume-2`, `${other}-resume-2`]
      expect([...(await s.findSessionsByResumeValues(resumes)).keys()]).toEqual([`${tag}-resume-2`])
      expect([...(await s.listSessionsByResumeValues(resumes)).keys()]).toEqual([`${tag}-resume-2`])
      expect(ids(await s.findSessionsByIssueIds([iss(tag, 1), iss(other, 1)]))).toEqual([
        sid(tag, 2),
      ])
      expect(ids(await s.sessionsUnderPath('/repo-'))).toEqual(live)
      expect(ids(await s.sessionsWithIdPrefix(`${other}-`))).toEqual([])
      expect(ids(await s.sessionsWithIdPrefix(`${tag}-s`))).toEqual(live)
      expect(ids(await s.sessionsWithStatuses(['live', 'hibernated']))).toEqual(live)
      expect(ids(await s.headlessSessions())).toEqual([sid(tag, 3)])
      expect(await s.issueIdsWithSeq(1)).toEqual([iss(tag, 1)])
      expect(ids(await s.sessionsReferencingIssues([iss(tag, 1), iss(other, 1)]))).toEqual([
        sid(tag, 2),
      ])
      expect(ids(await s.sessionsOfBirthLetter([iss(tag, 1), iss(other, 1)], 'A'))).toEqual([
        sid(tag, 2),
      ])
      expect(ids(await s.sessionsOfDraft(7))).toEqual([sid(tag, 3)])
      expect(ids(await s.sessionsSpawnedBy([sid(tag, 1), sid(other, 1)]))).toEqual([sid(tag, 3)])
      expect(await s.lifecyclePending(machine(tag))).toEqual([sid(tag, 5)])
      expect(await s.lifecyclePending(machine(other))).toEqual([])
      expect(ids(await s.sessionsOnMachine(machine(tag)))).toEqual(live)
      expect(await s.sessionsOnMachine(machine(other))).toEqual([])

      // The ref backfill: the place arms and the issue arm.
      // Without the scope, the issue arm would admit s5 through the other workspace's issue.
      expect(
        ids(await s.refBackfillCandidates({ bounded: [], open: [[machine(tag), root(tag)]] })),
      ).toEqual([sid(tag, 1), sid(tag, 5)])
      expect(
        await s.refBackfillCandidates({ bounded: [], open: [[machine(other), root(other)]] }),
      ).toEqual([])

      // Binding facts.
      expect(Object.keys(await s.bindingOwnersForMachine(machine(tag))).sort()).toEqual(
        [...live, sid(tag, 4)].sort(),
      )
      expect(await s.bindingOwnersForMachine(machine(other))).toEqual({})
      expect(await s.bindingOwnersForMachine(machine(tag), [sid(other, 1)])).toEqual({})
      const facts = await s.bindingConfirmations([sid(tag, 1), sid(other, 1)])
      expect(facts[sid(tag, 1)]?.owner).toBe(user(tag))
      expect(facts[sid(other, 1)]).toEqual({ owner: null, machineId: null, closed: false })
    }
  })

  it('answers the per-person reads with its own rows', async () => {
    const [a, b] = await twoSeeded()
    for (const [store, tag] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      const other: Tag = tag === 'a' ? 'b' : 'a'
      const s = store.sessions
      const alice = user(tag)
      const bob = user(tag, 'bob')

      // Pins.
      expect(await s.pinnedAt(alice, 'panel', sid(tag, 1))).toBe(AT)
      expect(await s.pinnedAt(user(other), 'panel', sid(other, 1))).toBeUndefined()
      expect(await s.pinnersOf('issue', iss(tag, 1))).toEqual([bob])
      expect(await s.pinnersOf('issue', iss(other, 1))).toEqual([])
      const pins = await s.allPinsForBootReconcile()
      expect(pins).toHaveLength(2)
      onlyOwn(pins, tag)
      expect(await s.pinsOfUsers([alice, user(other)])).toHaveLength(1)

      // Tab orders.
      expect(await s.tabOrder(alice, root(tag))).toEqual([sid(tag, 2), sid(tag, 1)])
      expect(await s.tabOrder(user(other), root(other))).toBeUndefined()
      const orders = await s.allTabOrdersForBootReconcile()
      expect(orders).toHaveLength(2)
      onlyOwn(orders, tag)
      expect(await s.tabOrdersOfUsers([bob, user(other, 'bob')])).toEqual([
        { userId: bob, entityId: root(tag), sessionIds: [sid(tag, 1)] },
      ])

      // Read markers and snoozes.
      expect(await s.listReadAt(alice)).toEqual({ [sid(tag, 1)]: AT })
      expect(await s.listReadAt(user(other))).toEqual({})
      expect(await s.getReadAt(alice, sid(tag, 1))).toBe(AT)
      expect(await s.getReadAt(user(other), sid(other, 1))).toBeNull()
      const states = await s.listSessionUserStateRows()
      expect(states.length).toBeGreaterThan(0)
      onlyOwn(states, tag)
      expect(await s.listSessionUserStateRows(sid(other, 1))).toEqual([])
      expect((await s.sessionUserStateFor(alice, sid(tag, 2))).snoozedUntil).toBe(LATER)
      expect(await s.sessionUserStateFor(user(other), sid(other, 2))).toEqual({
        userId: user(other),
        sessionId: sid(other, 2),
        readAt: null,
      })
      const overlay = await s.userStateOf(alice, [sid(tag, 1), sid(tag, 2)])
      expect(overlay.get(sid(tag, 1))?.readAt).toBe(AT)
      expect(overlay.get(sid(tag, 2))?.snoozedUntil).toBe(LATER)
      expect((await s.userStateOf(user(other), [sid(other, 1)])).get(sid(other, 1))).toEqual({
        readAt: null,
      })
      expect(await s.listSnoozes(alice)).toEqual({ [sid(tag, 2)]: LATER })
      expect(await s.listSnoozes(user(other))).toEqual({})
      expect(await s.hasAnySnooze(sid(tag, 1))).toBe(true)
      expect(await s.hasAnySnooze(sid(other, 1))).toBe(false)
      const stateIds = await s.sessionUserStateIdsOf({ sessionIds: [sid(tag, 1), sid(other, 1)] })
      expect(stateIds).toHaveLength(2)
      onlyOwn(stateIds, tag)
      expect(await s.sessionUserStateIdsOf({ userIds: [user(other), user(other, 'bob')] })).toEqual(
        [],
      )

      // Offers and drafts.
      expect(Object.keys(await s.listOffers())).toEqual([sid(tag, 1)])
      expect(Object.keys(await s.offersOf([sid(tag, 1), sid(other, 1)]))).toEqual([sid(tag, 1)])
      expect(await s.offerCreatedAt(sid(tag, 1))).toBe(AT)
      expect(await s.offerCreatedAt(sid(other, 1))).toBeUndefined()
      expect(Object.keys(await s.loadDrafts()).sort()).toEqual([sid(tag, 1), sid(tag, 2)])
      expect(Object.keys(await s.loadDraftTimes()).sort()).toEqual([sid(tag, 1), sid(tag, 2)])
      expect([...(await s.draftTimesOf([sid(tag, 1), sid(other, 1)])).keys()]).toEqual([
        sid(tag, 1),
      ])
      expect(Object.keys(await s.loadDraftDocs()).sort()).toEqual([sid(tag, 1), sid(tag, 2)])
      expect((await s.draftDocOf(sid(tag, 2)))?.origin).toBe(`${tag}-device`)
      expect(await s.draftDocOf(sid(other, 2))).toBeUndefined()

      // Activity publications: make every row pending in both workspaces, raw.
      rawDb(store)
        .prepare(
          "UPDATE sessions SET published_last_active_at = '2000-01-01T00:00:00.000Z', last_active_publish_after = 0 WHERE deleted_at IS NULL",
        )
        .run()
      expect((await s.activityPublicationsDue(Date.now())).sort()).toEqual(
        [sid(tag, 1), sid(tag, 2), sid(tag, 3), sid(tag, 5)].sort(),
      )
    }
  })
})

describe('the user state repositories read only their own workspace', () => {
  it('answers layout, dock shell, preference and read position reads with its own rows', async () => {
    const [a, b] = await twoSeeded()
    for (const [store, tag] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      const other: Tag = tag === 'a' ? 'b' : 'a'
      const alice = user(tag)
      const bob = user(tag, 'bob')

      expect(await store.layout.get(alice, 'dockTab')).toBe(`${tag}-files`)
      expect(await store.layout.get(user(other), 'dockTab')).toBeUndefined()
      expect(await store.layout.getSnapshot(alice)).toEqual({ dockTab: `${tag}-files` })
      expect(await store.layout.getSnapshot(user(other))).toEqual({})
      expect(await store.layout.keysFor(bob)).toEqual(['superOpen'])
      expect(await store.layout.keysFor(user(other, 'bob'))).toEqual([])
      const layouts = await store.layout.allForBootReconcile(1)
      expect(layouts).toHaveLength(2)
      onlyOwn(layouts, tag)

      expect(await store.dockShells.get(alice, `${root(tag)}/w1`)).toBe(sid(tag, 1))
      expect(await store.dockShells.get(user(other), `${root(other)}/w1`)).toBeUndefined()
      expect(await store.dockShells.listForUser(bob)).toEqual({ [`${root(tag)}/w2`]: sid(tag, 2) })
      expect(await store.dockShells.listForUser(user(other, 'bob'))).toEqual({})
      expect(await store.dockShells.worktreeForSession(sid(tag, 1))).toEqual([
        { userId: alice, worktreeKey: `${root(tag)}/w1` },
      ])
      expect(await store.dockShells.worktreeForSession(sid(other, 1))).toEqual([])
      expect([
        ...(await store.dockShells.worktreesForSessions([sid(tag, 2), sid(other, 2)])).keys(),
      ]).toEqual([sid(tag, 2)])

      const prefs = store.settings.userPreferences
      expect(await prefs.get(alice, 'roles.coding.model')).toBe(`${tag}-model`)
      expect(await prefs.get(user(other), 'roles.coding.model')).toBeUndefined()
      expect([...(await prefs.getFor(bob)).keys()]).toEqual(['notifications.ntfyTopic'])
      expect((await prefs.getFor(user(other, 'bob'))).size).toBe(0)
      expect(await prefs.keysFor(alice)).toEqual(['roles.coding.model'])
      expect(await prefs.keysFor(user(other))).toEqual([])
      expect(await prefs.recordFor(user(other))).toEqual({ userId: user(other) })
      const records = await prefs.allRecordsForBootReconcile()
      expect(records).toHaveLength(2)
      onlyOwn(records, tag)

      const positions = store.readPositions
      expect((await positions.get(alice, 'issueEvents'))?.lastEventId).toBe(tag === 'a' ? 10 : 20)
      expect(await positions.get(user(other), 'issueEvents')).toBeUndefined()
      expect(Object.keys(await positions.getSnapshot(bob))).toEqual(['issueEvents'])
      expect(await positions.getSnapshot(user(other, 'bob'))).toEqual({})
      const pages = []
      for await (const page of positions.allPositionPages(1)) pages.push(...page)
      expect(pages).toHaveLength(2)
      onlyOwn(pages, tag)
    }
  })
})

describe("a write in one workspace leaves the other's rows unchanged", () => {
  it('session writes, including writes addressed at the other workspace’s ids', async () => {
    const [a, b] = await twoSeeded()
    const before = rowsOf(a, 'b')
    const s = a.sessions
    const B1 = sid('b', 1)
    const B2 = sid('b', 2)
    const B4 = sid('b', 4)

    // Upserts of A's own ids.
    await s.upsertSession(scope, session('a', 1, { title: 'renamed', status: 'exited' }))
    await s.upsertSessions(scope, [session('a', 2, { title: 'renamed' }), session('a', 6)])
    // Updates and deletes aimed at B's ids: nothing in A matches them.
    await s.publishActivity(scope, [B1, B2, sid('a', 1)], Date.now())
    await s.softDeleteSessions(scope, [B1, B2], AT, 'standalone')
    await s.softDeleteForIssue(scope, [B1], iss('b', 1), AT)
    await s.restoreDeletedForIssue(scope, iss('b', 2))
    await s.detachTombstonesFromIssue(scope, iss('b', 2))
    await s.purgeSession(scope, B1)
    await s.purgeSession(scope, B4)
    await s.removePinsOf('issue', iss('b', 1))
    expect(await s.removePin(user('b'), 'panel', B1)).toBe(false)
    await s.clearAllReadAt(scope, B1)
    await s.markSessionUnread(scope, user('b'), B1)
    await s.clearAllSnoozes(scope, B1)
    await s.clearSnooze(scope, user('b'), B2)
    await s.clearOffer(scope, B1)
    await s.setTabOrder(user('b'), root('b'), [])
    await s.setDraft(B1, '')
    await s.setDraftDoc(B2, { text: '', updatedAt: AT, rev: 9, origin: null, history: [] })
    // The boot heal: in A, s5 points at an issue only B holds, so A detaches it; B's s5,
    // which points at an issue only A holds, is not A's to judge.
    expect(await s.detachDanglingIssueReferences()).toBe(1)
    expect((await s.getSession(sid('a', 5)))?.issueId).toBeNull()
    // Upserts and writes of A's own per-person rows.
    await s.addPin(user('a'), 'repo', root('a'), AT)
    await s.markSessionRead(scope, user('a'), sid('a', 2), AT)
    await s.setSnooze(scope, user('a'), sid('a', 1), LATER)
    await s.setOffer(scope, sid('a', 2), { message: 'more', actions: [], createdAt: AT })
    await s.setTabOrder(user('a'), `${root('a')}/other`, [sid('a', 1)])
    await s.setDraft(sid('a', 3), 'typed')
    await s.setDraftDoc(sid('a', 3), {
      text: 'doc',
      updatedAt: AT,
      rev: 1,
      origin: null,
      history: [],
    })
    await s.listSnoozes(user('a'), Date.parse(LATER) + 1) // lapses A's timed snoozes

    expect(rowsOf(a, 'b')).toEqual(before)
    // And A's own writes landed.
    expect((await s.getSession(sid('a', 1)))?.title).toBe('renamed')
    expect((await s.getSession(sid('a', 6)))?.id).toBe(sid('a', 6))
    expect(await s.pinnedAt(user('a'), 'repo', root('a'))).toBe(AT)
    // B still reads all of its own rows.
    expect((await b.sessions.getSession(B1))?.deletedAt).toBeNull()
    expect(await b.sessions.pinnersOf('issue', iss('b', 1))).toEqual([user('b', 'bob')])
  })

  it('A’s own deletes take A’s rows and no others', async () => {
    const [a] = await twoSeeded()
    const before = rowsOf(a, 'b')
    const s = a.sessions
    await s.softDeleteSessions(scope, [sid('a', 1)], AT, 'standalone')
    await s.restoreDeletedForIssue(scope, iss('a', 2))
    await s.detachTombstonesFromIssue(scope, iss('a', 2))
    await s.purgeSession(scope, sid('a', 1))
    expect(await s.removePinsOf('issue', iss('a', 1))).toEqual([user('a', 'bob')])
    expect(await s.clearAllReadAt(scope, sid('a', 1))).toEqual([])
    expect(await s.clearAllSnoozes(scope, sid('a', 2))).toEqual([user('a')])
    await s.clearOffer(scope, sid('a', 1))
    await s.setTabOrder(user('a'), root('a'), [])
    await s.setDraft(sid('a', 2), '')
    expect(rowsOf(a, 'b')).toEqual(before)
    expect(await s.getSession(sid('a', 1))).toBeUndefined()
    expect((await s.getSession(sid('a', 4)))?.deletedAt).toBeNull()
  })

  it('user state writes', async () => {
    const [a] = await twoSeeded()
    const before = rowsOf(a, 'b')
    const B = user('b')
    const bBob = user('b', 'bob')

    // Aimed at B's people and keys: nothing in A matches.
    await a.layout.clear(scope, B, 'dockTab')
    await a.layout.clearMany(scope, bBob, ['superOpen'])
    await a.dockShells.remove(B, `${root('b')}/w1`)
    expect(await a.dockShells.removeByWorktree(`${root('b')}/w2`)).toEqual([])
    await a.dockShells.removeBySession(sid('b', 1))
    await a.settings.userPreferences.clear(B, 'roles.coding.model')
    // A's own writes.
    await a.layout.set(scope, user('a'), 'dockTab', 'shell', AT)
    await a.layout.setMany(scope, user('a'), { superOpen: true }, AT)
    await a.dockShells.set(user('a'), `${root('a')}/w9`, sid('a', 9), AT)
    expect(await a.dockShells.tryClaim(user('a'), `${root('a')}/w8`, sid('a', 8), AT)).toBe(true)
    await a.dockShells.removeByWorktree(`${root('a')}/w1`)
    await a.settings.userPreferences.set(user('a'), 'roles.coding.model', 'next', AT)
    await a.settings.userPreferences.clear(user('a', 'bob'), 'notifications.ntfyTopic')
    await a.readPositions.advance(
      scope,
      user('a'),
      'issueEvents',
      { lastEventId: 99, seenAt: AT },
      AT,
    )

    expect(rowsOf(a, 'b')).toEqual(before)
    expect(await a.layout.get(user('a'), 'dockTab')).toBe('shell')
    expect((await a.readPositions.get(user('a'), 'issueEvents'))?.lastEventId).toBe(99)
  })
})

describe('the written-columns hint is per workspace', () => {
  type Hint = { get(id: string): unknown }
  const hintOf = (store: SessionStore): Hint =>
    (store.sessions as unknown as { writtenColumns: Hint }).writtenColumns
  const inSpan = async <T>(store: SessionStore, fn: () => Promise<T>): Promise<T> =>
    await (
      store.sessions as unknown as {
        createOrJoinTransaction: <R>(run: () => Promise<R>) => Promise<R>
      }
    ).createOrJoinTransaction(fn)

  it("keeps B's hint when A forgets rows, named or all", async () => {
    const [a, b] = await twoSeeded()
    expect(hintOf(a)).not.toBe(hintOf(b))
    // A read outside a span records what B's row holds.
    await b.sessions.getSession(sid('b', 1))
    expect(await inSpan(b, async () => hintOf(b).get(sid('b', 1)))).toBeDefined()

    // A's writes that forget: a tombstone of B's id, and two that forget every row.
    await a.sessions.softDeleteSessions(scope, [sid('b', 1)], AT, 'standalone')
    await a.sessions.restoreDeletedForIssue(scope, iss('a', 2))
    await a.sessions.detachDanglingIssueReferences()
    await a.sessions.getSession(sid('a', 1))
    await a.sessions.purgeSession(scope, sid('a', 1))

    expect(await inSpan(b, async () => hintOf(b).get(sid('b', 1)))).toBeDefined()
    expect(await inSpan(a, async () => hintOf(a).get(sid('a', 1)))).toBeUndefined()
  })
})

/**
 * THE SAME ID IN BOTH WORKSPACES (POD-7024): every ON CONFLICT target leads with workspace_id,
 * so an upsert in A of an id B already holds makes A its own row, B's row stays byte for byte
 * as it was, and A's second upsert of the id updates A's row only.
 */
describe('the same id in both workspaces, upserted through the repository (POD-7024)', () => {
  it("makes a second row, leaves the other workspace's as it was, and updates only its own", async () => {
    const rowsIn = (store: SessionStore, ws: string) =>
      rawDb(store)
        .prepare('SELECT * FROM sessions WHERE workspace_id = ? AND id = ? ORDER BY rowid')
        .all(ws, SAME)
    const SAME = asSessionId('same-session')
    const [a, b] = await twoSeeded()
    opened = a
    await b.sessions.upsertSession(scope, session('b', 6, { id: SAME }))
    const before = rowsIn(b, WS.b)
    await a.sessions.upsertSession(scope, session('a', 6, { id: SAME }))
    expect(rowsIn(a, WS.a)).toHaveLength(1)
    expect(rowsIn(b, WS.b)).toEqual(before)
    await a.sessions.upsertSession(scope, session('a', 6, { id: SAME, title: 'a retitled' }))
    expect((await a.sessions.getSession(SAME))?.title).toBe('a retitled')
    expect((await b.sessions.getSession(SAME))?.title).toBe('b session 6')
    expect(rowsIn(b, WS.b)).toEqual(before)
  })
})
