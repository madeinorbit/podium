/**
 * SESSIONS AND USER STATE ARE A WORKSPACE'S (POD-6959 design 2.4, 2.5; task POD-7015).
 *
 * Two workspaces over one database (`openWorkspaceStores`), each seeded through its own
 * repositories with its own sessions, pins, snoozes, read markers, offers, tab orders, drafts,
 * layout, dock shells, preferences and read positions.
 * Both workspaces hold the SAME ids and natural keys (POD-7025): the same sessions, issues,
 * people, machine, paths and resume values. Every key leads with workspace_id (POD-7024), so
 * the same id is two rows, told apart only by the workspace. The content differs (titles, the
 * owner, offers, drafts, timestamps, snooze ends, tab orders, dock shells, layout and
 * preference values), so a read that crossed over would answer the other workspace's content.
 * Each workspace also holds one session (`only-<tag>`) and one issue (`held-by-<tag>`) the
 * other does not, for the reads and writes that must miss.
 *
 * For every repository method of the group:
 *   - a read answers only its own workspace's rows, including the reads across people and the
 *     boot reconcile pages;
 *   - an update, delete or upsert in one workspace leaves the other's rows unchanged, both for
 *     the ids the two share and for an id only the other holds (purge, tombstone, clear,
 *     remove), which must find nothing to change;
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
const TAGS = ['a', 'b'] as const
const other = (tag: Tag): Tag => (tag === 'a' ? 'b' : 'a')
/** Each workspace's own timestamp and snooze end: content, not keys. */
const AT_OF: Record<Tag, string> = { a: '2026-11-17T10:00:00.000Z', b: '2026-11-17T11:00:00.000Z' }
const LATER_OF: Record<Tag, string> = {
  a: '2099-01-01T00:00:00.000Z',
  b: '2099-02-01T00:00:00.000Z',
}
const AT = AT_OF.a
const LATER = LATER_OF.a
const scope = fixtureWriteScope()

// The same ids in both workspaces.
const user = (name = 'alice'): UserId => asUserId(`user:${name}`)
const ALICE = user()
const BOB = user('bob')
const sid = (n: number): SessionId => asSessionId(`s${n}`)
const iss = (n: number): IssueId => asIssueId(`iss-${n}`)
const MACHINE = asMachineId('machine-1')
const ROOT = '/repo'
/** The sessions' owner: the same people in both, a different owner per workspace. */
const owner = (tag: Tag): UserId => (tag === 'a' ? ALICE : BOB)
/** Alice's and Bob's dock shells: the same worktrees, a different shell per workspace. */
const shell = (tag: Tag, who: 'alice' | 'bob'): SessionId =>
  who === 'alice' ? sid(tag === 'a' ? 1 : 3) : sid(tag === 'a' ? 2 : 5)
/** Alice's tab order: the same sessions, a different order per workspace. */
const aliceOrder = (tag: Tag): SessionId[] => (tag === 'a' ? [sid(2), sid(1)] : [sid(1), sid(2)])

// The ids only one workspace holds.
/** A session only `tag`'s workspace holds. */
const only = (tag: Tag): SessionId => asSessionId(`only-${tag}`)
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
    id: sid(n),
    ownerUserId: owner(tag),
    agentKind: 'codex',
    cwd: `${ROOT}/w${n}`,
    title: `${tag} session ${n}`,
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: 'codex',
    resumeValue: `resume-${n}`,
    status: 'live',
    exitCode: null,
    spawnFailure: null,
    durableLabel: `podium-${n}`,
    createdAt: `2026-11-0${n}T00:00:00.000Z`,
    lastActiveAt: `2026-11-0${n}T00:00:00.000Z`,
    geometry: { cols: 120, rows: 40 },
    archived: false,
    workState: null,
    machineId: MACHINE,
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    spawnedBy: 'parent',
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
      owner(tag),
      owner(tag),
      ROOT,
      'repo-1',
      seq,
      `${tag} issue ${seq}`,
      AT_OF[tag],
      AT_OF[tag],
    )
}

/**
 * One workspace's rows, written through its own repositories. Sessions, the same ids in both:
 *   s1 live, ref-less, on the machine;     s2 live, born on issue 1 (letter A), bound to it;
 *   s3 headless, draft ref 7, child of s1; s4 tombstoned by issue 2 (bound to it);
 *   s5 live, ref-less, bound to an issue only the OTHER workspace holds.
 * And `only-<tag>`, live and ref-less, which only this workspace holds: Alice pinned and read
 * it, Bob snoozed it.
 */
async function seed(store: SessionStore, tag: Tag): Promise<void> {
  const at = AT_OF[tag]
  insertIssue(store, tag, iss(1), 1)
  insertIssue(store, tag, iss(2), 2)
  insertIssue(store, tag, heldBy(tag), 9)
  await store.sessions.upsertSessions(scope, [
    session(tag, 1),
    session(tag, 2, { refIssueId: iss(1), refLetter: 'A', issueId: iss(1) }),
    session(tag, 3, { headless: true, refDraft: 7, spawnedBy: sid(1), status: 'hibernated' }),
    session(tag, 4, { issueId: iss(2) }),
    session(tag, 8, { id: only(tag), resumeValue: `resume-only-${tag}` }),
  ])
  await store.sessions.upsertSession(
    scope,
    session(tag, 5, {
      issueId: heldBy(other(tag)),
      lifecycle: {
        desired: 'stopped',
        force: false,
        revision: 2,
        observedRevision: 1,
        failure: null,
        byUser: owner(tag),
        byAgent: null,
      },
    }),
  )
  await store.sessions.softDeleteForIssue(scope, [sid(4)], iss(2), at)

  await store.sessions.addPin(ALICE, 'panel', sid(1), at)
  await store.sessions.addPin(ALICE, 'panel', only(tag), at)
  await store.sessions.addPin(BOB, 'issue', iss(1), at)
  await store.sessions.markSessionRead(scope, ALICE, sid(1), at)
  await store.sessions.markSessionRead(scope, ALICE, only(tag), at)
  await store.sessions.markSessionRead(scope, BOB, sid(1), at)
  await store.sessions.setSnooze(scope, ALICE, sid(2), LATER_OF[tag])
  await store.sessions.setSnooze(scope, BOB, sid(1), null)
  await store.sessions.setSnooze(scope, BOB, only(tag), null)
  await store.sessions.setOffer(scope, sid(1), {
    message: `${tag} offer`,
    actions: [{ label: 'Go', prompt: 'go' }],
    createdAt: at,
  })
  await store.sessions.setTabOrder(ALICE, ROOT, aliceOrder(tag))
  await store.sessions.setTabOrder(BOB, ROOT, [sid(1)])
  await store.sessions.setDraft(sid(1), `${tag} draft`)
  await store.sessions.setDraftDoc(sid(2), {
    text: `${tag} doc`,
    updatedAt: at,
    rev: 3,
    origin: `${tag}-device`,
    history: [`${tag}-h1`],
  })
  rawDb(store)
    .prepare(
      `INSERT INTO runtime_event_checkpoints (workspace_id, session_id, observer_generation,
         cursor_json, turn_epoch, updated_at) VALUES (?, ?, 1, '{}', 1, ?)`,
    )
    .run(WS[tag], sid(1), at)

  await store.layout.set(scope, ALICE, 'dockTab', `${tag}-files`, at)
  await store.layout.set(scope, BOB, 'superOpen', tag === 'a', at)
  await store.dockShells.set(ALICE, `${ROOT}/w1`, shell(tag, 'alice'), at)
  await store.dockShells.set(BOB, `${ROOT}/w2`, shell(tag, 'bob'), at)
  await store.settings.userPreferences.set(ALICE, 'roles.coding.model', `${tag}-model`, at)
  await store.settings.userPreferences.set(BOB, 'notifications.ntfyTopic', `${tag}-topic`, at)
  await store.readPositions.advance(
    scope,
    ALICE,
    'issueEvents',
    { lastEventId: tag === 'a' ? 10 : 20, seenAt: at },
    at,
  )
  await store.readPositions.advance(
    scope,
    BOB,
    'issueEvents',
    { lastEventId: tag === 'a' ? 5 : 6, seenAt: at },
    at,
  )
}

async function twoSeeded(): Promise<readonly [SessionStore, SessionStore]> {
  const stores = await openWorkspaceStores([WS.a, WS.b], { path: ':memory:' })
  opened = stores[0]
  await seed(stores[0], 'a')
  await seed(stores[1], 'b')
  return stores
}

/** The sorted ids of `rows`, each held to its own workspace's title: the ids are the same in
 *  both workspaces, so the title is what tells a crossed-over row. */
function ids(rows: Iterable<SessionRow>, tag: Tag): string[] {
  const list = [...rows]
  for (const row of list) expect(row.title.startsWith(`${tag} `), row.id).toBe(true)
  return list.map((row) => row.id).sort()
}

/** No content of the other workspace anywhere in `value`. */
function onlyOwn(value: unknown, tag: Tag): void {
  const o = other(tag)
  const text = JSON.stringify(value)
  expect(text).not.toMatch(
    new RegExp(`"${o} |\\b${o}-(device|h1|files|model|topic)|only-${o}|"${WS[o]}"`),
  )
  expect(text).not.toContain(AT_OF[o])
  expect(text).not.toContain(LATER_OF[o])
}

describe('the sessions repository reads only its own workspace', () => {
  it('writes every row under its own workspace', async () => {
    const [a] = await twoSeeded()
    for (const tag of TAGS) {
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
      const o = other(tag)
      const shared = [sid(1), sid(2), sid(3), sid(5)]
      const live = [...shared, only(tag)].sort()
      expect(ids(await s.loadSessions(), tag)).toEqual(live)
      expect(ids(await s.sessionsPage('', 100), tag)).toEqual(live)
      expect(ids(await s.sessionsWithoutRef(), tag)).toEqual([only(tag), sid(1), sid(5)].sort())
      expect(ids(await s.loadDeletedSessions(), tag)).toEqual([sid(4)])
      expect(ids(await s.loadDeletedSessionsForIssue(iss(2)), tag)).toEqual([sid(4)])

      // By id: the ids both hold answer with its own row, an id only the other holds misses.
      expect((await s.getSession(sid(4)))?.title).toBe(`${tag} session 4`)
      expect(await s.getSession(only(o))).toBeUndefined()
      expect((await s.loadSession(sid(1)))?.title).toBe(`${tag} session 1`)
      expect(await s.loadSession(only(o))).toBeUndefined()
      const byId = await s.getSessions([sid(1), only(o)])
      expect(ids(byId.values(), tag)).toEqual([sid(1)])

      // Resume values, issues, paths, prefixes, statuses.
      expect((await s.findSessionByResumeValue('resume-1'))?.title).toBe(`${tag} session 1`)
      expect(await s.findSessionByResumeValue(`resume-only-${o}`)).toBeUndefined()
      const resumes = ['resume-2', `resume-only-${o}`]
      const found = await s.findSessionsByResumeValues(resumes)
      expect([...found.keys()]).toEqual(['resume-2'])
      expect(ids(found.values(), tag)).toEqual([sid(2)])
      const listed = await s.listSessionsByResumeValues(resumes)
      expect([...listed.keys()]).toEqual(['resume-2'])
      expect(ids([...listed.values()].flat(), tag)).toEqual([sid(2)])
      // The other workspace's s5 is bound to the issue only this workspace holds.
      expect(ids(await s.findSessionsByIssueIds([iss(1), heldBy(tag)]), tag)).toEqual([sid(2)])
      expect(ids(await s.sessionsUnderPath(ROOT), tag)).toEqual(live)
      expect(ids(await s.sessionsWithIdPrefix('only-'), tag)).toEqual([only(tag)])
      expect(ids(await s.sessionsWithIdPrefix('s'), tag)).toEqual(shared)
      expect(ids(await s.sessionsWithStatuses(['live', 'hibernated']), tag)).toEqual(live)
      expect(ids(await s.headlessSessions(), tag)).toEqual([sid(3)])
      expect(await s.issueIdsWithSeq(1)).toEqual([iss(1)])
      expect(await s.issueIdsWithSeq(9)).toEqual([heldBy(tag)])
      expect(ids(await s.sessionsReferencingIssues([iss(1), heldBy(tag)]), tag)).toEqual([sid(2)])
      expect(ids(await s.sessionsOfBirthLetter([iss(1), heldBy(tag)], 'A'), tag)).toEqual([sid(2)])
      expect(ids(await s.sessionsOfDraft(7), tag)).toEqual([sid(3)])
      expect(ids(await s.sessionsSpawnedBy([sid(1)]), tag)).toEqual([sid(3)])
      expect(await s.lifecyclePending(MACHINE)).toEqual([sid(5)])
      expect(ids(await s.sessionsOnMachine(MACHINE), tag)).toEqual(live)

      // The ref backfill: the place arms and the issue arm.
      // Without the scope, the issue arm would admit s5 through the other workspace's issue.
      expect(
        ids(await s.refBackfillCandidates({ bounded: [], open: [[MACHINE, ROOT]] }), tag),
      ).toEqual([only(tag), sid(1), sid(5)].sort())

      // Binding facts: the owner is the workspace's own.
      const owners = await s.bindingOwnersForMachine(MACHINE)
      expect(Object.keys(owners).sort()).toEqual([...live, sid(4)].sort())
      expect(new Set(Object.values(owners))).toEqual(new Set([owner(tag)]))
      expect(await s.bindingOwnersForMachine(MACHINE, [only(o)])).toEqual({})
      const facts = await s.bindingConfirmations([sid(1), only(o)])
      expect(facts[sid(1)]?.owner).toBe(owner(tag))
      expect(facts[only(o)]).toEqual({ owner: null, machineId: null, closed: false })
    }
  })

  it('answers the per-person reads with its own rows', async () => {
    const [a, b] = await twoSeeded()
    for (const [store, tag] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      const o = other(tag)
      const at = AT_OF[tag]
      const later = LATER_OF[tag]
      const s = store.sessions

      // Pins.
      expect(await s.pinnedAt(ALICE, 'panel', sid(1))).toBe(at)
      expect(await s.pinnedAt(ALICE, 'panel', only(o))).toBeUndefined()
      expect(await s.pinnersOf('issue', iss(1))).toEqual([BOB])
      expect(await s.pinnersOf('panel', only(o))).toEqual([])
      const pins = await s.allPinsForBootReconcile()
      expect(pins).toHaveLength(3)
      onlyOwn(pins, tag)
      const alicePins = await s.pinsOfUsers([ALICE])
      expect(alicePins).toHaveLength(2)
      onlyOwn(alicePins, tag)

      // Tab orders.
      expect(await s.tabOrder(ALICE, ROOT)).toEqual(aliceOrder(tag))
      const orders = await s.allTabOrdersForBootReconcile()
      expect(orders).toHaveLength(2)
      expect(orders).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userId: ALICE, entityId: ROOT, sessionIds: aliceOrder(tag) }),
        ]),
      )
      expect(await s.tabOrdersOfUsers([BOB])).toEqual([
        { userId: BOB, entityId: ROOT, sessionIds: [sid(1)] },
      ])

      // Read markers and snoozes.
      expect(await s.listReadAt(ALICE)).toEqual({ [sid(1)]: at, [only(tag)]: at })
      expect(await s.getReadAt(ALICE, sid(1))).toBe(at)
      expect(await s.getReadAt(ALICE, only(o))).toBeNull()
      const states = await s.listSessionUserStateRows()
      expect(states.length).toBeGreaterThan(0)
      onlyOwn(states, tag)
      expect(await s.listSessionUserStateRows(only(o))).toEqual([])
      expect((await s.sessionUserStateFor(ALICE, sid(2))).snoozedUntil).toBe(later)
      expect(await s.sessionUserStateFor(ALICE, only(o))).toEqual({
        userId: ALICE,
        sessionId: only(o),
        readAt: null,
      })
      const overlay = await s.userStateOf(ALICE, [sid(1), sid(2)])
      expect(overlay.get(sid(1))?.readAt).toBe(at)
      expect(overlay.get(sid(2))?.snoozedUntil).toBe(later)
      expect((await s.userStateOf(ALICE, [only(o)])).get(only(o))).toEqual({ readAt: null })
      expect(await s.listSnoozes(ALICE)).toEqual({ [sid(2)]: later })
      expect(await s.hasAnySnooze(sid(1))).toBe(true)
      expect(await s.hasAnySnooze(only(o))).toBe(false)
      const stateIds = await s.sessionUserStateIdsOf({ sessionIds: [sid(1), only(o)] })
      expect(stateIds).toHaveLength(2)
      onlyOwn(stateIds, tag)
      const aliceStateIds = await s.sessionUserStateIdsOf({ userIds: [ALICE] })
      expect(aliceStateIds).toHaveLength(3)
      onlyOwn(aliceStateIds, tag)

      // Offers and drafts.
      const offers = await s.listOffers()
      expect(Object.keys(offers)).toEqual([sid(1)])
      onlyOwn(offers, tag)
      const offersOf = await s.offersOf([sid(1), only(o)])
      expect(Object.keys(offersOf)).toEqual([sid(1)])
      onlyOwn(offersOf, tag)
      expect(await s.offerCreatedAt(sid(1))).toBe(at)
      const drafts = await s.loadDrafts()
      expect(Object.keys(drafts).sort()).toEqual([sid(1), sid(2)])
      expect(drafts[sid(1)]).toBe(`${tag} draft`)
      onlyOwn(drafts, tag)
      expect(Object.keys(await s.loadDraftTimes()).sort()).toEqual([sid(1), sid(2)])
      expect([...(await s.draftTimesOf([sid(1), only(o)])).keys()]).toEqual([sid(1)])
      const docs = await s.loadDraftDocs()
      expect(Object.keys(docs).sort()).toEqual([sid(1), sid(2)])
      onlyOwn(docs, tag)
      expect((await s.draftDocOf(sid(2)))?.origin).toBe(`${tag}-device`)
      expect(await s.draftDocOf(only(o))).toBeUndefined()

      // Activity publications: make every row pending in both workspaces, raw.
      rawDb(store)
        .prepare(
          "UPDATE sessions SET published_last_active_at = '2000-01-01T00:00:00.000Z', last_active_publish_after = 0 WHERE deleted_at IS NULL",
        )
        .run()
      expect((await s.activityPublicationsDue(Date.now())).sort()).toEqual(
        [sid(1), sid(2), sid(3), sid(5), only(tag)].sort(),
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
      const o = other(tag)

      expect(await store.layout.get(ALICE, 'dockTab')).toBe(`${tag}-files`)
      expect(await store.layout.getSnapshot(ALICE)).toEqual({ dockTab: `${tag}-files` })
      expect(await store.layout.getSnapshot(BOB)).toEqual({ superOpen: tag === 'a' })
      expect(await store.layout.keysFor(BOB)).toEqual(['superOpen'])
      const layouts = await store.layout.allForBootReconcile(1)
      expect(layouts).toHaveLength(2)
      onlyOwn(layouts, tag)

      // The dock shells: the same worktrees, each workspace's own shell in them.
      expect(await store.dockShells.get(ALICE, `${ROOT}/w1`)).toBe(shell(tag, 'alice'))
      expect(await store.dockShells.listForUser(BOB)).toEqual({ [`${ROOT}/w2`]: shell(tag, 'bob') })
      expect(await store.dockShells.worktreeForSession(shell(tag, 'alice'))).toEqual([
        { userId: ALICE, worktreeKey: `${ROOT}/w1` },
      ])
      // The other workspace's shell is a session that is no shell here.
      expect(await store.dockShells.worktreeForSession(shell(o, 'alice'))).toEqual([])
      expect([
        ...(
          await store.dockShells.worktreesForSessions([shell(tag, 'bob'), shell(o, 'bob')])
        ).keys(),
      ]).toEqual([shell(tag, 'bob')])

      const prefs = store.settings.userPreferences
      expect(await prefs.get(ALICE, 'roles.coding.model')).toBe(`${tag}-model`)
      expect([...(await prefs.getFor(BOB)).entries()]).toEqual([
        ['notifications.ntfyTopic', `${tag}-topic`],
      ])
      expect(await prefs.keysFor(ALICE)).toEqual(['roles.coding.model'])
      const record = await prefs.recordFor(ALICE)
      expect(JSON.stringify(record)).toContain(`${tag}-model`)
      onlyOwn(record, tag)
      const records = await prefs.allRecordsForBootReconcile()
      expect(records).toHaveLength(2)
      onlyOwn(records, tag)

      const positions = store.readPositions
      expect((await positions.get(ALICE, 'issueEvents'))?.lastEventId).toBe(tag === 'a' ? 10 : 20)
      expect((await positions.get(BOB, 'issueEvents'))?.lastEventId).toBe(tag === 'a' ? 5 : 6)
      expect(Object.keys(await positions.getSnapshot(BOB))).toEqual(['issueEvents'])
      const pages = []
      for await (const page of positions.allPositionPages(1)) pages.push(...page)
      expect(pages).toHaveLength(2)
      onlyOwn(pages, tag)
    }
  })
})

describe("a write in one workspace leaves the other's rows unchanged", () => {
  it('session writes, of the ids both hold and of the ids only the other holds', async () => {
    const [a, b] = await twoSeeded()
    const before = rowsOf(a, 'b')
    const s = a.sessions
    const ONLY_B = only('b')

    // Upserts of the ids both hold, and a new one.
    await s.upsertSession(scope, session('a', 1, { title: 'a renamed', status: 'exited' }))
    await s.upsertSessions(scope, [session('a', 2, { title: 'a renamed' }), session('a', 6)])
    await s.publishActivity(scope, [sid(1), sid(2), ONLY_B], Date.now())
    // Updates and deletes aimed at ids only B holds: nothing in A matches them.
    await s.softDeleteSessions(scope, [ONLY_B], AT, 'standalone')
    await s.softDeleteForIssue(scope, [ONLY_B], heldBy('b'), AT)
    await s.restoreDeletedForIssue(scope, heldBy('b'))
    await s.detachTombstonesFromIssue(scope, heldBy('b'))
    await s.purgeSession(scope, ONLY_B)
    await s.removePinsOf('panel', ONLY_B)
    expect(await s.removePin(ALICE, 'panel', ONLY_B)).toBe(false)
    await s.clearAllReadAt(scope, ONLY_B)
    await s.markSessionUnread(scope, ALICE, ONLY_B)
    await s.clearAllSnoozes(scope, ONLY_B)
    await s.clearSnooze(scope, BOB, ONLY_B)
    await s.clearOffer(scope, ONLY_B)
    await s.setDraft(ONLY_B, '')
    await s.setDraftDoc(ONLY_B, { text: '', updatedAt: AT, rev: 9, origin: null, history: [] })
    // The boot heal: in A, s5 points at an issue only B holds, so A detaches it; B's s5,
    // which points at an issue only A holds, is not A's to judge.
    expect(await s.detachDanglingIssueReferences()).toBe(1)
    expect((await s.getSession(sid(5)))?.issueId).toBeNull()
    // Upserts and writes of A's own per-person rows, at the keys both hold and new ones.
    await s.addPin(ALICE, 'repo', ROOT, AT)
    await s.markSessionRead(scope, ALICE, sid(2), AT)
    await s.markSessionRead(scope, BOB, sid(1), '2026-11-17T12:00:00.000Z')
    await s.setSnooze(scope, ALICE, sid(1), LATER)
    await s.setSnooze(scope, ALICE, sid(2), '2099-03-01T00:00:00.000Z')
    await s.setOffer(scope, sid(1), { message: 'a more', actions: [], createdAt: AT })
    await s.setOffer(scope, sid(2), { message: 'a more', actions: [], createdAt: AT })
    await s.setTabOrder(ALICE, ROOT, [sid(3)])
    await s.setTabOrder(ALICE, `${ROOT}/other`, [sid(1)])
    await s.setDraft(sid(1), 'a typed')
    await s.setDraft(sid(3), 'a typed')
    await s.setDraftDoc(sid(2), {
      text: 'a doc 2',
      updatedAt: AT,
      rev: 4,
      origin: null,
      history: [],
    })
    await s.listSnoozes(ALICE, Date.parse(LATER) + 1) // lapses A's timed snoozes

    expect(rowsOf(a, 'b')).toEqual(before)
    // And A's own writes landed.
    expect((await s.getSession(sid(1)))?.title).toBe('a renamed')
    expect((await s.getSession(sid(6)))?.id).toBe(sid(6))
    expect(await s.pinnedAt(ALICE, 'repo', ROOT)).toBe(AT)
    expect(await s.tabOrder(ALICE, ROOT)).toEqual([sid(3)])
    // B still reads all of its own rows.
    expect((await b.sessions.getSession(sid(1)))?.title).toBe('b session 1')
    expect((await b.sessions.getSession(ONLY_B))?.deletedAt).toBeNull()
    expect((await b.sessions.getSession(sid(5)))?.issueId).toBe(heldBy('a'))
    expect(await b.sessions.pinnersOf('panel', ONLY_B)).toEqual([ALICE])
    expect(await b.sessions.tabOrder(ALICE, ROOT)).toEqual(aliceOrder('b'))
  })

  it('A’s deletes of the ids both hold take A’s rows and no others', async () => {
    const [a, b] = await twoSeeded()
    const before = rowsOf(a, 'b')
    const s = a.sessions
    await s.softDeleteSessions(scope, [sid(1)], AT, 'standalone')
    await s.restoreDeletedForIssue(scope, iss(2))
    await s.detachTombstonesFromIssue(scope, iss(2))
    await s.purgeSession(scope, sid(1))
    expect(await s.removePinsOf('issue', iss(1))).toEqual([BOB])
    expect(await s.clearAllReadAt(scope, sid(1))).toEqual([])
    expect(await s.clearAllSnoozes(scope, sid(2))).toEqual([ALICE])
    await s.clearOffer(scope, sid(1))
    await s.setTabOrder(ALICE, ROOT, [])
    await s.setDraft(sid(2), '')
    expect(rowsOf(a, 'b')).toEqual(before)
    expect(await s.getSession(sid(1))).toBeUndefined()
    expect((await s.getSession(sid(4)))?.deletedAt).toBeNull()
    // B's rows of the same ids are there.
    expect((await b.sessions.getSession(sid(1)))?.title).toBe('b session 1')
    expect((await b.sessions.getSession(sid(4)))?.deletedAt).toBe(AT_OF.b)
    expect(await b.sessions.pinnersOf('issue', iss(1))).toEqual([BOB])
    expect(await b.sessions.tabOrder(ALICE, ROOT)).toEqual(aliceOrder('b'))
  })

  it('user state writes, of the keys both hold and of the keys only the other holds', async () => {
    const [a, b] = await twoSeeded()
    const before = rowsOf(a, 'b')

    // At the keys both hold: A's rows only.
    await a.layout.clear(scope, ALICE, 'dockTab')
    await a.layout.clearMany(scope, BOB, ['superOpen'])
    await a.dockShells.remove(ALICE, `${ROOT}/w1`)
    expect(await a.dockShells.removeByWorktree(`${ROOT}/w2`)).toEqual([shell('a', 'bob')])
    await a.settings.userPreferences.clear(ALICE, 'roles.coding.model')
    // At a shell only B holds: nothing in A matches.
    await a.dockShells.removeBySession(shell('b', 'alice'))
    // A's own writes.
    await a.layout.set(scope, ALICE, 'dockTab', 'shell', AT)
    await a.layout.setMany(scope, ALICE, { superOpen: true }, AT)
    await a.dockShells.set(ALICE, `${ROOT}/w9`, sid(9), AT)
    expect(await a.dockShells.tryClaim(ALICE, `${ROOT}/w8`, sid(8), AT)).toBe(true)
    expect(await a.dockShells.tryClaim(BOB, `${ROOT}/w2`, sid(3), AT)).toBe(true)
    await a.settings.userPreferences.set(ALICE, 'roles.coding.model', 'next', AT)
    await a.settings.userPreferences.clear(BOB, 'notifications.ntfyTopic')
    await a.readPositions.advance(scope, ALICE, 'issueEvents', { lastEventId: 99, seenAt: AT }, AT)

    expect(rowsOf(a, 'b')).toEqual(before)
    expect(await a.layout.get(ALICE, 'dockTab')).toBe('shell')
    expect((await a.readPositions.get(ALICE, 'issueEvents'))?.lastEventId).toBe(99)
    expect(await a.dockShells.get(BOB, `${ROOT}/w2`)).toBe(sid(3))
    // B reads its own values at the same keys.
    expect(await b.layout.get(ALICE, 'dockTab')).toBe('b-files')
    expect(await b.dockShells.get(ALICE, `${ROOT}/w1`)).toBe(shell('b', 'alice'))
    expect(await b.dockShells.get(BOB, `${ROOT}/w2`)).toBe(shell('b', 'bob'))
    expect(await b.settings.userPreferences.get(ALICE, 'roles.coding.model')).toBe('b-model')
    expect((await b.readPositions.get(ALICE, 'issueEvents'))?.lastEventId).toBe(20)
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

  it("keeps B's hint of an id when A forgets the same id, named or all", async () => {
    const [a, b] = await twoSeeded()
    expect(hintOf(a)).not.toBe(hintOf(b))
    // A read outside a span records what B's row holds.
    await b.sessions.getSession(sid(1))
    expect(await inSpan(b, async () => hintOf(b).get(sid(1)))).toBeDefined()

    // A's writes that forget: a tombstone of the same id, and two that forget every row.
    await a.sessions.softDeleteSessions(scope, [sid(1)], AT, 'standalone')
    await a.sessions.restoreDeletedForIssue(scope, iss(2))
    await a.sessions.detachDanglingIssueReferences()
    await a.sessions.getSession(sid(1))
    await a.sessions.purgeSession(scope, sid(1))

    expect(await inSpan(b, async () => hintOf(b).get(sid(1)))).toBeDefined()
    expect(await inSpan(a, async () => hintOf(a).get(sid(1)))).toBeUndefined()
  })
})

/**
 * THE SAME ID UPSERTED FIRST IN THE OTHER WORKSPACE (POD-7024): every ON CONFLICT target leads with workspace_id,
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
