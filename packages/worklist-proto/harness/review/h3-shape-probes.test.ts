/**
 * POD-4598 (H3) — the shape reviewer's own probes of the hand pool, so the
 * review's claims can be re-run at any SHA.
 *
 * 1. BUCKET WORK ON REAL SHAPES (M3 §2.3 / §5.2, ported). Boot the lazy hand
 *    pool on the live-shaped fixture (1x, 4x) and, with `H3_LIVE_EXPORT` set,
 *    on the anonymised live export (POD-4552). Print the largest bucket per
 *    collection, then apply one new open issue into the largest `repo.issues`
 *    and one new session into the largest `issue.sessions` under the largest
 *    `worktree.sessions` root. For each insert: the pool's `indexUpdates`
 *    delta, the hand guard's counter over the whole apply (`elementOps`, a
 *    verbatim copy), and the identity check (containers replaced).
 * 2. DECLARED INPUTS ARE COMPLETE. The engine re-resolves a link only when
 *    one of its declared inputs moved (`relations.ts` `linkInputs`: the key
 *    field plus `where.fields`), and re-decides a collapse group only when a
 *    `collapse.fields` entry moved. Those lists sit in the shared schema next
 *    to the functions they describe, and nothing checks that the functions
 *    read only what the lists name (`validateStructure` checks each named
 *    field exists). This probe runs every `where.test` and every collapse
 *    function over every corpus row through a recording proxy and asserts
 *    the reads are covered. A planted schema whose `where.test` reads an
 *    undeclared field must be named.
 * 3. CELLS THAT OUTLIVE THEIR READERS (observation). A session's activity
 *    cell is disposed only when the session leaves the pool, so after its
 *    issue leaves, each change of the session still re-runs the cell and
 *    reads its row. And `snapshot()` creates a view cell per resident issue,
 *    kept current from then on whether or not a row is mounted.
 */

import { describe, expect, it } from 'vitest'
import { harnessHandPoolArm } from '../src/adapters/hand-pool'
import { HandPool } from '../../arms/hand/pool/pool'
import type { LocalsSource, RowSource } from '../../shared/src/arm'
import { createReadFence, DISABLED_READ_FENCE } from '../../shared/src/instrument/reads'
import { settableLocals } from '@podium/client-graph/shared/locals-source'
import {
  allRelations,
  type CollapseSpec,
  type EntityName,
  type ModelSchema,
  SCHEMA,
} from '@podium/client-graph/shared/schema'
import type { RowRecord } from '../../shared/src/stats'
import type { SliceWorktree } from '@podium/client-graph/shared/slice-types'
import { createReplaySource } from '../src/count-harness'
import { readSnapshot } from '../src/fixture/export-snapshot'
import { buildCorpus } from '../src/fixture/index'
import { elementOps, held, replaced, report } from './h3-witness'

type Row = Readonly<Record<string, unknown>>

// ------------------------------------------------------------------ feeds

function fixtureFeed(scale: 1 | 4): { source: RowSource; now: number } {
  const corpus = buildCorpus(scale)
  const replay = createReplaySource({
    issues: corpus.sliceIssues.map((value): RowRecord => ({ kind: 'issue', id: value.id, value })),
    sessions: corpus.sliceSessions.map(
      (value): RowRecord => ({ kind: 'session', id: value.sessionId, value }),
    ),
    worktrees: corpus.sliceWorktrees.map(
      (value): RowRecord => ({ kind: 'worktree', id: value.path, value }),
    ),
  })
  return { source: replay.source, now: corpus.fixedNow }
}

/** The live export composed as the feed composes it (M3's probe, `m3-shape-probes.test.tsx`). */
function liveFeed(file: string): { source: RowSource; now: number; label: string } {
  const snapshot = readSnapshot(file)
  const worktrees: RowRecord[] = []
  for (const repo of snapshot.repos as unknown as {
    path: string
    repoId?: string | null
    worktrees?: { path: string }[]
  }[]) {
    const repoName = repo.path.split('/').filter(Boolean).pop() ?? repo.path
    const stamp = { repoId: repo.repoId ?? null, repoPath: repo.path, repoName }
    worktrees.push({
      kind: 'worktree',
      id: repo.path,
      value: { path: repo.path, ...stamp } as SliceWorktree,
    })
    for (const wt of repo.worktrees ?? []) {
      worktrees.push({
        kind: 'worktree',
        id: wt.path,
        value: { path: wt.path, ...stamp } as SliceWorktree,
      })
    }
  }
  for (const row of snapshot.repoProjections) {
    worktrees.push({ kind: 'worktree', id: row.id, value: row as unknown as SliceWorktree })
  }
  const replay = createReplaySource({
    issues: (snapshot.issues as unknown as { id: string }[]).map(
      (value): RowRecord => ({ kind: 'issue', id: value.id, value: value as never }),
    ),
    sessions: (snapshot.sessions as unknown as { sessionId: string }[]).map(
      (value): RowRecord => ({ kind: 'session', id: value.sessionId, value: value as never }),
    ),
    worktrees,
  })
  return {
    source: replay.source,
    now: Date.parse(snapshot.exportedAt),
    label: `live ${snapshot.exportedAt}`,
  }
}

// ------------------------------------------------------- 1. bucket work

function largest(
  pool: HandPool,
  ids: readonly string[],
  from: EntityName,
  relation: string,
  keep: (id: string) => boolean = () => true,
): { key: string; size: number } {
  let best = { key: '', size: -1 }
  for (const id of ids) {
    if (!keep(id)) continue
    const size = pool.engine.size(from, id, relation)
    if (size > best.size) best = { key: id, size }
  }
  return best
}

function measure(label: string, source: RowSource, locals: LocalsSource): void {
  const handle = harnessHandPoolArm.create(source, locals, DISABLED_READ_FENCE, {
    schedule: () => () => {},
  })
  const pool = handle.pool
  try {
    const known: Record<EntityName, string[]> = {
      issue: source.snapshot('issue').map((r) => r.id),
      session: source.snapshot('session').map((r) => r.id),
      worktree: source.snapshot('worktree').map((r) => r.id),
      repo: [...pool.tables.repo.keys()],
    }
    const buckets: Record<string, { key: string; size: number }> = {}
    for (const { from, name, relation } of allRelations()) {
      if (relation.kind !== 'hasMany' && !(relation.kind === 'edge' && relation.direction === 'in'))
        continue
      buckets[`${from}.${name}`] = largest(pool, known[from], from, name)
    }
    const issueRows = new Map(
      source.snapshot('issue').map((r) => [r.id, r.value as unknown as Record<string, unknown>]),
    )
    const openRepo = largest(pool, known.repo, 'repo', 'issues')
    const template = [...issueRows.values()].find(
      (v) => v !== undefined && v['closedAt'] == null && v['repoId'] === openRepo.key,
    )
    if (template === undefined) throw new Error(`${label}: no open issue in repo ${openRepo.key}`)
    const hot = (id: string) => pool.tables.issue.has(id)
    const busyIssue = largest(pool, known.issue, 'issue', 'sessions', hot)
    const busyRoot = largest(pool, known.worktree, 'worktree', 'sessions')
    const sessionTemplate = source
      .snapshot('session')
      .map((r) => r.value as unknown as Record<string, unknown> | undefined)
      .find((v) => v !== undefined && v['headless'] !== true)
    if (sessionTemplate === undefined) throw new Error(`${label}: no session`)

    const insert = (record: RowRecord) => {
      const before = held(pool)
      const indexBefore = pool.stats.indexUpdates
      const ops = elementOps(() => pool.apply({ type: 'update', rows: [record] }))
      return {
        indexUpdates: pool.stats.indexUpdates - indexBefore,
        counterOps: ops,
        replaced: replaced(before, held(pool)),
      }
    }
    const newIssue = insert({
      kind: 'issue',
      id: 'iss_h3_probe',
      value: { ...template, id: 'iss_h3_probe', seq: 999_999, parentId: null, deps: [] } as never,
    })
    const newSession = insert({
      kind: 'session',
      id: 'ses_h3_probe',
      value: {
        ...sessionTemplate,
        sessionId: 'ses_h3_probe',
        issueId: busyIssue.key,
        cwd: `${busyRoot.key.replace(/\/$/, '')}/h3-probe`,
        resume: null,
      } as never,
    })
    report(
      `[h3-bucket] ${label}: issues=${known.issue.length} sessions=${known.session.length} ` +
        `lanes=${known.worktree.length} repos=${known.repo.length}\n` +
        `  largest buckets: ${JSON.stringify(buckets)}\n` +
        `  targets: repo.issues ${JSON.stringify(openRepo)}, resident issue.sessions ${JSON.stringify(busyIssue)}, worktree.sessions ${JSON.stringify(busyRoot)}\n` +
        `  new issue:   ${JSON.stringify(newIssue)}\n` +
        `  new session: ${JSON.stringify(newSession)}`,
    )
    expect(newIssue.replaced.elements).toBe(0)
    expect(newSession.replaced.elements).toBe(0)
  } finally {
    handle.dispose()
  }
}

describe('H3 probe: bucket work per membership change on real shapes', () => {
  for (const scale of [1, 4] as const) {
    it(`live-shaped fixture ${scale}x`, () => {
      const feed = fixtureFeed(scale)
      const locals = settableLocals({ selectedIssueId: null, coarseNow: feed.now })
      measure(`fixture ${scale}x`, feed.source, locals.source)
    }, 300_000)
  }
  const live = process.env['H3_LIVE_EXPORT']
  it.skipIf(live === undefined)(
    'live export (POD-4552)',
    () => {
      const feed = liveFeed(live as string)
      const locals = settableLocals({ selectedIssueId: null, coarseNow: feed.now })
      measure(feed.label, feed.source, locals.source)
    },
    300_000,
  )
})

// ------------------------------------------------ 2. declared inputs

/** The top-level fields `fn` reads from each row, beyond `declared`. */
function undeclaredReads(
  declared: readonly string[],
  rows: readonly Row[],
  fn: (row: Row) => unknown,
): string[] {
  const extra = new Set<string>()
  const allowed = new Set(declared)
  for (const row of rows) {
    const proxy = new Proxy(row, {
      get(target, key, receiver) {
        if (typeof key === 'string' && !allowed.has(key)) extra.add(key)
        return Reflect.get(target, key, receiver)
      },
    })
    fn(proxy)
  }
  return [...extra].sort()
}

/** Every declared resolver's undeclared reads over `rowsOf(entity)`, as `where: fields` lines. */
function inventoryGaps(schema: ModelSchema, rowsOf: (entity: EntityName) => Row[]): string[] {
  const out: string[] = []
  for (const { from, name, relation } of allRelations(schema)) {
    const where = (relation as { where?: { fields: readonly string[]; test: (r: Row) => boolean } })
      .where
    if (where === undefined) continue
    const extra = undeclaredReads(where.fields, rowsOf(from), (row) => where.test(row))
    if (extra.length > 0) out.push(`${from}.${name}.where reads ${extra.join(', ')}`)
  }
  for (const entity of Object.keys(schema) as EntityName[]) {
    const rule: CollapseSpec | undefined = schema[entity].collapse
    if (rule === undefined) continue
    const fns: [string, (row: Row) => unknown][] = [
      ['groupKey', (row) => rule.groupKey(row)],
      ['keepsGroup', (row) => rule.keepsGroup(row)],
      ['rank', (row) => rule.rank(row)],
      ['recency', (row) => row[rule.recency]],
    ]
    for (const [label, fn] of fns) {
      const extra = undeclaredReads(rule.fields, rowsOf(entity), fn)
      if (extra.length > 0) out.push(`${entity}.collapse.${label} reads ${extra.join(', ')}`)
    }
  }
  return out
}

function corpusRows(): (entity: EntityName) => Row[] {
  const corpus = buildCorpus(1)
  const rows: Record<EntityName, Row[]> = {
    issue: corpus.sliceIssues as unknown as Row[],
    session: corpus.sliceSessions as unknown as Row[],
    worktree: corpus.sliceWorktrees as unknown as Row[],
    repo: corpus.sliceWorktrees as unknown as Row[],
  }
  const live = process.env['H3_LIVE_EXPORT']
  if (live !== undefined) {
    const snapshot = readSnapshot(live)
    rows.issue = [...rows.issue, ...(snapshot.issues as unknown as Row[])]
    rows.session = [...rows.session, ...(snapshot.sessions as unknown as Row[])]
  }
  return (entity) => rows[entity]
}

describe('H3 probe: the schema declares every field its resolvers read', () => {
  it('every where.test and collapse function reads only its declared fields', () => {
    const gaps = inventoryGaps(SCHEMA, corpusRows())
    report(`[h3-inputs] gaps on the corpus: ${JSON.stringify(gaps)}`)
    expect(gaps).toEqual([])
  })

  it('a where.test that reads an undeclared field is named (the probe is armed)', () => {
    const issueRelation = SCHEMA.session.relations['issue'] as {
      where: { fields: readonly string[]; test: (r: Row) => boolean; why: string }
    }
    const planted = {
      ...SCHEMA,
      session: {
        ...SCHEMA.session,
        relations: {
          ...SCHEMA.session.relations,
          issue: {
            ...issueRelation,
            where: {
              ...issueRelation.where,
              test: (row: Row) => row['headless'] !== true && row['status'] !== 'deleted',
            },
          },
        },
      },
    } as unknown as ModelSchema
    const gaps = inventoryGaps(planted, corpusRows())
    report(`[h3-inputs] planted gaps: ${JSON.stringify(gaps)}`)
    expect(gaps).toContain('session.issue.where reads status')
  })
})

// ---------------------------------------- 3. cells that outlive readers

describe('H3 probe: cells that outlive their readers (observation, not a check)', () => {
  const T0 = '2026-09-23T00:00:00.000Z'
  const issue = (id: string): RowRecord => ({
    kind: 'issue',
    id,
    value: {
      id,
      seq: 1,
      title: `Issue ${id}`,
      stage: 'in_progress',
      createdAt: T0,
      updatedAt: T0,
      repoId: 'R',
      repoPath: '/repo',
      parentId: null,
      worktreePath: null,
      deps: [],
      audience: 'human',
    } as RowRecord['value'],
  })
  const session = (lastActiveAt: string): RowRecord => ({
    kind: 'session',
    id: 'S',
    value: {
      sessionId: 'S',
      issueId: 'I',
      cwd: '/elsewhere',
      status: 'live',
      lastActiveAt,
      agentKind: 'claude-code',
    } as RowRecord['value'],
  })

  function heartbeatAfterIssueLeft(readView: boolean) {
    const replay = createReplaySource({
      issues: [issue('I')],
      sessions: [session(T0)],
      worktrees: [],
    })
    const locals = settableLocals({ selectedIssueId: null, coarseNow: Date.parse(T0) })
    const reads = createReadFence({ enabled: true })
    const pool = new HandPool(reads, locals.source.get())
    const source = reads.wrapSource(replay.source)
    pool.apply({
      type: 'replace',
      rows: [...source.snapshot('session'), ...source.snapshot('issue')],
    })
    const off = source.subscribe((event) => pool.apply(event))
    try {
      if (readView) expect(pool.view('I')?.activityAt).toBe(Date.parse(T0))
      replay.push({ type: 'update', rows: [{ kind: 'issue', id: 'I', value: undefined }] })
      const runs = pool.stats.counters.cellRuns
      reads.reset()
      replay.push({ type: 'update', rows: [session('2026-09-23T01:00:00.000Z')] })
      return {
        viewRead: readView,
        sessionCells: pool.sessionCells.size,
        cellRuns: pool.stats.counters.cellRuns - runs,
        rowsRead: reads.stats().rows,
      }
    } finally {
      off()
      pool.dispose()
      locals.dispose()
    }
  }

  it('a session heartbeat after its issue left', () => {
    const control = heartbeatAfterIssueLeft(false)
    const orphan = heartbeatAfterIssueLeft(true)
    report(`[h3-orphan] control ${JSON.stringify(control)} orphan ${JSON.stringify(orphan)}`)
    expect(control.cellRuns).toBe(0)
  })

  it('snapshot() leaves a view cell per resident issue', () => {
    const feed = fixtureFeed(1)
    const locals = settableLocals({ selectedIssueId: null, coarseNow: feed.now })
    const handle = harnessHandPoolArm.create(feed.source, locals.source, DISABLED_READ_FENCE, {
      schedule: () => () => {},
    })
    try {
      const before = handle.pool.issues.size
      handle.snapshot()
      report(
        `[h3-cells] issue cell sets before snapshot ${before}, after ${handle.pool.issues.size}, resident issues ${handle.pool.tables.issue.size}`,
      )
      expect(handle.pool.issues.size).toBeGreaterThan(before)
    } finally {
      handle.dispose()
    }
  }, 120_000)
})
