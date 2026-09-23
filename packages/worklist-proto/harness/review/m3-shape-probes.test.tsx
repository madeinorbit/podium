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

import { autorun, computed, observable, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { mobxPoolArm } from '../../arms/mobx/pool/arm'
import { installMobxWarnTrap } from '../../arms/mobx/pool/mobx-trap'
import { tracked } from '../../arms/mobx/pool/pool'
import { allRelations, type EntityName } from '../../shared/src/schema'
import { DISABLED_READ_FENCE } from '../../shared/src/instrument/reads'
import { settableLocals } from '../../shared/src/locals-source'
import type { RowRecord } from '../../shared/src/stats'
import { createReplaySource } from '../src/count-harness'
import { buildCorpus } from '../src/fixture/index'

const trap = installMobxWarnTrap()

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

describe('M3 probe: bucket-sized work per membership change', () => {
  for (const scale of [1, 4] as const) {
    it(`largest bucket per collection, and one insert's copied elements, at ${scale}x`, () => {
      const feed = feedOf(scale)
      const locals = settableLocals({ selectedIssueId: null, coarseNow: feed.corpus.fixedNow })
      const handle = mobxPoolArm.create(feed.replay.source, locals.source, DISABLED_READ_FENCE, {
        schedule: () => () => {},
      })
      const pool = handle.pool
      const known: Record<EntityName, string[]> = {
        issue: feed.replay.source.snapshot('issue').map((r) => r.id),
        session: feed.replay.source.snapshot('session').map((r) => r.id),
        worktree: feed.replay.source.snapshot('worktree').map((r) => r.id),
        repo: [],
      }
      known.repo = tracked(() => [...pool.tables.repo.keys()])
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
        // `collection:key` slots written by the last action.
        const [collection, key] = [slot.slice(0, slot.indexOf(':')), slot.slice(slot.indexOf(':') + 1)]
        const [from, name] = collection.split('.') as [EntityName, string]
        return tracked(() => pool.relations.size(from, key, name))
      }
      const copied = (): { slots: string[]; elements: number } => {
        const slots = pool.graph.lastWrites.filter((s) => !s.includes('→'))
        return { slots, elements: slots.reduce((n, s) => n + sizeOf(s), 0) }
      }
      // One new open issue in the biggest repo, and one new session under the biggest lane.
      const template = feed.corpus.sliceIssues.find((i) => i.closedAt == null && i.repoId != null)
      if (template === undefined) throw new Error('no open issue with a repo')
      const newIssue = { ...template, id: 'iss_m3_probe', seq: 999_999, parentId: null, deps: [] }
      pool.graph.begin()
      feed.replay.push({ type: 'update', rows: [{ kind: 'issue', id: newIssue.id, value: newIssue }] })
      const issueInsert = copied()
      const session = feed.corpus.sliceSessions.find((s) => s.headless !== true)
      if (session === undefined) throw new Error('no session')
      const newSession = { ...session, sessionId: 'ses_m3_probe', issueId: null, resume: null }
      feed.replay.push({
        type: 'update',
        rows: [{ kind: 'session', id: newSession.sessionId, value: newSession }],
      })
      const sessionInsert = copied()
      console.log(
        `M3 bucket probe ${scale}x: issues=${known.issue.length} sessions=${known.session.length} ` +
          `lanes=${known.worktree.length} repos=${known.repo.length}\n` +
          `  largest buckets: ${JSON.stringify(largest)}\n` +
          `  new issue:   indexUpdates slots ${JSON.stringify(issueInsert.slots)} → ${issueInsert.elements} bucket elements copied+sorted\n` +
          `  new session: indexUpdates slots ${JSON.stringify(sessionInsert.slots)} → ${sessionInsert.elements} bucket elements copied+sorted`,
      )
      handle.dispose()
    }, 120_000)
  }
})
