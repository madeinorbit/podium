/**
 * POD-4591 (M3) — the shape reviewer's own probes of the MobX pool, so the
 * review's claims are re-runnable at any SHA (a re-review runs this file).
 *
 * 1. ENFORCEMENT. Plants each MobX warning the pool relies on and shows the
 *    pool's trap (`arms/mobx/pool/mobx-trap.ts`) turns it into a failure:
 *    synchronously where MobX warns on the caller's stack, and by the
 *    recorded list where MobX swallows the throw inside a reaction. Also
 *    shows what the trap cannot see (a plain variable read by a computed).
 * 2. BUCKET WORK. Relation buckets are sorted frozen arrays replaced whole on
 *    every membership change (`relations.ts` `pendingSet` / `flush`), so one
 *    insert copies and sorts its target's whole bucket and counts ONE
 *    `indexUpdates`. Prints the largest bucket per collection on the
 *    live-shaped corpus at 1x and 4x, and the elements copied by one new
 *    issue and one new session. Counts only: no walls, no load rule needed.
 */

import { appendFileSync } from 'node:fs'
import { autorun, computed, observable, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { mobxPoolArm } from '../../arms/mobx/pool/arm'
import { installMobxWarnTrap } from '../../arms/mobx/pool/mobx-trap'
import { tracked } from '../../arms/mobx/pool/pool'
import { allRelations, type EntityName } from '../../shared/src/schema'
import { DISABLED_READ_FENCE } from '../../shared/src/instrument/reads'
import { settableLocals } from '../../shared/src/locals-source'
import type { LocalsSource, RowSource } from '../../shared/src/arm'
import type { RowRecord } from '../../shared/src/stats'
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
  const handle = mobxPoolArm.create(source, locals, DISABLED_READ_FENCE, {
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
  const copied = (before: number): { slots: string[]; counted: number; elements: number } => {
    const slots = pool.graph.lastWrites.filter((s) => !s.includes('→'))
    return {
      slots,
      counted: pool.stats.indexUpdates - before,
      elements: slots.reduce((n, s) => n + sizeOf(s), 0),
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
  let before = pool.stats.indexUpdates
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'issue',
        id: 'iss_m3_probe',
        value: { ...openIssue, id: 'iss_m3_probe', seq: 999_999, parentId: null, deps: [] },
      },
    ],
  })
  const issueInsert = copied(before)
  const session = source
    .snapshot('session')
    .map((r) => r.value as Record<string, unknown> | undefined)
    .find((v) => v !== undefined && v['headless'] !== true)
  if (session === undefined) throw new Error(`${label}: no session`)
  before = pool.stats.indexUpdates
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'session',
        id: 'ses_m3_probe',
        value: { ...session, sessionId: 'ses_m3_probe', issueId: null, resume: null },
      },
    ],
  })
  const sessionInsert = copied(before)
  report(
    `M3 bucket probe ${label}: issues=${known.issue.length} sessions=${known.session.length} ` +
      `lanes=${known.worktree.length} repos=${known.repo.length}\n` +
      `  largest buckets: ${JSON.stringify(largest)}\n` +
      `  new issue:   indexUpdates +${issueInsert.counted} (slots ${JSON.stringify(issueInsert.slots)}) → ${issueInsert.elements} bucket elements copied+sorted\n` +
      `  new session: indexUpdates +${sessionInsert.counted} (slots ${JSON.stringify(sessionInsert.slots)}) → ${sessionInsert.elements} bucket elements copied+sorted`,
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
  it.skipIf(live === undefined)('live export (POD-4552)', () => {
    const snapshot = readSnapshot(live as string)
    const worktrees: RowRecord[] = []
    for (const repo of snapshot.repos as unknown as {
      path: string
      repoId?: string | null
      worktrees?: { path: string }[]
    }[]) {
      const stamp = { repoId: repo.repoId ?? null, repoPath: repo.path }
      worktrees.push({ kind: 'worktree', id: repo.path, value: { path: repo.path, ...stamp } })
      for (const wt of repo.worktrees ?? []) {
        worktrees.push({ kind: 'worktree', id: wt.path, value: { path: wt.path, ...stamp } })
      }
    }
    for (const row of snapshot.repoProjections as unknown as { id: string }[]) {
      worktrees.push({ kind: 'worktree', id: row.id, value: row })
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
  }, 300_000)
})
