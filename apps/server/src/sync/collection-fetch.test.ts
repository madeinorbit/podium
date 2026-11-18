/**
 * THE COLLECTION FETCH ANSWERS EVERY DECLARED COLLECTION BY ITS RULE (POD-7085).
 *
 * A file store holds an issue tree, closed and proposed and archived issues,
 * sixty-two done issues for paging, dependencies, read state, sessions of two
 * people (live, asking, old, archived, with and without an issue, one whose
 * saved agent state fails its schema), automations of both with their runs,
 * and an open ask. The sync worker's producer answers on it, exactly as
 * `POST /sync/collections` and `GET /sync/bootstrap` do.
 *
 * Held to the rules:
 *  - every declared collection, for each of the two people, answers what its
 *    rule answers in JavaScript over that person's whole world (every kind,
 *    streamed whole and filtered by the same rights), pages and totals
 *    included (acceptance 1);
 *  - nobody receives, or has counted, a record of the other's (acceptance 3);
 *  - a record arrives with what it comes with, each keyed instance marked;
 *  - the first download arrives in the policy's order, each collection closed
 *    by its marker (acceptance 4).
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentRuntimeState,
  type AutomationId,
  type AutomationRunId,
  type AutomationRunOutcome,
  actorUser,
  asMachineId,
  asSessionId,
  asUserId,
  COLLECTIONS,
  type Collection,
  clausesOf,
  firstAdminMemberId,
  type IssueId,
  interactionRowId,
  matchesWhere,
  type RuleArgs,
  recordOf,
  type Scalar,
  testKind,
  type UserId,
} from '@podium/model'
import { type CollectionInstance, ISSUE_STUB_FIELDS, type Principal } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { shapedValue } from '@podium/sync/bootstrap-worker'
import { fixtureWriteScope } from '@podium/sync/testing'
import { getTableName } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sessions } from '../migrations/schema'
import type { SessionStore } from '../store'
import { auditedCollectionShapes } from '../store/collections'
import { createBunStoreExecutor } from '../store/executor/bun-driver'
import type { SessionRow } from '../store/types'
import { produceBootstrap } from '../sync-worker/producer'
import type { SyncJob } from '../sync-worker/types'
import { bootstrapVisibility } from '../sync-worker/visibility'
import { issueRowFixture } from '../test-support/issue-row'
import { openTestStore } from '../test-support/open-test-store'
import { CollectionRequestError, resolveInstance } from './collection-fetch'
import { resolveRule, ruleStatement, statementOfKey } from './collection-shapes'
import { collectionTarget, isCollectionKind } from './collection-sql'
import { firstDownload, policyFor } from './policy'

const NOW = Date.now()
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString()
const BOB = asUserId('user:bob')

type Line = Record<string, unknown> & { type: string }
type Change = { entity: string; entityId: string; value: Record<string, unknown>; part?: string }

const state = (phase: AgentRuntimeState['phase']): AgentRuntimeState => ({
  phase,
  since: ago(1),
  nativeSubagentCount: 0,
})

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const TREE = [
  { id: 'iss_root', seq: 1, parentId: null, stage: 'in_progress', updatedAt: ago(1) },
  {
    id: 'iss_child',
    seq: 2,
    parentId: 'iss_root',
    stage: 'done',
    closedReason: 'done',
    updatedAt: ago(20),
  },
  { id: 'iss_grand', seq: 3, parentId: 'iss_child', stage: 'backlog', updatedAt: ago(8) },
  { id: 'iss_prop', seq: 4, parentId: null, stage: 'proposed', updatedAt: ago(2) },
  { id: 'iss_arch', seq: 5, parentId: null, stage: 'review', archived: true, updatedAt: ago(3) },
  { id: 'iss_lone', seq: 6, parentId: null, stage: 'backlog', updatedAt: ago(60) },
  // Closed 15 days ago, held by nothing but "recent": a browser's, not a phone's.
  {
    id: 'iss_month',
    seq: 7,
    parentId: null,
    stage: 'done',
    closedReason: 'done',
    updatedAt: ago(15),
  },
] as const

/** Sixty done issues, a minute apart, long ago: more than one page of the done column. */
const DONE = Array.from({ length: 60 }, (_, at) => ({
  id: `iss_done_${String(at).padStart(2, '0')}`,
  seq: 100 + at,
  parentId: at % 3 === 0 ? 'iss_root' : null,
  stage: 'done',
  closedReason: 'done',
  updatedAt: new Date(NOW - 90 * 86_400_000 - at * 60_000).toISOString(),
}))

interface PlantedSession {
  readonly id: string
  readonly owner: 'a' | 'b'
  readonly row?: Partial<SessionRow>
  readonly offerAt?: string
  /** Saved agent state JSON written as is, past the schema. */
  readonly rawAgentState?: string
}

const SESSIONS: readonly PlantedSession[] = [
  { id: 's-live', owner: 'a', row: { status: 'live', issueId: 'iss_root' as IssueId } },
  {
    id: 's-asking',
    owner: 'a',
    row: { status: 'exited', agentState: state('needs_user'), lastActiveAt: ago(50) },
  },
  {
    id: 's-offer',
    owner: 'a',
    row: {
      status: 'exited',
      lastInputAt: ago(3),
      lastActiveAt: ago(3),
      issueId: 'iss_grand' as IssueId,
    },
    offerAt: ago(2),
  },
  { id: 's-old', owner: 'a', row: { status: 'exited', lastActiveAt: ago(60) } },
  {
    id: 's-arch',
    owner: 'a',
    row: {
      status: 'exited',
      archived: true,
      issueId: 'iss_root' as IssueId,
      lastActiveAt: ago(40),
    },
  },
  {
    id: 's-done',
    owner: 'a',
    row: { status: 'exited', issueId: 'iss_done_00' as IssueId, lastActiveAt: ago(90) },
  },
  // The builder drops a saved agent state that fails its schema; the SQL reads it as asking.
  {
    id: 's-broken',
    owner: 'a',
    row: { status: 'exited', lastActiveAt: ago(70) },
    rawAgentState: '{"phase":"needs_user"}',
  },
  { id: 's-bob', owner: 'b', row: { status: 'live', issueId: 'iss_root' as IssueId } },
  {
    id: 's-bob-old',
    owner: 'b',
    row: { status: 'exited', lastActiveAt: ago(45), agentState: state('errored') },
  },
]

function sessionRow(
  planted: PlantedSession,
  owner: UserId,
  machineId: SessionRow['machineId'],
): SessionRow {
  return {
    id: asSessionId(planted.id),
    ownerUserId: owner,
    agentKind: 'codex',
    cwd: '/workspace',
    title: planted.id,
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: null,
    resumeValue: null,
    status: 'live',
    exitCode: null,
    spawnFailure: null,
    durableLabel: `podium-${planted.id}`,
    createdAt: ago(100),
    lastActiveAt: ago(1),
    geometry: { cols: 120, rows: 40 },
    archived: false,
    workState: null,
    machineId,
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    spawnedBy: 'user',
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
    createdBy: { actor: actorUser(owner), onBehalfOf: owner },
    ...planted.row,
  }
}

type RawDb = {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown }
}
const rawDb = (store: SessionStore): RawDb => (store as unknown as { db: RawDb }).db

async function plant(store: SessionStore): Promise<{ owner: UserId }> {
  const owner = await firstAdminMemberId(store)
  for (const issue of [...TREE, ...DONE]) {
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      issueRowFixture({ archived: false, closedReason: null, ...issue, parentId: null }),
    )
  }
  for (const issue of [...TREE, ...DONE]) {
    if (issue.parentId === null) continue
    const row = (await store.issues.getIssue(issue.id as IssueId))!
    row.parentId = issue.parentId as IssueId
    await store.issues.upsertIssue(fixtureWriteScope(), row)
  }
  await store.issues.addIssueDep('iss_grand' as IssueId, 'iss_root' as IssueId)
  await store.issues.setIssueUserState(fixtureWriteScope(), owner, 'iss_root' as IssueId, {
    readAt: ago(1),
  })
  await store.issues.setIssueUserState(fixtureWriteScope(), BOB, 'iss_root' as IssueId, {
    readAt: ago(2),
  })
  const machine = asMachineId(store.hostMachineId)
  for (const planted of SESSIONS) {
    const who = planted.owner === 'a' ? owner : BOB
    await store.sessions.upsertSession(fixtureWriteScope(), sessionRow(planted, who, machine))
    if (planted.offerAt) {
      await store.sessions.setOffer(fixtureWriteScope(), asSessionId(planted.id), {
        message: 'Ready',
        actions: [],
        createdAt: planted.offerAt,
      })
    }
  }
  await store.sessions.markSessionRead(fixtureWriteScope(), owner, asSessionId('s-live'), ago(1))
  await store.interactions.insert({
    id: 'ask-1',
    sessionId: asSessionId('s-asking'),
    kind: 'question',
    payload: {
      v: 1,
      questions: [{ question: 'Which?', multiSelect: false, previewLayout: false, options: [] }],
    },
    source: 'protocol',
    answerable: 'structured',
    fingerprint: 'ask-1',
    askedAt: ago(1),
  })
  for (const [who, name, runs] of [
    [owner, 'auto-a', 3],
    [BOB, 'auto-b', 2],
  ] as const) {
    await store.automations.insert(fixtureWriteScope(), {
      id: name as AutomationId,
      name,
      enabled: false,
      repoPath: '/repo',
      scheduleKind: 'cron',
      cron: '0 3 * * *',
      runAt: null,
      targetSessionId: null,
      agentKind: 'claude-code',
      model: 'auto',
      effort: 'auto',
      prompt: 'sweep',
      sessionMode: 'fresh',
      nextRunAt: null,
      lastRunAt: null,
      createdAt: ago(100),
      ownerUserId: who,
      createdByActor: `user:${who}`,
      createdByOnBehalfOf: who,
    })
    for (let at = 0; at < runs; at++) {
      await store.automations.addRun(fixtureWriteScope(), {
        id: `${name}-run-${at}` as AutomationRunId,
        automationId: name as AutomationId,
        firedAt: ago(at * 20 + 1),
        sessionId: null,
        outcome: 'missed' as AutomationRunOutcome,
        detail: null,
        actor: 'system:automation',
        onBehalfOf: who,
      })
    }
  }
  // A saved agent state the record builder drops: it fails the schema.
  for (const planted of SESSIONS) {
    if (planted.rawAgentState === undefined) continue
    rawDb(store)
      .prepare(
        `UPDATE ${getTableName(sessions)} SET ${sessions.agentStateJson.name} = ? WHERE ${sessions.id.name} = ?`,
      )
      .run(planted.rawAgentState, planted.id)
  }
  return { owner }
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

let dir: string
let path: string
let store: SessionStore
let viewers: { name: string; user: UserId }[]

const principalOf = (user: UserId): Principal => ({ ...DEVICE_GRADE_PRINCIPAL, user }) as Principal

const base = (user: UserId) => ({
  transferId: randomUUID(),
  principal: principalOf(user),
  feedId: 'feed',
  epoch: 'epoch',
  encoding: 'identity' as const,
  deadlineMs: Date.now() + 120_000,
})

async function linesOf(job: SyncJob): Promise<Line[]> {
  const chunks: Uint8Array[] = []
  for await (const bytes of produceBootstrap(
    path,
    job,
    new AbortController().signal,
    () => {},
    undefined,
    {
      now: () => NOW,
    },
  ))
    chunks.push(bytes)
  return Buffer.concat(chunks)
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Line)
}

const fetchLines = async (user: UserId, instances: CollectionInstance[]) =>
  await linesOf({ ...base(user), mode: 'collections', instances })

const changesOf = (lines: readonly Line[]): Change[] =>
  lines
    .filter((line) => line.type === 'feedBootstrap' || line.type === 'feedStubs')
    .flatMap((line) => line.changes as Change[])

const markersOf = (lines: readonly Line[]) =>
  lines
    .filter((line) => line.type === 'collectionComplete')
    .flatMap((line) => line.instances as Record<string, unknown>[])

/**
 * Each person's whole world: every kind, built whole and filtered by their
 * rights, by the worker's own record builders and sharing rules on one read
 * snapshot. No wire route streams every kind any more (POD-7086); this is the
 * loop the removed kind-named load ran, kept as the rules' oracle.
 */
const worlds = new Map<UserId, Map<string, Map<string, Record<string, unknown>>>>()

async function worldOf(user: UserId) {
  const db = openDatabase(path, { readOnly: true })
  db.exec('PRAGMA query_only = ON; BEGIN')
  const executor = createBunStoreExecutor({ database: db })
  const bundle = bootstrapVisibility(executor, { now: () => NOW })
  const out = new Map<string, Map<string, Record<string, unknown>>>()
  try {
    const { policy: rights, records } = await bundle.context
    const principal = principalOf(user)
    for await (const { entity, records: page } of records.streamAllKinds()) {
      const decided = await rights.forBootstrap(
        page.map((record) => ({ entity, entityId: record.id })),
      )
      for (const record of page) {
        const ref = { entity, entityId: record.id }
        if (!decided.decide(principal, ref).visible) continue
        const kind = out.get(entity) ?? new Map()
        kind.set(
          record.id,
          shapedValue(decided, principal, ref, record.value) as Record<string, unknown>,
        )
        out.set(entity, kind)
      }
    }
  } finally {
    await executor.close()
  }
  return out
}

/** The records of one instance's own answer: those before its marker. */
function membersOf(lines: readonly Line[], collection: string): Change[] {
  const out: Change[] = []
  for (const line of lines) {
    if (line.type === 'collectionComplete') {
      const own = (line.instances as { collection: string; via?: string }[]).some(
        (instance) => instance.collection === collection && instance.via === undefined,
      )
      if (own) return out
    }
    if (line.type === 'feedBootstrap' || line.type === 'feedStubs')
      out.push(...(line.changes as Change[]))
  }
  throw new Error(`no marker for ${collection}`)
}

/** The instance arguments the tests ask each collection with. */
function argsFor(collection: Collection): Record<string, Scalar> {
  const one: Record<string, string> = {
    issueProjection: 'iss_grand',
    session: 's-live',
    automationRun: 'auto-a-run-0',
  }
  const values: Record<string, Scalar> = {
    root: 'iss_root',
    stage: 'done',
    priority: 2,
    issueId: 'iss_root',
    sessionId: 's-live',
    id: one[collection.of] ?? 'absent',
  }
  return Object.fromEntries(resolveRule(collection.id).params.map((name) => [name, values[name]!]))
}

const sortValue = (value: unknown): Scalar =>
  value === undefined || value === null ? '' : (value as Scalar)

function compareBy(sort: NonNullable<Collection['page']>['sort']) {
  return (a: Record<string, unknown>, b: Record<string, unknown>) => {
    for (const { field, direction } of sort) {
      const x = sortValue(a[field])
      const y = sortValue(b[field])
      if (x === y) continue
      const order = (x as string | number) < (y as string | number) ? -1 : 1
      return direction === 'desc' ? -order : order
    }
    return 0
  }
}

/** What the rule answers in JavaScript over a person's whole world. */
function expected(user: UserId, collection: Collection, args: RuleArgs, recentDays = 30) {
  const world = worlds.get(user)!
  const records = [...(world.get(collection.of) ?? new Map()).entries()]
  const issueRecords = world.get('issueProjection') ?? new Map()
  const matching =
    collection.where === undefined
      ? records
      : records.filter(([id, value]) =>
          matchesWhere(collection.where!, value, {
            now: NOW,
            args: { recentDays, ...args },
            parentOf: (issue) => issueRecords.get(issue)?.['parentId'] as string | undefined,
            idOf: () => id,
          }),
        )
  if (collection.page === undefined)
    return { ids: matching.map(([id]) => id).sort(), records: matching }
  const ordered = [...matching].sort(([, a], [, b]) => compareBy(collection.page!.sort)(a, b))
  return {
    ids: ordered.slice(0, collection.page.size).map(([id]) => id),
    ordered,
    total: ordered.length,
    records: ordered.slice(0, collection.page.size),
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pod-7085-fetch-'))
  path = join(dir, 'podium.db')
  store = await openTestStore(path)
  const { owner } = await plant(store)
  viewers = [
    { name: 'the owner', user: owner },
    { name: 'another person', user: BOB },
  ]
  for (const { user } of viewers) worlds.set(user, await worldOf(user))
}, 120_000)

afterAll(async () => {
  await store?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Acceptance 1: every declared collection, by its rule
// ---------------------------------------------------------------------------

describe('every declared collection answers its rule (acceptance 1)', () => {
  it('plants a world with records for the rules to tell apart', () => {
    const owner = worlds.get(viewers[0]!.user)!
    expect(owner.get('issueProjection')?.size).toBe(TREE.length + DONE.length)
    expect(owner.get('session')?.has('s-live')).toBe(true)
    expect(owner.get('session')?.has('s-bob')).toBe(false)
    expect(owner.get('automationRun')?.size).toBe(3)
    expect(owner.get('issueDep')?.size).toBe(1)
    expect(worlds.get(BOB)!.get('automationRun')?.size).toBe(2)
  })

  for (const collection of COLLECTIONS.values()) {
    it(`${collection.id}, for both people`, async () => {
      for (const { name, user } of viewers) {
        const args = argsFor(collection)
        const lines = await fetchLines(user, [
          { collection: collection.id, ...(Object.keys(args).length === 0 ? {} : { args }) },
        ])
        const members = membersOf(lines, collection.id)
        const want = expected(user, collection, args)
        const marker = markersOf(lines).find(
          (m) => m['collection'] === collection.id && m['via'] === undefined,
        )!
        expect(marker['part'], name).toBe(collection.part)
        if (collection.page === undefined) {
          expect(members.map((c) => c.entityId).sort(), `${collection.id} for ${name}`).toEqual(
            want.ids,
          )
        } else {
          expect(
            members.map((c) => c.entityId),
            `${collection.id} for ${name}`,
          ).toEqual(want.ids)
          expect(marker['total'], `${collection.id} total for ${name}`).toBe(want.total)
          expect((marker['range'] as { end: boolean }).end).toBe(
            want.total! <= collection.page.size,
          )
        }
        if (collection.part === 'stub') {
          const world = worlds.get(user)!.get(collection.of)!
          for (const change of members) {
            expect(change.part).toBe('stub')
            const whole = world.get(change.entityId)!
            expect(change.value).toEqual(
              Object.fromEntries(
                ISSUE_STUB_FIELDS.filter((f) => f in whole).map((f) => [f, whole[f]]),
              ),
            )
          }
        } else {
          // Whole records, exactly as the feed sends them to this person.
          const world = worlds.get(user)!.get(collection.of) ?? new Map()
          for (const change of members) expect(change.value).toEqual(world.get(change.entityId))
        }
      }
    }, 60_000)
  }

  it('answers an issue collection at stub level when asked', async () => {
    const lines = await fetchLines(viewers[0]!.user, [
      { collection: 'issueProjection.tree', args: { root: 'iss_root' }, part: 'stub' },
    ])
    const members = membersOf(lines, 'issueProjection.tree')
    expect(members.every((c) => c.part === 'stub')).toBe(true)
    expect(members.map((c) => c.entityId).sort()).toEqual(
      expected(viewers[0]!.user, COLLECTIONS.get('issueProjection.tree')!, { root: 'iss_root' })
        .ids,
    )
    // A stub brings nothing along.
    expect(changesOf(lines)).toHaveLength(members.length)
  })

  it('pages the done column below a position, to its end', async () => {
    const collection = COLLECTIONS.get('issueProjection.byStage')!
    const user = viewers[0]!.user
    const first = await fetchLines(user, [{ collection: collection.id, args: { stage: 'done' } }])
    const marker = markersOf(first)[0] as {
      range: { through: Scalar[]; end: boolean }
      total: number
    }
    const want = expected(user, collection, { stage: 'done' })
    expect(marker.total).toBe(want.total)
    expect(marker.total).toBeGreaterThan(collection.page!.size)
    expect(marker.range.end).toBe(false)
    const next = await fetchLines(user, [
      {
        collection: collection.id,
        args: { stage: 'done' },
        after: marker.range.through as [Scalar, ...Scalar[]],
      },
    ])
    const rest = membersOf(next, collection.id).map((c) => c.entityId)
    expect(rest).toEqual(want.ordered!.slice(collection.page!.size).map(([id]) => id))
    const nextMarker = markersOf(next)[0] as { range: { end: boolean }; total?: number }
    expect(nextMarker.range.end).toBe(true)
    // The total comes with the first page only.
    expect(nextMarker.total).toBeUndefined()
  }, 60_000)

  it('leaves out a session whose saved agent state the builder drops, though the SQL selects it', async () => {
    const rule = resolveRule('session.asking')
    const statement = ruleStatement(rule, 'ids', {}, NOW)
    const selected = (
      rawDb(store)
        .prepare(statement.sql)
        .all(...statement.params) as { c0: string }[]
    ).map((row) => row.c0)
    expect(selected).toContain('s-broken')
    const lines = await fetchLines(viewers[0]!.user, [{ collection: 'session.asking' }])
    const asked = membersOf(lines, 'session.asking').map((c) => c.entityId)
    expect(asked).not.toContain('s-broken')
    expect(asked).toContain('s-asking')
  })

  it('no declared rule negates a test on a JSON field, so the SQL is a superset', () => {
    for (const collection of COLLECTIONS.values()) {
      if (collection.where === undefined || !isCollectionKind(collection.of)) continue
      const target = collectionTarget(collection.of)
      for (const clause of clausesOf(collection.where)) {
        for (const [path, test] of Object.entries(clause)) {
          if (testKind(test) !== 'not') continue
          expect(target.field(path.split('.')[0]!)?.type, `${collection.id} ${path}`).not.toBe(
            'json',
          )
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Acceptance 3: nobody receives or counts another person's record
// ---------------------------------------------------------------------------

describe('a person never receives or counts a record of another (acceptance 3)', () => {
  it('sends each person only their own sessions, runs and state, and counts only theirs', async () => {
    const [owner] = viewers
    const instances: CollectionInstance[] = [
      { collection: 'session.live' },
      { collection: 'session.asking' },
      { collection: 'automationRun.page' },
      { collection: 'issueProjection.sidebar' },
      { collection: 'issueProjection.one', args: { id: 'iss_root' } },
    ]
    const forOwner = await fetchLines(owner!.user, instances)
    const forBob = await fetchLines(BOB, instances)
    const ids = (lines: Line[]) => changesOf(lines).map((c) => `${c.entity}:${c.entityId}`)
    const ownerOnly = [
      'session:s-live',
      'session:s-asking',
      'session:s-offer',
      'automationRun:auto-a-run-0',
    ]
    for (const id of ownerOnly) {
      expect(ids(forOwner)).toContain(id)
      expect(ids(forBob)).not.toContain(id)
    }
    expect(ids(forBob)).toContain('session:s-bob')
    expect(ids(forOwner)).not.toContain('session:s-bob')
    // The private records leave no trace in the other's answer, not even an id.
    const bobText = JSON.stringify(forBob)
    for (const id of ['s-live', 's-asking', 's-offer', 'auto-a-run'])
      expect(bobText).not.toContain(id)
    expect(JSON.stringify(forOwner)).not.toContain('auto-b-run')
    // The totals count what each person may see.
    const total = (lines: Line[]) =>
      markersOf(lines).find((m) => m['collection'] === 'automationRun.page')!['total']
    expect(total(forOwner)).toBe(3)
    expect(total(forBob)).toBe(2)
    // The user's own read state of the issue comes with it, never the other's.
    const userStates = (lines: Line[]) =>
      changesOf(lines)
        .filter((c) => c.entity === 'issueUserState')
        .map((c) => c.value['userId'])
    expect(userStates(forOwner)).toEqual([owner!.user])
    expect(userStates(forBob)).toEqual([BOB])
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Comes with
// ---------------------------------------------------------------------------

describe('a record arrives with what it comes with, each keyed instance marked', () => {
  it('an issue comes with its ancestors, its dependencies and the read state', async () => {
    const lines = await fetchLines(viewers[0]!.user, [
      { collection: 'issueProjection.one', args: { id: 'iss_grand' } },
    ])
    const arrived = changesOf(lines).map((c) => `${c.entity}:${c.entityId}`)
    expect(arrived).toEqual(
      expect.arrayContaining([
        'issueProjection:iss_grand',
        'issueProjection:iss_child',
        'issueProjection:iss_root',
        `issueDep:${[...worlds.get(viewers[0]!.user)!.get('issueDep')!.keys()][0]}`,
      ]),
    )
    const marked = markersOf(lines).map(
      (m) => `${m['via'] ?? ''}>${m['collection']}:${JSON.stringify(m['args'] ?? {})}`,
    )
    expect(marked).toEqual(
      expect.arrayContaining([
        '>issueProjection.one:{"id":"iss_grand"}',
        'issueProjection>issueProjection.one:{"id":"iss_child"}',
        'issueProjection>issueProjection.one:{"id":"iss_root"}',
        'issueProjection>issueDep.ofIssue:{"issueId":"iss_grand"}',
        'issueProjection>issueUserState.ofIssue:{"issueId":"iss_root"}',
        'issueProjection>issueGitState.ofIssue:{"issueId":"iss_child"}',
      ]),
    )
    // Each record once, though three issues come with the same root.
    expect(new Set(arrived).size).toBe(arrived.length)
  })

  it('the sidebar comes with its sessions that are not archived, and a session with its issue', async () => {
    const lines = await fetchLines(viewers[0]!.user, [{ collection: 'issueProjection.sidebar' }])
    const sessionIds = changesOf(lines)
      .filter((c) => c.entity === 'session')
      .map((c) => c.entityId)
    expect(sessionIds.sort()).toEqual(['s-live', 's-offer'])
    const marked = markersOf(lines).map(
      (m) => `${m['via'] ?? ''}>${m['collection']}:${JSON.stringify(m['args'] ?? {})}`,
    )
    expect(marked).toEqual(
      expect.arrayContaining([
        'issueProjection.sidebar>session.ofIssue:{"issueId":"iss_root"}',
        'issueProjection.sidebar>session.ofIssue:{"issueId":"iss_lone"}',
        'session>sessionUserState.ofSession:{"sessionId":"s-live"}',
        'session>issueProjection.one:{"id":"iss_root"}',
      ]),
    )
    expect(
      changesOf(lines).some(
        (c) => c.entity === 'sessionUserState' && c.value['sessionId'] === 's-live',
      ),
    ).toBe(true)
  })

  it('a pending ask comes with its session, and that session with its own', async () => {
    const lines = await fetchLines(viewers[0]!.user, [{ collection: 'pendingInteraction.all' }])
    const arrived = changesOf(lines).map((c) => `${c.entity}:${c.entityId}`)
    // A pending interaction's record id is its session and its own id (its declaration's key).
    expect(arrived).toContain(`pendingInteraction:${interactionRowId('s-asking', 'ask-1')}`)
    expect(arrived).toContain('session:s-asking')
    expect(markersOf(lines).map((m) => m['collection'])).toContain('sessionUserState.ofSession')
  })
})

// ---------------------------------------------------------------------------
// Acceptance 4: the first download, in the policy's order
// ---------------------------------------------------------------------------

describe('the first download arrives in the policy order, each collection closed by its marker (acceptance 4)', () => {
  it('loads always and live, the view, recent, the sidebar, then the stubs', async () => {
    const view: CollectionInstance[] = [
      { collection: 'issueProjection.tree', args: { root: 'iss_root' } },
    ]
    const lines = await linesOf({ ...base(viewers[0]!.user), view })
    const meta = lines[0]!
    expect(meta['type']).toBe('syncMeta')
    expect(meta['policy']).toEqual(policyFor('browser'))
    const order = firstDownload(policyFor('browser'), view).map((instance) => instance.collection)
    // Each instance's own marker, in the policy's order.
    const markerAt = new Map<string, number>()
    const arrivedAt = new Map<string, number>()
    lines.forEach((line, at) => {
      if (line.type === 'collectionComplete') {
        for (const m of line.instances as { collection: string; via?: string }[])
          if (m.via === undefined && !markerAt.has(m.collection)) markerAt.set(m.collection, at)
      }
      if (line.type === 'feedBootstrap' || line.type === 'feedStubs') {
        for (const change of line.changes as Change[]) {
          const key = `${change.entity}:${change.entityId}`
          if (!arrivedAt.has(key)) arrivedAt.set(key, at)
        }
      }
    })
    expect([...markerAt.keys()]).toEqual(order)
    expect([...markerAt.values()]).toEqual([...markerAt.values()].sort((x, y) => x - y))
    // Every record of each collection has arrived before that collection's marker.
    for (const instance of firstDownload(policyFor('browser'), view)) {
      const collection = COLLECTIONS.get(instance.collection)!
      const want = expected(viewers[0]!.user, collection, instance.args ?? {})
      for (const id of want.ids) {
        const arrived = arrivedAt.get(`${collection.of}:${id}`)
        expect(arrived, `${collection.id} ${id}`).toBeDefined()
        expect(arrived!, `${collection.id} ${id}`).toBeLessThan(markerAt.get(collection.id)!)
      }
    }
    // The start-up load does not send every record of every kind: no brief, no closed history whole.
    const whole = changesOf(lines).filter((c) => c.part !== 'stub')
    for (const kind of Object.keys(recordOf('issueProjection').body))
      expect(
        whole.some((c) => c.entity === kind),
        kind,
      ).toBe(false)
    expect(worlds.get(viewers[0]!.user)!.get('issueDescription')?.size).toBeGreaterThan(0)
    expect(whole.some((c) => c.entityId === 'iss_done_59')).toBe(false)
    // But every issue is there as a stub or whole.
    const issueIds = new Set(
      changesOf(lines)
        .filter((c) => c.entity === 'issueProjection')
        .map((c) => c.entityId),
    )
    expect(issueIds.size).toBe(TREE.length + DONE.length)
    // It ends as a start-up load ends.
    expect(lines.at(-2)).toMatchObject({ type: 'feedBootstrap', last: true })
    expect(lines.at(-1)).toMatchObject({ type: 'syncComplete', seq: meta['seq'] })
  }, 60_000)

  it('takes the recent days from the client type’s policy', async () => {
    const user = viewers[0]!.user
    const wholeIn = (lines: Line[]) =>
      new Set(
        changesOf(lines)
          .filter((c) => c.part !== 'stub')
          .map((c) => `${c.entity}:${c.entityId}`),
      )
    const phone = await linesOf({ ...base(user), clientType: 'phone' })
    const browser = await linesOf({ ...base(user) })
    expect((phone[0]!['policy'] as { recentDays: number }).recentDays).toBe(7)
    expect((browser[0]!['policy'] as { recentDays: number }).recentDays).toBe(30)
    // Closed 15 days ago and held by nothing else: recent for a browser only.
    expect(wholeIn(browser).has('issueProjection:iss_month')).toBe(true)
    expect(wholeIn(phone).has('issueProjection:iss_month')).toBe(false)
    expect(changesOf(phone).some((c) => c.entityId === 'iss_month' && c.part === 'stub')).toBe(true)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Requests and statements
// ---------------------------------------------------------------------------

describe('requests and statements', () => {
  it('refuses an instance no declaration describes', () => {
    const refused: CollectionInstance[] = [
      { collection: 'issueProjection.nope' },
      { collection: 'issueProjection.tree' },
      { collection: 'issueProjection.tree', args: { root: 'x', extra: 'y' } },
      { collection: 'session.live', part: 'stub' },
      { collection: 'session.live', after: ['x'] },
      { collection: 'session.ofIssue', args: { issueId: 'x' }, via: 'issueProjection.recent' },
      { collection: 'issueProjection.byStage', args: { stage: 'done' }, after: ['x'] },
    ]
    for (const instance of refused)
      expect(() => resolveInstance(instance), JSON.stringify(instance)).toThrow(
        CollectionRequestError,
      )
    expect(() =>
      resolveInstance({
        collection: 'session.ofIssue',
        args: { issueId: 'x' },
        via: 'issueProjection.sidebar',
      }),
    ).not.toThrow()
  })

  it('binds every value: no argument ever reaches the statement text', () => {
    const hostile = "x'); DROP TABLE issues; --"
    for (const collection of COLLECTIONS.values()) {
      if (collection.where === undefined) continue
      const rule = resolveRule(collection.id)
      const args = Object.fromEntries(
        [...rule.params, 'recentDays'].map((name) => [name, name === 'recentDays' ? 7 : hostile]),
      )
      const statement = ruleStatement(rule, 'ids', args, NOW)
      expect(statement.sql, collection.id).not.toContain('DROP TABLE')
      if (rule.params.length > 0) expect(statement.params).toContain(hostile)
    }
    // Every shape the audit plans builds from its key alone.
    for (const key of auditedCollectionShapes())
      expect(() => statementOfKey(key), key).not.toThrow()
  })

  it('a policy collection takes no arguments of its own', () => {
    for (const type of ['phone', 'browser', 'desktop'] as const) {
      for (const instance of firstDownload(policyFor(type), []))
        expect(() => resolveInstance(instance), instance.collection).not.toThrow()
    }
    expect(recordOf('issueProjection').stub).toEqual(ISSUE_STUB_FIELDS)
  })
})
