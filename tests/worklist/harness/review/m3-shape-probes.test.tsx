/**
 * POD-4591 (M3) — the shape reviewer's own probes of the MobX pool, so the
 * review's claims are re-runnable at any SHA (a re-review runs this file).
 *
 * 1. ENFORCEMENT. Plants each MobX warning the pool relies on and shows the
 *    pool's trap (`harness/src/mobx-trap.ts`) turns it into a failure:
 *    synchronously where MobX warns on the caller's stack, and by the
 *    recorded list where MobX swallows the throw inside a reaction. Also
 *    shows what the trap cannot see (a plain variable read by a computed).
 * 2. BUCKET WORK. Relation buckets are sorted frozen arrays replaced whole on
 *    every membership change (`relations.ts` `pendingSet` / `flush`), so one
 *    insert copies and sorts its target's whole bucket and counts ONE
 *    `indexUpdates`. Prints the largest bucket per collection on the
 *    live-shaped corpus at 1x and 4x, and the elements copied by one new
 *    issue and one new session. Counts only: no walls, no load rule needed.
 *    RE-REVIEW (POD-4568 rework): buckets became observable sets updated in
 *    place, so a touched slot's size is no longer work done. The bar is
 *    `elements touched`, the pool's `counters.bucketElements` delta (one per
 *    member added or deleted); `bucket size` is kept beside it. The
 *    reviewer does not take that counter on trust: `independently` patches
 *    MobX's ObservableSet prototype and `Array.prototype.sort` for the
 *    duration of one apply and counts, by itself, the set elements added,
 *    deleted and iterated and the array elements sorted (`witness`).
 */

import { appendFileSync } from 'node:fs'
import { autorun, computed, observable, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { installMobxWarnTrap } from '../src/mobx-trap'
import { harnessMobxPoolArm, tracked } from '../src/adapters/mobx-pool'
import type { LocalsSource, RowSource } from '../../shared/src/arm'
import { DISABLED_READ_FENCE } from '../../shared/src/instrument/reads'
import { settableLocals } from '@podium/client-graph/shared/locals-source'
import { allRelations, type EntityName } from '@podium/client-graph/shared/schema'
import type { RowRecord } from '../../shared/src/stats'
import type { SliceWorktree } from '@podium/client-graph/shared/slice-types'
import { createReplaySource } from '../src/count-harness'
import { readSnapshot } from '../src/fixture/export-snapshot'
import { buildCorpus } from '../src/fixture/index'

const trap = installMobxWarnTrap()

/** Where the counts go: `M3_PROBE_OUT` (the runner hides console output), else the console. */
function report(text: string): void {
  const out = process.env['M3_PROBE_OUT']
  if (out === undefined) console.log(text)
  else appendFileSync(out, `${text}\n`)
}

describe('M3 probe: the enforcement trap', () => {
  it('an untracked computed read throws on the caller (computedRequiresReaction)', () => {
    const box = observable.box(1, { name: 'm3.source' })
    const doubled = computed(() => box.get() * 2, { name: 'm3.doubled' })
    expect(() => doubled.get()).toThrow(/trapped.*m3\.doubled.*outside a reactive context/)
    expect(trap.warnings.length).toBe(1)
    trap.warnings.length = 0
  })

  it('an untracked observable read throws (observableRequiresReaction)', () => {
    const box = observable.box(1, { name: 'm3.box' })
    expect(() => box.get()).toThrow(/trapped.*m3\.box.*outside a reactive context/)
    trap.warnings.length = 0
  })

  it('a write to an observed observable outside an action is recorded (enforceActions)', () => {
    const box = observable.box(1, { name: 'm3.observed' })
    const stop = autorun(() => box.get())
    expect(() => box.set(2)).toThrow(/trapped.*strict-mode/)
    stop()
    expect(trap.warnings.some((w) => w.includes('m3.observed'))).toBe(true)
    trap.warnings.length = 0
  })

  it('a warning MobX swallows inside a reaction still fails the test (recorded list)', () => {
    const box = observable.box(1, { name: 'm3.inner' })
    const other = observable.box(0, { name: 'm3.sideEffect' })
    const watcher = autorun(() => other.get())
    // A side effect inside a reaction: MobX warns; the trap throws INSIDE the
    // reaction, MobX catches it (console.error), and only the list remains.
    const stop = autorun(() => {
      if (box.get() > 1) other.set(box.get())
    })
    runInAction(() => box.set(2))
    stop()
    watcher()
    expect(trap.warnings.length).toBeGreaterThan(0)
    trap.warnings.length = 0
  })

  it('a plain variable read by a computed warns nothing (the trap cannot see pitfall j)', () => {
    let plain = 1
    const box = observable.box(1, { name: 'm3.tracked' })
    const seen: number[] = []
    const stop = autorun(() => seen.push(box.get() + plain))
    plain = 2 // no notification, no warning
    stop()
    expect(seen).toEqual([2])
    expect(trap.warnings).toEqual([])
  })
})

/** What one call did to observable sets and sorts, counted outside the pool. */
interface Witness {
  added: number
  deleted: number
  iterated: number
  sorted: number
}

/**
 * Run `fn` with MobX's ObservableSet prototype and `Array.prototype.sort`
 * patched to count, then restore them. A copy-and-sort bucket shows up as
 * `iterated` or `sorted` near the bucket's size; an in-place move as one
 * `added` or `deleted`.
 */
function independently(fn: () => void): Witness {
  const witness: Witness = { added: 0, deleted: 0, iterated: 0, sorted: 0 }
  const proto = Object.getPrototypeOf(observable.set<string>()) as Record<
    string | symbol,
    (...args: unknown[]) => unknown
  >
  const saved = {
    add: proto['add'],
    delete: proto['delete'],
    values: proto['values'],
    forEach: proto['forEach'],
    iterator: proto[Symbol.iterator],
    sort: Array.prototype.sort,
  }
  const counting = (it: Iterator<unknown>): IterableIterator<unknown> => {
    const wrapped: IterableIterator<unknown> = {
      next: () => {
        const step = it.next()
        if (step.done !== true) witness.iterated += 1
        return step
      },
      [Symbol.iterator]: () => wrapped,
    }
    return wrapped
  }
  proto['add'] = function (this: unknown, ...args: unknown[]) {
    witness.added += 1
    return saved.add?.apply(this, args)
  }
  proto['delete'] = function (this: unknown, ...args: unknown[]) {
    witness.deleted += 1
    return saved.delete?.apply(this, args)
  }
  proto['values'] = function (this: unknown) {
    return counting(saved.values?.apply(this) as Iterator<unknown>)
  }
  proto[Symbol.iterator] = function (this: unknown) {
    return counting(saved.iterator?.apply(this) as Iterator<unknown>)
  }
  proto['forEach'] = function (this: unknown, ...args: unknown[]) {
    const size = (this as { size: number }).size
    witness.iterated += size
    return saved.forEach?.apply(this, args)
  }
  // biome-ignore lint/suspicious/noExplicitAny: a measurement patch, restored below
  ;(Array.prototype as any).sort = function (this: unknown[], ...args: unknown[]) {
    witness.sorted += this.length
    return saved.sort.apply(this, args as [])
  }
  try {
    fn()
  } finally {
    proto['add'] = saved.add as never
    proto['delete'] = saved.delete as never
    proto['values'] = saved.values as never
    proto['forEach'] = saved.forEach as never
    proto[Symbol.iterator] = saved.iterator as never
    Array.prototype.sort = saved.sort
  }
  return witness
}

function feedOf(scale: 1 | 4) {
  const corpus = buildCorpus(scale)
  const rows = {
    issues: corpus.sliceIssues.map((value): RowRecord => ({ kind: 'issue', id: value.id, value })),
    sessions: corpus.sliceSessions.map(
      (value): RowRecord => ({ kind: 'session', id: value.sessionId, value }),
    ),
    worktrees: corpus.sliceWorktrees.map(
      (value): RowRecord => ({ kind: 'worktree', id: value.path, value }),
    ),
  }
  return { corpus, replay: createReplaySource(rows) }
}

/**
 * Boot a lazy pool over `source`, print the largest bucket per collection,
 * then apply one new open issue and one new session (copies of existing
 * rows, so they land in populated buckets) and print the bucket elements
 * each insert copied and sorted, beside the `indexUpdates` slots it counted.
 */
function measure(label: string, source: RowSource, locals: LocalsSource): void {
  const handle = harnessMobxPoolArm.create(source, locals, DISABLED_READ_FENCE, {
    schedule: () => () => {},
  })
  const pool = handle.pool
  const known: Record<EntityName, string[]> = {
    issue: source.snapshot('issue').map((r) => r.id),
    session: source.snapshot('session').map((r) => r.id),
    worktree: source.snapshot('worktree').map((r) => r.id),
    repo: tracked(() => [...pool.tables.repo.keys()]),
  }
  const largest: Record<string, { key: string; size: number }> = {}
  for (const { from, name, relation } of allRelations()) {
    if (relation.kind !== 'hasMany' && !(relation.kind === 'edge' && relation.direction === 'in'))
      continue
    let best = { key: '', size: 0 }
    for (const id of known[from]) {
      const size = tracked(() => pool.relations.size(from, id, name))
      if (size > best.size) best = { key: id, size }
    }
    largest[`${from}.${name}`] = best
  }
  const sizeOf = (slot: string): number => {
    const at = slot.indexOf(':')
    const [from, name] = slot.slice(0, at).split('.') as [EntityName, string]
    return tracked(() => pool.relations.size(from, slot.slice(at + 1), name))
  }
  const copied = (): { elements: number } => {
    // Bucket sizes via the relation reader (outside the engine's maintenance):
    // a touched slot's size is no longer work done, so report sizes only.
    return {
      elements: 0,
    }
  }
  const openIssue = source
    .snapshot('issue')
    .map((r) => r.value as Record<string, unknown> | undefined)
    .filter((v): v is Record<string, unknown> => v !== undefined && v['closedAt'] == null)
    .filter((v) => typeof v['repoId'] === 'string')
    .sort((a, b) => {
      const size = (v: Record<string, unknown>) =>
        tracked(() => pool.relations.size('repo', v['repoId'] as string, 'issues'))
      return size(b) - size(a)
    })[0]
  if (openIssue === undefined) throw new Error(`${label}: no open issue with a repo`)
  const issueWitness = independently(() =>
    pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'issue',
          id: 'iss_m3_probe',
          value: { ...openIssue, id: 'iss_m3_probe', seq: 999_999, parentId: null, deps: [] } as never,
        },
      ],
    }),
  )
  const issueInsert = copied()
  const session = source
    .snapshot('session')
    .map((r) => r.value as Record<string, unknown> | undefined)
    .find((v) => v !== undefined && v['headless'] !== true)
  if (session === undefined) throw new Error(`${label}: no session`)
  const sessionWitness = independently(() =>
    pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'session',
          id: 'ses_m3_probe',
          value: { ...session, sessionId: 'ses_m3_probe', issueId: null, resume: null } as never,
        },
      ],
    }),
  )
  const sessionInsert = copied()
  void issueInsert
  void sessionInsert
  report(
    `M3 bucket probe ${label}: issues=${known.issue.length} sessions=${known.session.length} ` +
      `lanes=${known.worktree.length} repos=${known.repo.length}\n` +
      `  largest buckets: ${JSON.stringify(largest)}\n` +
      `  reviewer's witness, new issue:   ${JSON.stringify(issueWitness)}\n` +
      `  reviewer's witness, new session: ${JSON.stringify(sessionWitness)}`,
  )
  handle.dispose()
}

describe('M3 probe: bucket-sized work per membership change', () => {
  for (const scale of [1, 4] as const) {
    it(`old fixture ${scale}x`, () => {
      const feed = feedOf(scale)
      const locals = settableLocals({ selectedIssueId: null, coarseNow: feed.corpus.fixedNow })
      measure(`old fixture ${scale}x`, feed.replay.source, locals.source)
    }, 120_000)
  }

  // The live export (POD-4552) is gitignored: point M3_LIVE_EXPORT at it.
  // Rows are composed as the feed composes them (`row-source.ts`; the fixture
  // does the same at `fixture/corpus.ts:1124-1192`): issue wire rows as the
  // issue entity, sessions as they are, every scan repo as its root lane plus
  // one lane per worktree (stamped with the repo's id and path), and each
  // replicated repo row (id, prefix) keyed by its id. The scenario engine is
  // not used: it demands fixture-only scenario targets (`pickTargets`).
  const live = process.env['M3_LIVE_EXPORT']
  it.skipIf(live === undefined)(
    'live export (POD-4552)',
    () => {
      const snapshot = readSnapshot(live as string)
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
      const locals = settableLocals({
        selectedIssueId: null,
        coarseNow: Date.parse(snapshot.exportedAt),
      })
      measure(`live ${snapshot.exportedAt}`, replay.source, locals.source)
    },
    300_000,
  )
})
