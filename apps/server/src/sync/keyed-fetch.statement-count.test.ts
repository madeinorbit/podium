/**
 * POD-7602 — many keys of a per-row collection cost a fixed number of
 * statements.
 *
 * A screen that reads each row's sessions or dependencies used to ask one
 * narrow instance per row (`session.ofIssue{issueId}`), in fetches of at most
 * 200 instances, and the server answered each with its own statements (about
 * two dozen per instance on SQLite). The loader now packs them into one keyed
 * instance (`session.ofIssue` with `keys`), which the server answers with a
 * fixed set of statements per chunk of records it builds (`BUILD_CHUNK`).
 *
 * This file pins that on both engines and measures it: at 200 and at 2,000
 * keys it runs the narrow fetches and the keyed one over the same records and
 * logs each run's statements and wall time (`KEYED-FETCH` lines).
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
import { BUILD_CHUNK } from './collection-fetch'

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

const SIZES = [200, 2000] as const
/** The narrow instances one fetch carried before packing (the route's bound). */
const NARROW_PER_FETCH = 200
const NOW = Date.parse('2026-11-25T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

let dir: string
let location: string
let store: SessionStore
let owner: UserId
const issueIds: string[] = []

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
    archived: false,
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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pod-7602-keyed-'))
  const path = join(dir, 'podium.db')
  store = await openTestStore(path)
  location = await testStoreLocation(path)
  owner = await firstAdminMemberId(store)
  const machine = asMachineId(store.hostMachine!.id)
  const largest = Math.max(...SIZES)
  // Each issue has one session and depends on the issue before it.
  for (let at = 0; at < largest; at += 1) {
    const id = `iss_k${at}`
    issueIds.push(id)
    await store.issues.upsertIssue(
      fixtureWriteScope(),
      issueRowFixture({
        id,
        seq: at + 1,
        title: `Keyed ${at}`,
        ownerUserId: owner,
        createdByActor: owner,
        createdByOnBehalfOf: owner,
        archived: false,
        closedReason: null,
        parentId: null,
        updatedAt: ago(10),
      }),
    )
    await store.sessions.upsertSession(fixtureWriteScope(), sessionRow(`ses_k${at}`, id, machine))
    if (at > 0) await store.issues.addIssueDep(id as IssueId, `iss_k${at - 1}` as IssueId)
  }
}, 600_000)

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
  deadlineMs: Date.now() + 600_000,
  mode: 'collections',
  instances,
})

interface Run {
  statements: number
  ms: number
  /** The distinct records sent, by kind, id and part. */
  records: number
  /** Markers of the asked collection (an answer marks what its records come with too). */
  markers: number
}

/** Run each fetch through the worker and count what it runs on the handle it opens. */
async function run(collection: string, fetches: CollectionInstance[][]): Promise<Run> {
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
  const records = new Set<string>()
  let markers = 0
  const started = performance.now()
  try {
    for (const instances of fetches) {
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
      for (const text of Buffer.concat(chunks).toString().trim().split('\n')) {
        const line = JSON.parse(text) as {
          type: string
          changes?: { entity: string; entityId: string; part?: string }[]
          instances?: { collection?: string }[]
        }
        if (line.type === 'feedBootstrap' || line.type === 'feedStubs')
          for (const change of line.changes ?? [])
            records.add(`${change.entity}:${change.entityId}:${change.part ?? ''}`)
        if (line.type === 'collectionComplete')
          markers += (line.instances ?? []).filter((i) => i.collection === collection).length
      }
    }
  } finally {
    worker.onOpen = undefined
    for (const detach of detachers) detach()
  }
  const ms = performance.now() - started
  const viaDriver = new Set(driven)
  const raw = prepared.filter((sql) => !viaDriver.has(sql))
  return {
    statements: [...driven, ...raw].map(queryKey).length,
    ms,
    records: records.size,
    markers,
  }
}

const COLLECTIONS = [
  { collection: 'session.ofIssue', param: 'issueId' },
  { collection: 'issueDep.toIssue', param: 'issueId' },
] as const

describe('many keys of a per-row collection cost a fixed number of statements (POD-7602)', () => {
  for (const { collection, param } of COLLECTIONS)
    it(`${collection}: one keyed fetch at 200 and 2,000 keys, against the narrow fetches`, async () => {
      const keyed: Run[] = []
      for (const size of SIZES) {
        const keys = issueIds.slice(0, size)
        const narrowInstances: CollectionInstance[] = keys.map((key) => ({
          collection,
          part: 'main',
          args: { [param]: key },
        }))
        const narrowFetches: CollectionInstance[][] = []
        for (let at = 0; at < narrowInstances.length; at += NARROW_PER_FETCH)
          narrowFetches.push(narrowInstances.slice(at, at + NARROW_PER_FETCH))
        const narrow = await run(collection, narrowFetches)
        const packed = await run(collection, [[{ collection, part: 'main', keys }]])
        console.log(
          `KEYED-FETCH engine=${testStoreEngine()} collection=${collection} keys=${size} ` +
            `narrow: fetches=${narrowFetches.length} statements=${narrow.statements} ms=${narrow.ms.toFixed(0)} ` +
            `keyed: fetches=1 statements=${packed.statements} ms=${packed.ms.toFixed(0)}`,
        )
        // The same answer: every record, and a marker per key.
        expect(packed.records).toBe(narrow.records)
        expect(packed.markers).toBe(size)
        expect(narrow.markers).toBe(size)
        expect(packed.statements).toBeLessThan(narrow.statements)
        keyed.push(packed)
      }
      // The keyed fetch's statements grow by chunk of records built, never by
      // key: 2,000 keys build in four chunks where 200 build in one.
      const [small, large] = keyed as [Run, Run]
      const chunksAt = (size: number) => Math.ceil(size / BUILD_CHUNK)
      expect(large.statements).toBeLessThanOrEqual(
        small.statements * (chunksAt(SIZES[1]) / chunksAt(SIZES[0])),
      )
      expect(large.statements).toBeLessThan(SIZES[1] / 10)
    }, 600_000)
})
