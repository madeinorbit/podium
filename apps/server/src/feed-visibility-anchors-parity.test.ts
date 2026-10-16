/**
 * The visibility anchors answer from the database exactly as they answered from
 * the whole-table read cache (POD-6156 step 1).
 *
 * `legacyAnchors` is the old path: an index built over every installed row of
 * `change_latest` per append generation, plus the sessions of every issue that
 * has an audience. `anchors` reads only the rows the batch needs. Both are run
 * over the benchmark corpus (POD-6146: cell h1a1, seed 4443) with grants,
 * revoked audiences, ship orders and lanes laid over it, and over edge cases,
 * and must agree on every edge and every current value.
 */

import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  asIssueId,
  asRepoId,
  asShipOrderId,
  asUserId,
  firstAdminMemberId,
  type IssueId,
  issueDepId,
  issueEventRowId,
  type ShipOrder,
  shipLaneId,
} from '@podium/model'
import type { EntityRef, VisibilityAnchorPort } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFeedVisibility } from './feed-visibility'
import type { SessionStore } from './store'
import { issueRowFixture } from './test-support/issue-row'
import { openTestStore } from './test-support/open-test-store'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const OWNER = asUserId('owner-a')
const OWNERS: readonly string[] = [OWNER, asUserId('owner-b'), asUserId('owner-c')]
const READER = asUserId('reader')
const REVOKED = asUserId('revoked')

const PROFILE = {
  id: 'default',
  argv: ['bun', 'run', 'test'],
  cwd: 'integration-root' as const,
  timeoutMs: 60_000,
  resourceLocks: [] as string[],
}

/** Stable bucket in [0, n) for a fixture id. */
const bucketOf = (id: string, n: number): number =>
  createHash('sha256').update(id).digest().readUInt32BE(0) % n

interface WorldIssue {
  id: string
  owner: string
  repoPath: string
}
interface WorldSession {
  id: string
  issueId: string | null
  resumeValue: string | null
  deleted: boolean
}
interface WorldOrder {
  id: string
  issueId: string
  repo: string
  /** The order's domain state after setup. */
  state: 'queued' | 'cancelled'
  /** What the feed holds for it. */
  installed: 'row' | 'removed' | 'corrupt' | 'none'
}
interface World {
  issues: WorldIssue[]
  /** Raw installed `issueDep` ids, parseable or not; `removed` ones are upserted then removed. */
  deps: { id: string; removed: boolean }[]
  sessions: WorldSession[]
  grants: { issueId: string; grantee: string; revoked: boolean }[]
  orders: WorldOrder[]
  /** Extra installed rows: corrupt payloads, other kinds. */
  extra: { entity: string; entityId: string; payload: string }[]
  /** The issue-event window, per issue. */
  events: Map<string, { entity: 'issueEvent'; entityId: string }[]>
}

const order = (o: WorldOrder, issue: WorldIssue, machineId: string): ShipOrder =>
  ({
    id: asShipOrderId(o.id),
    issueId: asIssueId(o.issueId),
    descendantManifest: [],
    repoId: asRepoId(o.repo),
    repoPath: issue.repoPath,
    machineId,
    targetBranch: 'main',
    destination: 'local:main',
    approvedBaseSha: 'base',
    approvedHeadSha: `head-${o.id}`,
    deliveryDependsOn: [],
    requestedBy: {
      actor: { kind: 'user', id: firstAdminMemberId() },
      onBehalfOf: firstAdminMemberId(),
    },
    requestedAt: '2026-08-12T10:00:00.000Z',
    policyId: 'default',
    validationProfile: PROFILE,
    validationProfileDigest: createHash('sha256').update(JSON.stringify(PROFILE)).digest('hex'),
    closeMode: 'after-destination',
    state: 'queued',
    stateChangedAt: '2026-08-12T10:00:00.000Z',
  }) as unknown as ShipOrder

/** The installed payload a ship order's projection carries, as far as visibility reads it. */
const orderPayload = (o: WorldOrder) =>
  JSON.stringify({
    id: o.id,
    issueId: o.issueId,
    repoId: o.repo,
    destination: 'local:main',
    targetBranch: 'main',
    state: o.state,
  })

async function build(world: World) {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const repos = [...new Set(world.issues.map((issue) => issue.repoPath))]
  await store.transact(async () => {
    for (const path of repos) await store.repos.addRepo(path, store.hostMachineId)
  })
  const byId = new Map(world.issues.map((issue) => [issue.id, issue]))
  for (let start = 0; start < world.issues.length; start += 500) {
    await store.transact(async () => {
      for (const [index, issue] of world.issues.slice(start, start + 500).entries()) {
        await store.issues.upsertIssue({
          ...issueRowFixture({ id: issue.id, repoPath: issue.repoPath, seq: start + index + 1, ownerUserId: issue.owner }),
          repoId: undefined,
          machineId: store.hostMachineId,
          parentId: null,
          worktreePath: null,
        } as never)
      }
    })
  }
  await store.transact(async () => {
    for (const session of world.sessions) {
      await store.sessions.upsertSession({
        id: session.id,
        ownerUserId: OWNER,
        agentKind: 'claude-code',
        cwd: '/r',
        title: session.id,
        name: null,
        originKind: 'spawn',
        conversationId: null,
        resumeKind: session.resumeValue ? 'claude' : null,
        resumeValue: session.resumeValue,
        status: 'exited',
        exitCode: 0,
        durableLabel: `podium-${session.id}`,
        createdAt: '2026-08-01T00:00:00.000Z',
        lastActiveAt: '2026-08-01T00:00:00.000Z',
        lastOutputAt: null,
        lastInputAt: null,
        lastResumedAt: null,
        archived: false,
        workState: null,
        machineId: store.hostMachineId,
        headless: false,
        issueId: session.issueId === null ? null : asIssueId(session.issueId),
        stoppedAt: null,
      } as never)
    }
  })
  const deleted = world.sessions.filter((session) => session.deleted).map((session) => session.id)
  if (deleted.length > 0) await store.sessions.softDeleteSessions(deleted, '2026-08-02T00:00:00.000Z', 'user' as never)
  for (const grant of world.grants) {
    await store.grants.upsert({
      resourceKind: 'issue',
      resourceId: grant.issueId,
      grantee: grant.grantee,
      verb: 'read',
      owner: byId.get(grant.issueId)?.owner ?? OWNER,
      visibility: 'personal',
      createdAt: '2026-09-11T00:00:00Z',
      actorKind: 'user',
      actorId: OWNER,
      onBehalfOf: OWNER,
    })
    if (grant.revoked) await store.grants.remove('issue', grant.issueId, grant.grantee, 'read')
  }
  for (const o of world.orders) {
    const issue = byId.get(o.issueId)
    if (!issue) throw new Error(`order ${o.id} names unknown issue ${o.issueId}`)
    await store.shipping.createOrder(order(o, issue, store.hostMachineId))
    if (o.state === 'cancelled') {
      await store.shipping.transitionOrder(o.id, 'queued', 'cancelled', '2026-08-12T11:00:00.000Z')
    }
  }

  // The installed world, appended in one deterministic order.
  type Row = { entity: string; entityId: string; op: 'upsert' | 'remove'; payload: string | null }
  const rows: Row[] = []
  const up = (entity: string, entityId: string, payload: string) =>
    rows.push({ entity, entityId, op: 'upsert', payload })
  for (const issue of world.issues) {
    up('issueProjection', issue.id, JSON.stringify({ id: issue.id, owner: issue.owner }))
    if (bucketOf(`${issue.id}:git`, 2) === 0) up('issueGitState', issue.id, JSON.stringify({ id: issue.id }))
  }
  for (const session of world.sessions) {
    up('session', session.id, JSON.stringify({ id: session.id }))
    if (session.resumeValue) up('conversation', session.resumeValue, JSON.stringify({ id: session.resumeValue }))
  }
  for (const dep of world.deps) up('issueDep', dep.id, JSON.stringify({ id: dep.id }))
  for (const o of world.orders) {
    if (o.installed === 'none') continue
    up('shipOrder', o.id, o.installed === 'corrupt' ? '{not json' : orderPayload(o))
  }
  for (const o of world.orders) {
    if (o.state !== 'queued') continue
    up('shipLane', shipLaneId(asRepoId(o.repo), 'local:main'), JSON.stringify({ repo: o.repo }))
  }
  for (const events of world.events.values()) {
    for (const event of events) up('issueEvent', event.entityId, JSON.stringify({ id: event.entityId }))
  }
  for (const row of world.extra) up(row.entity, row.entityId, row.payload)
  // Removals land after their upserts, so the world no longer holds them.
  for (const dep of world.deps) {
    if (dep.removed) rows.push({ entity: 'issueDep', entityId: dep.id, op: 'remove', payload: null })
  }
  for (const o of world.orders) {
    if (o.installed === 'removed') rows.push({ entity: 'shipOrder', entityId: o.id, op: 'remove', payload: null })
  }
  for (let start = 0; start < rows.length; start += 1000) {
    await store.sync.appendChanges(rows.slice(start, start + 1000) as never, 1_000 + start)
  }

  const visibility = makeFeedVisibility({
    store,
    audienceResourceIds: (kind) => store.grants.visibilityAudienceResourceIds(kind),
    audienceFor: (kind, id) => store.grants.visibilityAudienceFor(kind, id),
    audiencesFor: (kind, ids) => store.grants.visibilityAudiencesFor(kind, ids),
    authorizationRevision: () => store.grants.visibilityRevision(),
    issueEventSubjects: (issueId: IssueId) => world.events.get(issueId) ?? [],
  })
  return { store, visibility }
}

/** Every ref a write batch can carry that anchors anything, plus a few that never do. */
function refsOf(world: World): EntityRef[] {
  return [
    ...world.issues.map((issue): EntityRef => ({ entity: 'issueProjection', entityId: issue.id })),
    ...world.orders.map((o): EntityRef => ({ entity: 'shipOrder', entityId: o.id })),
    { entity: 'issueProjection', entityId: 'iss_missing' },
    { entity: 'shipOrder', entityId: 'order-missing' },
    ...world.issues.slice(0, 3).map((issue): EntityRef => ({ entity: 'issueGitState', entityId: issue.id })),
    ...world.sessions.slice(0, 3).map((session): EntityRef => ({ entity: 'session', entityId: session.id })),
  ]
}

/**
 * Compare both ports over `refs`: the whole set as one batch, then in mixed
 * batches of seven, then each subject's current value, with refs that have no
 * installed row and refs whose payload is corrupt added.
 */
async function expectSameAnswers(
  legacy: VisibilityAnchorPort,
  current: VisibilityAnchorPort,
  refs: readonly EntityRef[],
  extraValueRefs: readonly EntityRef[],
) {
  let at = performance.now()
  const legacyEdges = await legacy.visibilityEdges(refs)
  console.log(`[parity] old edges ${Math.round(performance.now() - at)} ms`)
  at = performance.now()
  const edges = await current.visibilityEdges(refs)
  console.log(`[parity] new edges ${Math.round(performance.now() - at)} ms`)
  expect(edges).toEqual(legacyEdges)
  for (let start = 0; start < refs.length; start += 7) {
    const slice = refs.slice(start, start + 7)
    expect(await current.visibilityEdges(slice)).toEqual(legacyEdges.slice(start, start + 7))
  }
  const subjects = [...legacyEdges.flatMap((edge) => edge?.subjects ?? []), ...extraValueRefs]
  expect(await current.currentValuesOf(subjects)).toEqual(await legacy.currentValuesOf(subjects))
  return { edges: legacyEdges, subjects }
}

interface CorpusShape {
  issues: { id: string; repoPath: string | null; deletedAt: string | null }[]
  deps: { fromId: string; toId: string; type: string }[]
  sessions: { id: string; issueId: string | null; resumeValue: string | null }[]
  repos: string[]
}

async function exportedCorpus(): Promise<CorpusShape> {
  const module = fileURLToPath(new URL('../../../scripts/server-data-bench/corpus-export.ts', import.meta.url))
  const { exportCorpus } = (await import(module)) as {
    exportCorpus(cell: string, seed: number): Promise<CorpusShape>
  }
  return await exportCorpus('h1a1', 4443)
}

/** The corpus with grants, revoked audiences, ship orders, lanes and an event window laid over it. */
function corpusWorld(corpus: CorpusShape): World {
  const repoFallback = corpus.repos[0] ?? '/r'
  const issues: WorldIssue[] = corpus.issues.map((row) => ({
    id: `iss_${row.id}`,
    owner: OWNERS[bucketOf(row.id, OWNERS.length)] as string,
    repoPath: row.repoPath ?? repoFallback,
  }))
  const known = new Set(issues.map((issue) => issue.id))
  const deps = corpus.deps
    .filter((dep) => known.has(`iss_${dep.fromId}`))
    .map((dep) => ({
      id: issueDepId(`iss_${dep.fromId}`, `iss_${dep.toId}`, dep.type),
      removed: bucketOf(`${dep.fromId}:${dep.toId}:removed`, 10) === 0,
    }))
  const sessions: WorldSession[] = corpus.sessions.map((row) => ({
    id: `ses_${row.id}`,
    issueId: row.issueId && known.has(`iss_${row.issueId}`) ? `iss_${row.issueId}` : null,
    resumeValue: row.resumeValue,
    deleted: bucketOf(`${row.id}:deleted`, 12) === 0,
  }))
  const grants: World['grants'] = []
  const orders: WorldOrder[] = []
  const events = new Map<string, { entity: 'issueEvent'; entityId: string }[]>()
  let eventId = 1
  for (const issue of issues) {
    const g = bucketOf(`${issue.id}:grant`, 6)
    if (g === 0) grants.push({ issueId: issue.id, grantee: READER, revoked: false })
    if (g === 1) grants.push({ issueId: issue.id, grantee: REVOKED, revoked: true })
    if (g === 2) {
      grants.push({ issueId: issue.id, grantee: READER, revoked: false })
      grants.push({ issueId: issue.id, grantee: REVOKED, revoked: true })
    }
    const o = bucketOf(`${issue.id}:order`, 5)
    const repo = `repo-${bucketOf(`${issue.id}:lane`, 4)}`
    const installed = (['row', 'row', 'row', 'removed', 'none'] as const)[bucketOf(`${issue.id}:installed`, 5)] ?? 'row'
    if (o === 0 || o === 2) orders.push({ id: `order-${issue.id}-a`, issueId: issue.id, repo, state: 'cancelled', installed })
    if (o === 1 || o === 2) orders.push({ id: `order-${issue.id}-b`, issueId: issue.id, repo, state: 'queued', installed: 'row' })
    if (bucketOf(`${issue.id}:events`, 8) === 0 && eventId <= 200) {
      events.set(issue.id, [
        { entity: 'issueEvent', entityId: issueEventRowId(eventId++, issue.id) },
        { entity: 'issueEvent', entityId: issueEventRowId(eventId++, issue.id) },
      ])
    }
  }
  return { issues, deps, sessions, grants, orders, extra: [], events }
}

describe('visibility anchors: database reads answer like the whole-table read cache', () => {
  it('over the benchmark corpus (h1a1, seed 4443)', async () => {
    const started = performance.now()
    const lap = (label: string) => console.log(`[parity] ${label} at ${Math.round(performance.now() - started)} ms`)
    const world = corpusWorld(await exportedCorpus())
    lap(`corpus: ${world.issues.length} issues, ${world.sessions.length} sessions, ${world.deps.length} deps, ${world.orders.length} orders, ${world.grants.length} grants`)
    const { visibility } = await build(world)
    lap('store built')
    const { edges } = await expectSameAnswers(visibility.legacyAnchors, visibility.anchors, refsOf(world), [
      { entity: 'issueProjection', entityId: 'iss_missing' },
    ])
    // The corpus exercises every kind of subject, so the comparison is not vacuous.
    const kinds = new Set(edges.flatMap((edge) => edge?.subjects.map((subject) => subject.entity) ?? []))
    expect([...kinds].sort()).toEqual(
      ['conversation', 'issueDep', 'issueEvent', 'issueGitState', 'issueProjection', 'session', 'shipLane', 'shipOrder'].sort(),
    )
    expect(edges.filter((edge) => edge !== null).length).toBeGreaterThan(50)
    lap(`compared ${edges.length} refs, ${edges.filter((edge) => edge !== null).length} edges`)
  }, 900_000)

  it('over edge cases: escaped and prefix-sharing ids, foreign dep ids, removed and corrupt rows', async () => {
    const issues: WorldIssue[] = [
      'iss_1',
      'iss_10',
      'iss_1|x',
      'iss\\back',
      'iss|pipe',
      'iss_alone',
      'iss_no_audience',
    ].map((id, index) => ({ id, owner: OWNERS[index % OWNERS.length] as string, repoPath: '/r' }))
    const world: World = {
      issues,
      deps: [
        { id: issueDepId('iss_1', 'iss_10', 'blocked-by'), removed: false },
        { id: issueDepId('iss_1', 'iss_alone', 'related'), removed: false },
        { id: issueDepId('iss_10', 'iss_1', 'blocked-by'), removed: false },
        { id: issueDepId('iss_1|x', 'iss_1', 'blocked-by'), removed: false },
        { id: issueDepId('iss\\back', 'iss|pipe', 'blocked-by'), removed: false },
        { id: issueDepId('iss|pipe', 'iss\\back', 'related'), removed: false },
        { id: issueDepId('iss_1', 'iss|pipe', 'related'), removed: true },
        { id: issueDepId('iss_no_audience', 'iss_1', 'blocked-by'), removed: false },
        // Foreign spellings under an issue's prefix: two parts, four parts, a bad escape.
        { id: 'iss_1|only-two', removed: false },
        { id: 'iss_1|a|b|c', removed: false },
        { id: 'iss_1|\\q|t', removed: false },
      ],
      sessions: [
        { id: 'ses-1', issueId: 'iss_1', resumeValue: 'resume-1', deleted: false },
        { id: 'ses-2', issueId: 'iss_1', resumeValue: null, deleted: false },
        { id: 'ses-3', issueId: 'iss_1', resumeValue: 'resume-3', deleted: true },
        { id: 'ses-4', issueId: 'iss_10', resumeValue: 'resume-4', deleted: false },
        { id: 'ses-5', issueId: 'iss|pipe', resumeValue: null, deleted: false },
        { id: 'ses-6', issueId: null, resumeValue: 'resume-6', deleted: false },
      ],
      grants: [
        ...['iss_1', 'iss_10', 'iss_1|x', 'iss\\back', 'iss|pipe', 'iss_alone'].map((issueId) => ({
          issueId,
          grantee: READER,
          revoked: false,
        })),
        { issueId: 'iss_1', grantee: REVOKED, revoked: true },
        { issueId: 'iss_10', grantee: REVOKED, revoked: true },
      ],
      orders: [
        { id: 'order-1-old', issueId: 'iss_1', repo: 'repo-a', state: 'cancelled', installed: 'row' },
        { id: 'order-1', issueId: 'iss_1', repo: 'repo-a', state: 'queued', installed: 'row' },
        { id: 'order-10', issueId: 'iss_10', repo: 'repo-a', state: 'queued', installed: 'row' },
        { id: 'order-x-old', issueId: 'iss_1|x', repo: 'repo-b', state: 'cancelled', installed: 'removed' },
        { id: 'order-x', issueId: 'iss_1|x', repo: 'repo-b', state: 'queued', installed: 'corrupt' },
        { id: 'order-back', issueId: 'iss\\back', repo: 'repo-b', state: 'cancelled', installed: 'none' },
        { id: 'order-alone', issueId: 'iss_alone', repo: 'repo-c', state: 'cancelled', installed: 'row' },
      ],
      extra: [
        { entity: 'issueProjection', entityId: 'iss_corrupt', payload: '{bad' },
        { entity: 'shipOrder', entityId: 'order-null-payload', payload: 'null' },
        { entity: 'shipOrder', entityId: 'order-number-issue', payload: '{"issueId":7,"state":"queued"}' },
      ],
      events: new Map([
        ['iss_1', [{ entity: 'issueEvent' as const, entityId: issueEventRowId(1, 'iss_1') }]],
        ['iss|pipe', [{ entity: 'issueEvent' as const, entityId: issueEventRowId(2, 'iss|pipe') }]],
      ]),
    }
    const { visibility } = await build(world)
    const { edges } = await expectSameAnswers(visibility.legacyAnchors, visibility.anchors, refsOf(world), [
      { entity: 'issueProjection', entityId: 'iss_corrupt' },
      { entity: 'shipOrder', entityId: 'order-null-payload' },
      { entity: 'issueDep', entityId: issueDepId('iss_1', 'iss|pipe', 'related') },
      { entity: 'session', entityId: 'never-installed' },
    ])
    const edgeOf = (id: string) => edges[issues.findIndex((issue) => issue.id === id)]
    // The cases are live: dependencies under escaped and prefix-sharing ids,
    // only the parseable ones, sessions without the deleted one, and the lanes
    // of queued orders only.
    expect(edgeOf('iss_1')?.subjects).toEqual([
      { entity: 'issueProjection', entityId: 'iss_1' },
      { entity: 'issueGitState', entityId: 'iss_1' },
      { entity: 'session', entityId: 'ses-1' },
      { entity: 'session', entityId: 'ses-2' },
      { entity: 'conversation', entityId: 'resume-1' },
      { entity: 'issueDep', entityId: issueDepId('iss_1', 'iss_10', 'blocked-by') },
      { entity: 'issueDep', entityId: issueDepId('iss_1', 'iss_alone', 'related') },
      { entity: 'issueEvent', entityId: issueEventRowId(1, 'iss_1') },
      { entity: 'shipOrder', entityId: 'order-1-old' },
      { entity: 'shipOrder', entityId: 'order-1' },
      { entity: 'shipLane', entityId: shipLaneId(asRepoId('repo-a'), 'local:main') },
    ])
    expect(edgeOf('iss|pipe')?.subjects).toContainEqual({
      entity: 'issueDep',
      entityId: issueDepId('iss|pipe', 'iss\\back', 'related'),
    })
    expect(edgeOf('iss_no_audience')).toBeNull()
    // The cancelled order left lane repo-a: only the revoked reader can read
    // no order still queued in it.
    expect(edges[issues.length]).toEqual({
      audience: [REVOKED],
      subjects: [{ entity: 'shipLane', entityId: shipLaneId(asRepoId('repo-a'), 'local:main') }],
    })
  })
})
