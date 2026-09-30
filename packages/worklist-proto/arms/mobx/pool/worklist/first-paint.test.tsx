// @vitest-environment happy-dom
/**
 * POD-4569 (Mb1) — what the visible collection costs at bootstrap and first
 * paint, at 1x and 4x, measured from OUTSIDE the pool (coordinator's
 * condition 1, 2026-09-23):
 *
 * - feed reads: every per-row read (`RowSource.row`) the pool makes, counted
 *   by a wrapper around the feed it is given. At bootstrap they are the cold
 *   rows' visibility reads; while the first loads settle, the loads.
 * - visibility nodes: MobX's own graph. Every reaction MobX tracks is
 *   collected (`Reaction.prototype.track`), and from the pool's visibility
 *   reactions the graph is walked through each derivation's `observing_`
 *   (MobX's dependency list) to the distinct `IssueModel@n` / `SessionModel@n`
 *   objects behind them. Nothing here asks the pool what it built.
 * - first paint: the DOM right after mount, before any load lands. A visible
 *   row that is cold draws as a loading placeholder (`data-loading-row`); the
 *   first 96 rows are the browser driver's first window (POD-4560).
 */

import { Reaction } from 'mobx'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { mountArmForCounts } from '../../../../harness/src/count-harness'
import { openFenceFeeds } from '../../../../harness/src/fence-scenarios'
import { writeResult } from '../../../../harness/src/results'
import type { CheckableArm, RowSource } from '../../../../shared/src/arm'
import { startScenarioEngine } from '../../../../shared/src/scenarios'
import { harnessMobxPoolArm, tracked, type HarnessMobxPoolHandle } from '../../../../harness/src/adapters/mobx-pool'
import { installMobxWarnTrap } from '../../../../harness/src/mobx-trap'

installMobxWarnTrap()

/** The browser driver's first window (POD-4560: 96 rows). */
const FIRST_WINDOW = 96

interface Derivation {
  readonly name_: string
  readonly observing_?: readonly Derivation[]
}

/** Every reaction MobX tracks while `run` runs. */
function collectReactions(run: () => void): Set<Derivation> {
  const seen = new Set<Derivation>()
  const proto = Reaction.prototype as unknown as { track: (fn: () => void) => void }
  const original = proto.track
  proto.track = function (this: Derivation, fn: () => void) {
    seen.add(this)
    return original.call(this, fn)
  }
  try {
    run()
  } finally {
    proto.track = original
  }
  return seen
}

/** Distinct `Class@n` objects behind the derivations reachable from `roots` (MobX's graph). */
function objectsBehind(roots: Iterable<Derivation>): Record<string, number> {
  const visited = new Set<Derivation>()
  const objects = new Set<string>()
  const stack = [...roots]
  while (stack.length > 0) {
    const next = stack.pop() as Derivation
    if (visited.has(next)) continue
    visited.add(next)
    // `Class@n.key` (declared) or `Class@<id>.group` (a cached group).
    const owner = /^(\w+@[^.]+)\./.exec(next.name_ ?? '')?.[1]
    if (owner !== undefined) objects.add(owner)
    for (const dependency of next.observing_ ?? []) stack.push(dependency)
  }
  const byClass: Record<string, number> = {}
  for (const owner of objects) {
    const cls = owner.split('@')[0] as string
    byClass[cls] = (byClass[cls] ?? 0) + 1
  }
  return byClass
}

async function measure(scale: 1 | 4) {
  const ctx = await startScenarioEngine(scale)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  let phase: 'bootstrap' | 'settle' = 'bootstrap'
  const feedReads = { bootstrap: new Set<string>(), settle: new Set<string>() }
  const counting = (source: RowSource): RowSource =>
    new Proxy(source, {
      get(target, key, receiver) {
        if (key !== 'row') return Reflect.get(target, key, receiver)
        return (kind: Parameters<NonNullable<RowSource['row']>>[0], id: string) => {
          feedReads[phase].add(`${kind}:${id}`)
          return target.row?.(kind, id)
        }
      },
    })
  const arm: CheckableArm = {
    create: (source, locals, reads) =>
      harnessMobxPoolArm.create(counting(source), locals, reads, { schedule: () => () => {} }),
  }
  let mounted: ReturnType<typeof mountArmForCounts> | undefined
  const reactions = collectReactions(() => {
    mounted = mountArmForCounts(arm, feeds.rows.source, feeds.locals)
  })
  const m = mounted as ReturnType<typeof mountArmForCounts>
  const { pool } = m.handle as HarnessMobxPoolHandle
  try {
    const visibility = [...reactions].filter((r) => r.name_.startsWith('pool.file.'))
    const nodes = objectsBehind(visibility)
    const order = tracked(() => [...pool.worklist.order])
    // The drawn rows in list order (Mb2 wraps each item and adds group headers).
    const slots = [
      ...document.querySelectorAll('[data-pool-list] [data-issue-row], [data-pool-list] [data-loading-row]'),
    ]
    const loadingAt = (list: Element[]) =>
      list.filter((el) => el.hasAttribute('data-loading-row')).length
    const firstPaint = {
      visible: order.length,
      drawnSlots: slots.length,
      loadingRows: loadingAt(slots),
      loadingInFirstWindow: loadingAt(slots.slice(0, FIRST_WINDOW)),
      coldVisible: order.filter((id) => pool.residency?.isCold('issue', id) === true).length,
      coldInFirstWindow: order
        .slice(0, FIRST_WINDOW)
        .filter((id) => pool.residency?.isCold('issue', id) === true).length,
    }
    // The harness resets the pool's stats at mount: read the held nodes instead.
    const held = {
      issueNodes: pool.worklist.size(),
      sessionNodes: pool.modelCount('session'),
    }
    const modelsAtPaint = pool.modelCount('issue') + pool.modelCount('session')
    phase = 'settle'
    let windows = 0
    while (pool.residency?.hasQueued() && windows < 100) {
      act(() => {
        pool.hydrate()
      })
      windows += 1
    }
    const settledLoading = document.querySelectorAll('[data-loading-row]').length
    // POD-4665: what first paint holds once its loads have landed, counted, not summed.
    const modelsSettled = pool.modelCount('issue') + pool.modelCount('session')
    const byKind = (set: Set<string>) => {
      const out: Record<string, number> = {}
      for (const key of set) {
        const kind = key.split(':')[0] as string
        out[kind] = (out[kind] ?? 0) + 1
      }
      return out
    }
    return {
      scale,
      issues: ctx.corpus.issues.length,
      sessions: ctx.corpus.sessions.length,
      firstPaint,
      nodesFromMobxGraph: { visibilityReactions: visibility.length, ...nodes },
      feedReads: {
        bootstrap: { distinct: feedReads.bootstrap.size, ...byKind(feedReads.bootstrap) },
        firstLoads: { distinct: feedReads.settle.size, ...byKind(feedReads.settle) },
      },
      loadWindows: windows,
      settledLoading,
      poolHeld: {
        ...held,
        modelsAtFirstPaint: modelsAtPaint,
        modelsSettled,
      },
    }
  } finally {
    m.unmount()
    feeds.dispose()
    ctx.engine.destroy()
  }
}

describe('visible collection: bootstrap and first paint (outside measures)', () => {
  it.each([1, 4] as const)('at %ix', async (scale) => {
    const cell = await measure(scale)
    console.info(`[mobx-first-paint] ${JSON.stringify(cell)}`)
    writeResult(`mobx-visible-first-paint-${scale}x`, cell)
    // The instruments saw something: a filing reaction per issue in memory,
    // and every placeholder resolved once the loads landed.
    expect(cell.nodesFromMobxGraph.visibilityReactions).toBe(cell.poolHeld.issueNodes)
    // Behind them: every tracked issue's object, and the cold ones their
    // walks read (an ancestor, a child).
    expect((cell.nodesFromMobxGraph as Record<string, number>)['IssueModel']).toBeGreaterThanOrEqual(
      cell.poolHeld.issueNodes,
    )
    expect(cell.firstPaint.loadingRows).toBe(cell.firstPaint.coldVisible)
    expect(cell.settledLoading).toBe(0)
  }, 900_000)
})
