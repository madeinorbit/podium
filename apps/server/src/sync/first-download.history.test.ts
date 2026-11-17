/**
 * THE POLICY SET LOADS WITHOUT READING HISTORY (POD-7085 acceptance 5,
 * docs/agents/server-data.md rules 3 and 8).
 *
 * The startup corpus (`buildCorpusCell`, POD-4747) at history x1 (`h1a1`) and
 * x10 (`h10a1`): the same active work under ten times the closed, archived and
 * deleted history. Both are written to a file store and answered by the sync
 * worker's producer as the browser's first download, without its last step,
 * the issue stubs (which cover all history by design).
 *
 *  - Statement counts: the same at x1 and x10 (pinned), and the answer holds
 *    the same records at both sizes, so the reads follow the policy set and
 *    not the history.
 *  - Query plans: every statement of the policy set and of what it comes with
 *    seeks an index, except the declared exceptions listed with their reason.
 *  - The stubs step is measured beside it: it grows with history, by design.
 *
 * The numbers it prints are recorded in docs/measurements/collection-fetch-history.md.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  asIssueId,
  asSessionId,
  asUserId,
  COLLECTIONS,
  firstAdminMemberId,
  paramsRead,
  RECORDS,
} from '@podium/model'
import type { CollectionInstance, Principal } from '@podium/protocol'
import { queryKey } from '@podium/runtime/query-attribution'
import type { OpenOptions, SqlDatabase } from '@podium/runtime/sqlite'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../store'
import { probeStatements } from '../store/executor/statement-probe'
import { produceBootstrap } from '../sync-worker/producer'
import type { SyncJob } from '../sync-worker/types'
import { type CorpusIssue, foldedDeps, prefixOf, rowOf } from '../test-support/issue-corpus'
import { openTestStore } from '../test-support/open-test-store'
import type { CorpusSession } from '../test-support/session-corpus'
import {
  measureAtSizes,
  type StatementPin,
  tallyOf,
} from '../test-support/statement-count'
import { resolveRule, ruleStatement } from './collection-shapes'
import { ancestorsStatement } from './collection-sql'
import { firstDownload, policyFor } from './policy'

/** Every read-only handle opened while a worker job is being counted. */
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

interface Corpus {
  issues: (CorpusIssue & { updatedAt: string })[]
  deps: { fromId: string; toId: string; type: string }[]
  sessions: CorpusSession[]
  repos: string[]
}

async function corpusOf(cell: string): Promise<Corpus> {
  const module = fileURLToPath(
    new URL('../../../../scripts/server-data-bench/corpus-export.ts', import.meta.url),
  )
  const { exportCorpus } = (await import(module)) as {
    exportCorpus(cell: string, seed: number): Promise<Corpus>
  }
  return await exportCorpus(cell, 4443)
}

interface World {
  readonly dir: string
  readonly path: string
  readonly store: SessionStore
  readonly owner: Principal
  /** The corpus's clock: its newest change. */
  readonly now: number
}

const worlds = new Map<number, World>()

/** The corpus cell at history x`history`, on a file store the worker can open. */
async function world(history: number): Promise<World> {
  const known = worlds.get(history)
  if (known) return known
  const corpus = await corpusOf(`h${history}a1`)
  const dir = mkdtempSync(join(tmpdir(), `pod-7085-h${history}-`))
  const path = join(dir, 'podium.db')
  const store = await openTestStore(path)
  await store.transact(async () => {
    for (const [index, repo] of corpus.repos.entries())
      await store.repos.addRepo(repo, store.hostMachineId, undefined, prefixOf(index))
  })
  for (let start = 0; start < corpus.issues.length; start += 500) {
    await store.transact(async () => {
      for (const issue of corpus.issues.slice(start, start + 500))
        await store.issues.upsertIssue(
          fixtureWriteScope(),
          rowOf(
            { ...issue, parentId: null },
            issue.repoPath ?? corpus.repos[0]!,
            store.hostMachineId,
          ),
        )
    })
  }
  const ids = new Set(corpus.issues.map((issue) => issue.id))
  await store.transact(async () => {
    for (const issue of corpus.issues) {
      if (!issue.parentId || !ids.has(issue.parentId)) continue
      const row = (await store.issues.getIssue(asIssueId(issue.id)))!
      row.parentId = asIssueId(issue.parentId)
      await store.issues.upsertIssue(fixtureWriteScope(), row)
    }
  })
  await store.transact(async () => {
    // Older dependency spellings folded as the fixed-types migration folds them.
    for (const dep of foldedDeps(corpus.deps, ids))
      await store.issues.addIssueDep(asIssueId(dep.fromId), asIssueId(dep.toId), dep.type)
  })
  const admin = await firstAdminMemberId(store)
  for (let start = 0; start < corpus.sessions.length; start += 500) {
    await store.transact(async () => {
      for (const s of corpus.sessions.slice(start, start + 500)) {
        await store.sessions.upsertSession(fixtureWriteScope(), {
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
          exitCode: null,
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
          issueId: s.issueId !== null && ids.has(s.issueId) ? asIssueId(s.issueId) : null,
          stoppedAt: s.stoppedAt,
        } as never)
      }
    })
  }
  // The planner's statistics, as the store keeps them current (rule 3).
  ;(store as unknown as { db: SqlDatabase }).db.exec('ANALYZE')
  const now = Math.max(
    ...corpus.issues.map((issue) => Date.parse(issue.updatedAt)),
    ...corpus.sessions.map((session) => Date.parse(session.lastActiveAt)),
  )
  const made: World = {
    dir,
    path,
    store,
    owner: { ...DEVICE_GRADE_PRINCIPAL, user: asUserId(admin) } as Principal,
    now,
  }
  worlds.set(history, made)
  return made
}

afterAll(async () => {
  for (const w of worlds.values()) {
    await w.store.close()
    rmSync(w.dir, { recursive: true, force: true })
  }
})

/** Every statement the worker's own connection runs, as `sync-feed.statement-count.test.ts` counts it. */
async function countWorker(run: () => unknown) {
  const driven: string[] = []
  const prepared: string[] = []
  const detachers: (() => void)[] = []
  worker.onOpen = (db) => {
    detachers.push(
      probeStatements({ db: db as object }, (observation) => driven.push(observation.sql)),
    )
    const handle = db as SqlDatabase
    const prepare = handle.prepare.bind(handle)
    handle.prepare = (sql: string) => {
      prepared.push(sql)
      return prepare(sql)
    }
  }
  let result: unknown
  try {
    result = await run()
  } finally {
    worker.onOpen = undefined
    for (const detach of detachers) detach()
  }
  const viaDriver = new Set(driven)
  const raw = prepared.filter((sql) => !viaDriver.has(sql))
  return { result, ...tallyOf([...driven, ...raw].map(queryKey)) }
}

type Line = { type: string; changes?: { entity: string; entityId: string; part?: string }[] }

async function answer(w: World, instances: CollectionInstance[]): Promise<Line[]> {
  const job = {
    mode: 'collections',
    transferId: 'history',
    principal: w.owner,
    feedId: 'feed',
    epoch: 'epoch',
    encoding: 'identity',
    deadlineMs: Date.now() + 600_000,
    instances,
  } as SyncJob
  let text = ''
  for await (const chunk of produceBootstrap(
    w.path,
    job,
    new AbortController().signal,
    () => {},
    undefined,
    {
      now: () => w.now,
    },
  ))
    text += new TextDecoder().decode(chunk)
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Line)
}

const records = (lines: Line[]) =>
  lines.flatMap((line) =>
    line.type === 'feedBootstrap' || line.type === 'feedStubs' ? (line.changes ?? []) : [],
  )

/** The browser's first download without the issue stubs. */
const POLICY_SET = firstDownload(policyFor('browser'), []).filter(
  (instance) => instance.collection !== 'issueProjection.stubs',
)

/**
 * Statements that read rows beyond the policy set, and why each is accepted.
 * Nothing else may scan a table that grows with history.
 */
const SCANS_ACCEPTED: ReadonlyMap<string, string> = new Map([
  [
    'session.asking',
    'reads every session: its rule reads the agent state through the runtime and checkpoint satellites, which no index serves (finding for the coordinator)',
  ],
])

/** A plan step that reads a whole table or index; the recursive walk's own queue excepted. */
const HISTORY_TABLES = /^SCAN (?!walk\b|up\b|\()/

describe('the policy set loads without reading history (acceptance 5)', () => {
  const pin: StatementPin<World> = {
    name: 'browser first download without stubs, history x1 against x10',
    sizes: [1, 10],
    setup: async (history) => await world(history),
    target: (w) => w.store as never,
    count: async (_w, go) => await countWorker(go),
    run: async (w) => await answer(w, POLICY_SET),
    check: (result) => {
      const lines = result as Line[]
      expect(records(lines).length).toBeGreaterThan(100)
      expect(lines.at(-1)).toMatchObject({ type: 'syncComplete' })
    },
  }

  it('holds the same records at history x1 and x10', async () => {
    const small = records(await answer(await world(1), POLICY_SET))
    const large = records(await answer(await world(10), POLICY_SET))
    const byKind = (rows: typeof small) =>
      Object.fromEntries(
        [...new Set(rows.map((r) => r.entity))]
          .sort()
          .map((kind) => [kind, rows.filter((r) => r.entity === kind).length]),
      )
    console.log(
      'policy set records, x1:',
      JSON.stringify(byKind(small)),
      'x10:',
      JSON.stringify(byKind(large)),
    )
    expect(byKind(large)).toEqual(byKind(small))
  }, 600_000)

  it('runs the same statements at history x1 and x10', async () => {
    const counts = await measureAtSizes(pin)
    console.log('policy set statements, x1:', counts.small.statements, 'x10:', counts.large.statements)
    expect(counts.small.statements).toBeGreaterThan(20)
    expect(counts.large.statements, 'the same statements at history x1 and x10').toBe(
      counts.small.statements,
    )
  }, 600_000)

  it('seeks an index for every statement of the policy set and of what it comes with', async () => {
    const w = await world(10)
    const db = (w.store as unknown as { db: SqlDatabase }).db
    const plans: string[] = []
    const check = (name: string, sql: string, params: readonly unknown[]) => {
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as {
        detail: string
      }[]
      const detail = rows.map((row) => row.detail)
      plans.push(`${name}\n  ${detail.join('\n  ')}`)
      // Scanning a subquery's own rows (a co-routine) reads no table.
      const coroutines = new Set(detail.flatMap((line) => /^CO-ROUTINE (\S+)/.exec(line)?.[1] ?? []))
      const scans = detail.filter(
        (line) => HISTORY_TABLES.test(line) && !coroutines.has(line.split(' ')[1] ?? ''),
      )
      if (SCANS_ACCEPTED.has(name)) return
      expect(scans, `${name}: ${detail.join(' | ')}`).toEqual([])
    }
    for (const instance of POLICY_SET) {
      const collection = COLLECTIONS.get(instance.collection)!
      if (collection.where === undefined) continue
      const rule = resolveRule(collection.id)
      const statement = ruleStatement(rule, 'ids', { recentDays: 30 }, w.now)
      check(collection.id, statement.sql, statement.params)
      for (const entry of collection.comesWith ?? []) {
        const keyed = resolveRule(entry.collection, collection.id)
        const args = { [keyed.params[0]!]: ['x', 'y'] }
        const s = ruleStatement(keyed, 'keyed', args, w.now)
        check(`${collection.id} > ${entry.collection}`, s.sql, s.params)
      }
    }
    for (const record of RECORDS) {
      for (const entry of record.comesWith) {
        const keyed = resolveRule(entry.collection, record.kind)
        if (keyed.where === undefined || paramsRead(keyed.where).length === 0) continue
        const args = { [keyed.params[0]!]: ['x', 'y'] }
        const s = ruleStatement(keyed, 'keyed', args, w.now)
        check(`${record.kind} > ${entry.collection}`, s.sql, s.params)
      }
    }
    const walk = ancestorsStatement(['x', 'y'])
    check('issue ancestors', walk.sql, walk.params)
    console.log(`query plans at history x10:\n${plans.join('\n')}`)
  }, 600_000)

  it('measures the stubs step, which grows with history by design', async () => {
    const stubs: CollectionInstance[] = [{ collection: 'issueProjection.stubs' }]
    const at = async (history: number) => {
      const w = await world(history)
      const counted = await countWorker(async () => await answer(w, stubs))
      return { statements: counted.statements, stubs: records(counted.result as Line[]).length }
    }
    const small = await at(1)
    const large = await at(10)
    console.log('stubs step x1:', JSON.stringify(small), 'x10:', JSON.stringify(large))
    expect(large.stubs).toBeGreaterThan(small.stubs)
  }, 600_000)
})
