/**
 * POD-4665 — the cold rule against the rows the list draws, at 1x and 4x.
 *
 * The question: does the schema's residency rule keep out of memory rows the
 * visible predicate (slice spec §3 R-VIS) shows? Two rules are scored on the
 * live-shaped fixture against the parity oracle's visible rows (the legacy
 * derivation, in R-ORDER):
 *
 * - CONTROL, the rule before POD-4665: an issue is cold when `closedAt` is
 *   set, a session when its issue is. Written out here as the control arm
 *   only; the schema no longer declares it.
 * - DECLARED, `SCHEMA.issue.cold` (`unlessShown`): closed AND nothing R-VIS
 *   reads (the issue's own standing, its member sessions, the issueless
 *   sessions its own checkout seats, POD-4745) can show it at the
 *   clock. Applied through `coldByRule` over the feed's rows, exactly as the
 *   pools' re-partition and the gate's partition check apply it.
 *
 * Per rule: cold issues and sessions (the complement is what a bootstrap
 * builds), visible rows that are cold (each paints as a loading placeholder
 * and loads a moment later), cold rows inside the browser driver's first
 * 96-row window (POD-4560), and resident closed rows the oracle hides (what
 * the upper bound costs). The instrument must fail on the control: the
 * control has cold visible rows, the declared rule has none.
 *
 * Then BOTH pools are bootstrapped on the same feed and held to the declared
 * rule from outside: each pool's cold registry is exactly the rule's cold set
 * (no arm-local copy of the rule), no oracle-visible row is cold in it, and
 * its partition check against the feed is clean.
 */

import { describe, expect, it } from 'vitest'
import { handPoolArm } from '../../arms/hand/pool/arm'
import { diffResidency as handDiffResidency } from '../../arms/hand/pool/enumerate'
import { mobxPoolArm } from '../../arms/mobx/pool/arm'
import { diffResidency as mobxDiffResidency } from '../../arms/mobx/pool/enumerate'
import { coldByRule, type EntityName, SCHEMA, tableColdContext } from '../../shared/src/schema'
import { startScenarioEngine } from '../../shared/src/scenarios'
import { openFenceFeeds, parityLocals } from './fence-scenarios'
import { legacyDerivationFromStore, visibleIssueRows } from './oracle/index'
import { writeResult } from './results'

/** The browser driver's first window (POD-4560: 96 rows). */
const FIRST_WINDOW = 96

interface RuleCell {
  readonly coldIssues: number
  readonly coldSessions: number
  readonly residentIssues: number
  readonly residentSessions: number
  readonly coldVisible: number
  readonly coldInFirstWindow: number
  readonly residentClosedHidden: number
  /** Distinct cold origins a visible spin-off's ⤷ tick names (loaded on first paint, not drawn as rows). */
  readonly coldTickedOrigins: number
}

function score(
  order: readonly string[],
  issues: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  sessions: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  cold: (entity: EntityName, id: string) => boolean,
): RuleCell {
  const visible = new Set(order)
  const coldIds = new Set([...issues.keys()].filter((id) => cold('issue', id)))
  const coldSessions = [...sessions.keys()].filter((id) => cold('session', id)).length
  return {
    coldIssues: coldIds.size,
    coldSessions,
    residentIssues: issues.size - coldIds.size,
    residentSessions: sessions.size - coldSessions,
    coldVisible: order.filter((id) => coldIds.has(id)).length,
    coldInFirstWindow: order.slice(0, FIRST_WINDOW).filter((id) => coldIds.has(id)).length,
    residentClosedHidden: [...issues].filter(
      ([id, row]) => row['closedAt'] != null && !coldIds.has(id) && !visible.has(id),
    ).length,
    coldTickedOrigins: new Set(
      order
        .map(
          (id) =>
            (issues.get(id)?.['deps'] as { id: string; type: string }[] | undefined)?.find(
              (dep) => dep.type === 'discovered-from',
            )?.id,
        )
        .filter((origin): origin is string => origin !== undefined && coldIds.has(origin)),
    ).size,
  }
}

async function measure(scale: 1 | 4) {
  const ctx = await startScenarioEngine(scale)
  const feeds = openFenceFeeds(ctx, 'overlaid')
  try {
    const locals = parityLocals(ctx)
    const now = locals.coarseNow
    const order = visibleIssueRows(
      legacyDerivationFromStore(ctx.engine.getSnapshot(), now),
      locals,
    ).map((row) => row.issue.id)
    const table = (kind: 'issue' | 'session' | 'worktree') =>
      new Map(
        feeds.rows.source
          .snapshot(kind)
          .filter((record) => record.value !== undefined)
          .map((record) => [record.id, record.value as unknown as Readonly<Record<string, unknown>>]),
      )
    const issues = table('issue')
    const sessions = table('session')
    const lanes = table('worktree')

    const controlIssue = (id: string) => issues.get(id)?.['closedAt'] != null
    const control = score(order, issues, sessions, (entity, id) => {
      if (entity === 'issue') return controlIssue(id)
      const issueId = sessions.get(id)?.['issueId']
      return typeof issueId === 'string' && issues.has(issueId) && controlIssue(issueId)
    })
    const rule = tableColdContext(
      SCHEMA,
      (entity) =>
        entity === 'issue'
          ? issues
          : entity === 'session'
            ? sessions
            : entity === 'worktree'
              ? lanes
              : undefined,
      now,
    )
    const declaredCold = (entity: EntityName, id: string): boolean => {
      const row = (entity === 'issue' ? issues : sessions).get(id)
      return row !== undefined && coldByRule(SCHEMA, entity, row, rule)
    }
    const declared = score(order, issues, sessions, declaredCold)

    // Both pools, bootstrapped on the same feed, held to the declared rule.
    const never = { schedule: () => () => {} }
    const pools = {
      mobx: mobxPoolArm.create(feeds.rows.source, feeds.locals.source, undefined, never),
      hand: handPoolArm.create(feeds.rows.source, feeds.locals.source, undefined, never),
    }
    const pooled: Record<string, unknown> = {}
    try {
      for (const [name, handle] of Object.entries(pools)) {
        const residency = handle.pool.residency
        if (residency === null) throw new Error(`${name}: no residency`)
        const diff =
          name === 'mobx'
            ? mobxDiffResidency(pools.mobx.pool, feeds.rows.source)
            : handDiffResidency(pools.hand.pool, feeds.rows.source)
        pooled[name] = {
          coldIssues: residency.size('issue'),
          coldSessions: residency.size('session'),
          coldVisible: order.filter((id) => residency.isCold('issue', id)).length,
          notColdByRule: residency.ids('issue').filter((id) => !declaredCold('issue', id)).length,
          partition: diff,
        }
      }
    } finally {
      pools.mobx.dispose()
      pools.hand.dispose()
    }
    return {
      scale,
      clock: new Date(now).toISOString(),
      issues: issues.size,
      sessions: sessions.size,
      visible: order.length,
      closedVisible: order.filter((id) => issues.get(id)?.['closedAt'] != null).length,
      control,
      declared,
      pools: pooled as Record<
        'mobx' | 'hand',
        {
          coldIssues: number
          coldSessions: number
          coldVisible: number
          notColdByRule: number
          partition: string[]
        }
      >,
    }
  } finally {
    feeds.dispose()
    ctx.engine.destroy()
  }
}

describe('the cold rule against the drawn rows (POD-4665)', () => {
  it.each([1, 4] as const)('at %ix', async (scale) => {
    const cell = await measure(scale)
    console.info(`[cold-rule] ${JSON.stringify(cell)}`)
    writeResult(`cold-rule-${scale}x`, cell)
    // The instrument fails on the control: closed rows the list draws are cold.
    expect(cell.control.coldVisible).toBeGreaterThan(0)
    expect(cell.control.coldVisible).toBe(cell.closedVisible)
    // The declared rule keeps every drawn row resident.
    expect(cell.declared.coldVisible).toBe(0)
    expect(cell.declared.coldInFirstWindow).toBe(0)
    // It still keeps most closed rows out of memory.
    expect(cell.declared.coldIssues).toBeGreaterThan(cell.issues / 3)
    // Both pools apply exactly the declared rule.
    for (const name of ['mobx', 'hand'] as const) {
      const pool = cell.pools[name]
      expect(pool.partition, name).toEqual([])
      expect(pool.coldIssues, name).toBe(cell.declared.coldIssues)
      expect(pool.coldSessions, name).toBe(cell.declared.coldSessions)
      expect(pool.coldVisible, name).toBe(0)
      expect(pool.notColdByRule, name).toBe(0)
    }
  }, 900_000)
})
