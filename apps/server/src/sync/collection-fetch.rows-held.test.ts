/**
 * POD-7609 — AN INSTANCE ASKED WITH THE ROWS THE DEVICE HOLDS SENDS ONLY WHAT
 * CHANGED SINCE, ON BOTH ENGINES.
 *
 * A deck's archive (`issueProjection.treeArchive`) selects the same issues as
 * the deck's tree (`issueProjection.tree`), each with its archived sessions.
 * A device that holds the tree names it (`rowsHeld: { collection, seq }`):
 * the answer then sends the members changed after `seq` and nothing else of
 * the tree, still answers the archived sessions with their markers, and ends
 * with the archive's own marker. Where the log cannot say what changed (it no
 * longer reaches back to `seq`), every member goes out, as before.
 *
 * An issue moved under the tree brings descendants the device never held:
 * they go out with it. The answer's statements do not grow with the tree.
 *
 * Each run logs the issues and lines one archive answer sends with and
 * without the held rows (`ROWS-HELD` lines).
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  actorUser,
  asMachineId,
  asSessionId,
  firstAdminMemberId,
  type IssueId,
  type UserId,
} from '@podium/model'
import type { CollectionInstance, Principal } from '@podium/protocol'
import { queryKey } from '@podium/runtime/query-attribution'
import type { OpenOptions, SqlDatabase } from '@podium/runtime/sqlite'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../store'
import type { PgDriverOptions } from '../store/executor/pg-driver'
import { probeStatements } from '../store/executor/statement-probe'
import type { SessionRow } from '../store/types'
import { produceBootstrap } from '../sync-worker/producer'
import type { SyncJob } from '../sync-worker/types'
import { issueRowFixture } from '../test-support/issue-row'
import { openTestStore, testStoreLocation } from '../test-support/open-test-store'
import { testStoreEngine } from '../test-support/pg-test-database'
import { CollectionRequestError, resolveInstance } from './collection-fetch'

/** Every read-only handle the worker job opens while it is being counted. */
const worker = vi.hoisted(() => ({ onOpen: undefined as ((db: unknown) => void) | undefined }))

vi.mock('@podium/runtime/sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@podium/runtime/sqlite')>()
  return {
    ...actual,
    openDatabase: (path: string, opts?: OpenOptions) => {
      const db = actual.openDatabase(path, opts)
      if (opts?.readOnly) worker.onOpen?.(db)
      return db
    },
  }
})

// On Postgres the worker's read session is a pool of one (POD-6991).
vi.mock('../store/executor/pg-driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/executor/pg-driver')>()
  return {
    ...actual,
    createPgStoreDriver: (options: PgDriverOptions) => {
      const driver = actual.createPgStoreDriver(options)
      if (options.poolSize === 1) worker.onOpen?.(driver)
      return driver
    },
  }
})

const NOW = Date.parse('2026-11-25T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
/** Issues in the tree, the root included. */
const SIZE = 120
/** Every this many issues has an archived agent. */
const ARCHIVED_EVERY = 4
/** A second, smaller tree: the statement pin compares the two. */
const SMALL = 30

type Line = Record<string, unknown> & { type: string }
type Change = { entity: string; entityId: string; value: Record<string, unknown> }

let dir: string
let location: string
let store: SessionStore
let owner: UserId
/** The big tree's first issues: their index decides who has an archived agent. */
const issueIds: string[] = []
/** Every issue under the big tree's root now. */
const treeIds: string[] = []

function sessionRow(id: string, issueId: string, machineId: SessionRow['machineId']): SessionRow {
  return {
    id: asSessionId(id),
    ownerUserId: owner,
    agentKind: 'codex',
    cwd: '/workspace',
    title: id,
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: null,
    resumeValue: null,
    status: 'exited',
    exitCode: 0,
    spawnFailure: null,
    durableLabel: `podium-${id}`,
    createdAt: ago(100),
    lastActiveAt: ago(50),
    geometry: { cols: 120, rows: 40 },
    archived: true,
    workState: null,
    machineId,
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    spawnedBy: 'user',
    headless: false,
    issueId: issueId as IssueId,
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
  }
}

/** A root and ten groups under it; the rest under the groups. */
const bigParent = (at: number) => (at === 0 ? null : at <= 10 ? 'iss_h0' : `iss_h${1 + (at % 10)}`)

const issueRow = (id: string, at: number, parentId: string | null, title = `Held ${at}`) =>
  issueRowFixture({
    id,
    seq: at + 1,
    title,
    ownerUserId: owner,
    createdByActor: owner,
    createdByOnBehalfOf: owner,
    archived: false,
    closedReason: null,
    parentId,
    updatedAt: ago(10),
  })

/** The issues' changes in the feed, as the capture would append them. */
async function logIssues(ids: readonly string[]): Promise<number> {
  const seqs = await store.sync.appendChanges(
    ids.map((id) => ({ entity: 'issueProjection', entityId: id, op: 'upsert', payload: '{}' })),
    NOW,
  )
  return seqs.at(-1)!
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pod-7609-held-'))
  const path = join(dir, 'podium.db')
  store = await openTestStore(path)
  location = await testStoreLocation(path)
  owner = await firstAdminMemberId(store)
  const machine = asMachineId(store.hostMachine!.id)
  for (let at = 0; at < SIZE; at += 1) {
    const id = `iss_h${at}`
    issueIds.push(id)
    await store.issues.upsertIssue(fixtureWriteScope(), issueRow(id, at, bigParent(at)))
    if (at % ARCHIVED_EVERY === 0)
      await store.sessions.upsertSession(fixtureWriteScope(), sessionRow(`ses_h${at}`, id, machine))
  }
  treeIds.push(...issueIds)
  const small: string[] = []
  for (let at = 0; at < SMALL; at += 1) {
    const id = `iss_s${at}`
    small.push(id)
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      issueRow(id, 500 + at, at === 0 ? null : 'iss_s0'),
    )
    if (at % ARCHIVED_EVERY === 0)
      await store.sessions.upsertSession(fixtureWriteScope(), sessionRow(`ses_s${at}`, id, machine))
  }
  // Outside every tree: an issue with two sub-issues, moved under the root later.
  await store.issues.upsertIssue(fixtureWriteScope(), issueRow('iss_out', 900, null))
  for (const [at, id] of [
    [901, 'iss_out_a'],
    [902, 'iss_out_b'],
  ] as const)
    await store.issues.upsertIssue(fixtureWriteScope(), issueRow(id, at, 'iss_out'))
  await logIssues([...issueIds, ...small, 'iss_out', 'iss_out_a', 'iss_out_b'])
}, 300_000)

afterAll(async () => {
  await store?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const job = (instances: CollectionInstance[]): SyncJob => ({
  workspaceId: store.workspaceId,
  transferId: randomUUID(),
  principal: { ...DEVICE_GRADE_PRINCIPAL, user: owner } as Principal,
  feedId: 'feed',
  epoch: 'epoch',
  encoding: 'identity',
  deadlineMs: Date.now() + 120_000,
  mode: 'collections',
  instances,
})

async function linesOf(instances: CollectionInstance[]): Promise<Line[]> {
  const chunks: Uint8Array[] = []
  for await (const bytes of produceBootstrap(
    location,
    job(instances),
    new AbortController().signal,
    () => {},
    undefined,
    { now: () => NOW },
  ))
    chunks.push(bytes)
  return Buffer.concat(chunks)
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Line)
}

/** The statements one answer runs on the worker's read handle. */
async function statementsOf(instances: CollectionInstance[]): Promise<number> {
  const driven: string[] = []
  const prepared: string[] = []
  const detachers: (() => void)[] = []
  worker.onOpen = (db) => {
    detachers.push(probeStatements({ db: db as object }, (seen) => driven.push(seen.sql)))
    const handle = db as Partial<SqlDatabase>
    if (typeof handle.prepare !== 'function') return
    const prepare = handle.prepare.bind(handle)
    handle.prepare = (sql: string) => {
      prepared.push(sql)
      return prepare(sql)
    }
  }
  try {
    await linesOf(instances)
  } finally {
    worker.onOpen = undefined
    for (const detach of detachers) detach()
  }
  const viaDriver = new Set(driven)
  return [...driven, ...prepared.filter((sql) => !viaDriver.has(sql))].map(queryKey).length
}

const changesOf = (lines: readonly Line[]): Change[] =>
  lines.filter((line) => line.type === 'feedBootstrap').flatMap((line) => line.changes as Change[])

const markersOf = (lines: readonly Line[]) =>
  lines
    .filter((line) => line.type === 'collectionComplete')
    .flatMap((line) => line.instances as Record<string, unknown>[])

const sent = (lines: readonly Line[], entity: string) =>
  changesOf(lines)
    .filter((change) => change.entity === entity)
    .map((change) => change.entityId)
    .sort()

const ARCHIVE = {
  collection: 'issueProjection.treeArchive',
  args: { root: 'iss_h0' },
  part: 'main',
} as const satisfies CollectionInstance
const held = (seq: number): CollectionInstance => ({
  ...ARCHIVE,
  rowsHeld: { collection: 'issueProjection.tree', seq },
})
const archivedSessions = () =>
  issueIds.flatMap((_, at) => (at % ARCHIVED_EVERY === 0 ? [`ses_h${at}`] : [])).sort()

describe(`an archive asked with its held tree (${testStoreEngine()})`, () => {
  it('sends no issue unchanged since the held rows, and still every archived session', async () => {
    const head = (await store.sync.readFeedState()).headSeq
    const whole = await linesOf([ARCHIVE])
    const lines = await linesOf([held(head)])
    // Before: every issue of the tree, again.
    expect(sent(whole, 'issueProjection')).toEqual([...treeIds].sort())
    // After: none of them, and the same archived sessions.
    expect(sent(lines, 'issueProjection')).toEqual([])
    expect(sent(lines, 'session')).toEqual(archivedSessions())
    expect(sent(whole, 'session')).toEqual(archivedSessions())
    const markers = markersOf(lines)
    // Each issue's archived sessions are marked, and the archive itself last.
    for (const id of issueIds)
      expect(markers).toContainEqual({
        collection: 'session.ofIssue',
        args: { issueId: id },
        part: 'main',
        via: 'issueProjection.treeArchive',
      })
    const own = markers.findIndex(
      (marker) => marker.collection === ARCHIVE.collection && marker.via === undefined,
    )
    // It says the held rows are among its members.
    expect(markers[own]).toEqual({ ...ARCHIVE, rowsHeld: true })
    const archived = markers.flatMap((marker, at) =>
      marker.via === 'issueProjection.treeArchive' ? [at] : [],
    )
    expect(Math.max(...archived)).toBeLessThan(own)
    // What every issue comes with as a record arrived with the tree: not asked again.
    expect(markers.filter((marker) => marker.via === 'issueProjection')).toEqual([])
    console.log(
      `ROWS-HELD ${testStoreEngine()} size=${SIZE} without: issues=${sent(whole, 'issueProjection').length} lines=${whole.length}; with: issues=${sent(lines, 'issueProjection').length} lines=${lines.length}`,
    )
  })

  it('sends a member changed after the held rows, with what it comes with', async () => {
    const before = (await store.sync.readFeedState()).headSeq
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      issueRow('iss_h37', 37, bigParent(37), 'Renamed'),
    )
    await logIssues(['iss_h37'])
    const lines = await linesOf([held(before)])
    expect(sent(lines, 'issueProjection')).toEqual(['iss_h37'])
    expect(changesOf(lines).find((change) => change.entityId === 'iss_h37')?.value).toMatchObject({
      title: 'Renamed',
    })
    expect(sent(lines, 'session')).toEqual(archivedSessions())
    // The changed issue's own comes-with is answered again (its read state,
    // git state, dependencies and its parent); no other issue's.
    const named = new Set(
      markersOf(lines)
        .filter((marker) => marker.via === 'issueProjection')
        .flatMap((marker) => Object.values(marker.args as object)),
    )
    expect(named.has('iss_h37')).toBe(true)
    expect([...named].filter((id) => id !== 'iss_h37' && id !== 'iss_h8')).toEqual([])
    // Held as of now: nothing again.
    const now = (await store.sync.readFeedState()).headSeq
    expect(sent(await linesOf([held(now)]), 'issueProjection')).toEqual([])
  })

  it('sends an issue moved under the tree with the sub-issues it brings', async () => {
    const before = (await store.sync.readFeedState()).headSeq
    // Only the moved issue changes; its sub-issues come along unchanged.
    await store.issues.upsertIssue(fixtureWriteScope(), issueRow('iss_out', 900, 'iss_h3'))
    await logIssues(['iss_out'])
    treeIds.push('iss_out', 'iss_out_a', 'iss_out_b')
    const lines = await linesOf([held(before)])
    expect(sent(lines, 'issueProjection')).toEqual(['iss_out', 'iss_out_a', 'iss_out_b'])
    expect(sent(await linesOf([ARCHIVE]), 'issueProjection')).toEqual([...treeIds].sort())
  })

  it('runs the same statements for a tree of 30 issues as for one of 120', async () => {
    const head = (await store.sync.readFeedState()).headSeq
    const small = await statementsOf([
      { ...held(head), args: { root: 'iss_s0' } } as CollectionInstance,
    ])
    const large = await statementsOf([held(head)])
    console.log(`ROWS-HELD ${testStoreEngine()} statements small=${small} large=${large}`)
    expect(large).toBe(small)
  })

  it('sends every member when the log no longer reaches back to the held rows', async () => {
    const { headSeq } = await store.sync.readFeedState()
    // Retention dropped every change but the newest.
    await store.sync.pruneChangeBatch(
      await store.sync.planChangePrune({ keepRows: 1, maxAgeMs: 60_000_000, now: NOW }),
      500,
    )
    const { floorSeq } = await store.sync.readFeedState()
    expect(floorSeq).toBeGreaterThan(1)
    const lines = await linesOf([held(floorSeq - 2)])
    expect(sent(lines, 'issueProjection')).toEqual([...treeIds].sort())
    // Every member sent: the marker claims no held rows.
    expect(
      markersOf(lines).find(
        (marker) => marker.collection === ARCHIVE.collection && marker.via === undefined,
      ),
    ).toEqual({ ...ARCHIVE })
    // A device ahead of the server's head names a feed the server cannot place.
    expect(sent(await linesOf([held(headSeq + 5)]), 'issueProjection')).toEqual([...treeIds].sort())
  })
})

describe('held rows name a collection with the same rule', () => {
  it('refuses another rule, a keyed instance, or a holder', () => {
    for (const instance of [
      { ...ARCHIVE, rowsHeld: { collection: 'issueProjection.sidebar', seq: 1 } },
      { ...ARCHIVE, rowsHeld: { collection: 'issueProjection.treeArchive', seq: 1 } },
      {
        collection: 'session.ofIssue',
        keys: ['iss_h1'],
        part: 'main',
        rowsHeld: { collection: 'session.ofIssue', seq: 1 },
      },
      {
        collection: 'session.ofIssue',
        args: { issueId: 'iss_h1' },
        via: 'issueProjection.treeArchive',
        part: 'main',
        rowsHeld: { collection: 'issueProjection.tree', seq: 1 },
      },
    ] as CollectionInstance[])
      expect(() => resolveInstance(instance), JSON.stringify(instance)).toThrow(
        CollectionRequestError,
      )
    expect(resolveInstance(held(1)).rowsHeld).toEqual({
      collection: 'issueProjection.tree',
      seq: 1,
    })
  })
})
