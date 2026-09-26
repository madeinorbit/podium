/**
 * POD-4681 — the three R-VIS plants as PERMANENT tests on the MobX arm. Each
 * planted mistake runs a default 3x200 against the shared oracle and must
 * FAIL every seed: the generator's forced prefix (`excludedKeeper`,
 * `orphanInWorktree`, `draftVesselStarter`) reaches the branch on every seed,
 * so a plant that stops failing means the shape no longer reaches it. Each
 * plant is installed on `IssueNode.prototype` in memory and restored in a
 * `finally` (a copy of the rule where the rule is more than a line); arm
 * files on disk are never touched.
 */

import { describe, expect, it } from 'vitest'
import { createEngineLocals } from '../../../../harness/src/engine-locals'
import { parityLocals } from '../../../../harness/src/fence-scenarios'
import {
  legacyDerivationFromStore,
  visibleIssueRows,
} from '../../../../harness/src/oracle/index'
import type { CheckableArm } from '../../../../shared/src/arm'
import { type Change, gen } from '../../../../shared/src/gen/changes'
import { checkArm } from '../../../../shared/src/gen/check'
import { startGenRun } from '../../../../shared/src/gen/run'
import type { ScenarioEngine } from '../../../../shared/src/scenarios'
import { mobxPoolArm } from '../arm'
import { installMobxWarnTrap } from '../mobx-trap'
import { IssueNode } from './visible'
import type { IssueVisibility, VisibleInputs } from './visible'

installMobxWarnTrap()

const FIRST_SEED = Number(process.env['POD_POOL_GATE_FIRST_SEED'] ?? 1)
const SEEDS = Array.from(
  { length: Number(process.env['POD_POOL_GATE_SEEDS'] ?? 3) - FIRST_SEED + 1 },
  (_, i) => i + FIRST_SEED,
)
const STEPS = Number(process.env['POD_POOL_GATE_STEPS'] ?? 200)
/** 2.5 s per seed-step, never under 25 min (as the hand gate). */
const GATE_TIMEOUT_MS = Math.max(1_500_000, SEEDS.length * STEPS * 2_500)

/** Copy of `ownerOf` (`worklist/visible.ts`) for the draft plant below. */
function plantOwnerOf(input: VisibleInputs, sessionId: string): string | null {
  const session = input.session(sessionId)
  const retention = session.retention
  if (retention === null || retention.archived) return null
  if (retention.issueId !== undefined) {
    const issueId = session.issueLink
    return issueId !== null &&
      issueId === retention.issueId &&
      input.issue(issueId)?.present === true
      ? issueId
      : null
  }
  const worktree = session.worktreeLink
  if (worktree === null) return null
  let owner: string | null = null
  for (const issueId of input.relations.many('worktree', worktree, 'issues')) {
    if (owner !== null && issueId > owner) continue
    const issue = input.issue(issueId)
    if (issue?.standing?.excluded === false && issue.present) owner = issueId
  }
  return owner
}

/** Copy of `nestParentPartOf` without the draft-vessel exception. */
function plantNestParentNoDraft(
  input: VisibleInputs,
  id: string,
  self: IssueVisibility,
): string | null {
  const standing = self.standing
  if (standing === undefined || !self.present) return null
  const seen = new Set<string>([id])
  let parentId = standing.parentId
  while (parentId !== null) {
    if (seen.has(parentId)) return null
    seen.add(parentId)
    const parent = input.issue(parentId)
    if (parent === undefined) break
    if (parent.present) return parentId
    parentId = parent.standing?.parentId ?? null
  }
  if (standing.parentId !== null || standing.startedBy === null) return null
  const owner = plantOwnerOf(input, standing.startedBy)
  if (owner === null || owner === id) return null
  return owner
}

/** The pool's visible set against the legacy oracle's flat rows, after every step. */
function orderChecked(): ((ctx: ScenarioEngine) => CheckableArm) & { compared: number } {
  const factory = ((ctx: ScenarioEngine): CheckableArm => ({
    create(source, locals, reads) {
      const handle = mobxPoolArm.create(source, locals, reads)
      return {
        ...handle,
        snapshot() {
          const settled = handle.snapshot()
          const coarseNow = parityLocals(ctx).coarseNow
          const derivation = legacyDerivationFromStore(ctx.engine.getSnapshot(), coarseNow)
          const expected: string[] = visibleIssueRows(derivation, parityLocals(ctx)).map(
            (row) => row.issue.id,
          )
          const have = new Set(Object.keys(settled.rowsById))
          const want = new Set(expected)
          factory.compared += 1
          const missing = expected.filter((id) => !have.has(id))
          const extra = [...have].filter((id) => !want.has(id))
          if (missing.length > 0 || extra.length > 0) {
            throw new Error(
              `order diverged from the oracle (snapshot ${factory.compared}): ` +
                `missing [${missing.slice(0, 5).join(', ')}], ` +
                `extra [${extra.slice(0, 5).join(', ')}]`,
            )
          }
          return settled
        },
      }
    },
  })) as ((ctx: ScenarioEngine) => CheckableArm) & { compared: number }
  factory.compared = 0
  return factory
}

async function expectPlant(
  install: () => void,
  restore: () => void,
  want: { snapshot: number; missing: string; extra: string },
): Promise<void> {
  install()
  try {
    for (const seed of SEEDS) {
      const sequence = gen(seed, STEPS)
      const arm = orderChecked()
      let failure: string | null = null
      try {
        const result = await checkArm(arm, sequence, { oracleEvery: 0, shrink: false })
        if (!result.ok) failure = `step ${result.step} (${result.against}): ${result.diff}`
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      expect(failure, `seed ${seed}: plant not caught`).not.toBeNull()
      if (seed === FIRST_SEED) {
        expect(failure as string).toContain(`snapshot ${want.snapshot}`)
        if (want.missing) expect(failure as string).toContain(want.missing)
        if (want.extra) expect(failure as string).toContain(want.extra)
      }
    }
  } finally {
    restore()
  }
}

/**
 * Drive `sequence` on a fresh engine with the live pool held to the legacy
 * oracle after every step, collecting every divergence. Unlike `checkArm`
 * this never compares with the pool's rebuild: the prototype patch plants
 * the live nodes only, so a live-vs-rebuild check would fire on rollup
 * fields wherever an R3 session overlaps an explicit one, masking the
 * oracle comparison this test is about. A `refresh` re-creates the arm over
 * the new feed, as `checkArm` does.
 */
async function collectOracleLog(sequence: readonly Change[]): Promise<string[]> {
  const log: string[] = []
  let compared = 0
  const run = await startGenRun({ feedMode: 'overlaid' })
  try {
    let feed = run.feed()
    let locals = createEngineLocals(run.ctx.engine)
    const observed = (handle: { snapshot(): unknown }): void => {
      locals.flush()
      const settled = handle.snapshot() as {
        rowsById: Record<string, unknown>
      }
      const coarseNow = parityLocals(run.ctx).coarseNow
      const derivation = legacyDerivationFromStore(run.ctx.engine.getSnapshot(), coarseNow)
      const expected: string[] = visibleIssueRows(derivation, parityLocals(run.ctx)).map(
        (row) => row.issue.id,
      )
      const have = new Set(Object.keys(settled.rowsById))
      const want = new Set(expected)
      compared += 1
      const missing = expected.filter((id) => !have.has(id))
      const extra = [...have].filter((id) => !want.has(id))
      if (missing.length > 0 || extra.length > 0) {
        log.push(
          `snapshot ${compared}: missing [${missing.slice(0, 8).join(', ')}], ` +
            `extra [${extra.slice(0, 8).join(', ')}]`,
        )
      }
    }
    let handle = mobxPoolArm.create(feed.source, locals.source)
    try {
      observed(handle)
      for (const change of sequence) {
        await run.apply(change)
        if (run.feed() !== feed) {
          handle.dispose()
          locals.dispose()
          feed = run.feed()
          locals = createEngineLocals(run.ctx.engine)
          handle = mobxPoolArm.create(feed.source, locals.source)
        }
        observed(handle)
      }
    } finally {
      handle.dispose()
      locals.dispose()
    }
  } finally {
    run.dispose()
  }
  return log
}

function patchGetter(name: 'keeps' | 'memberIds' | 'nestParent', get: (this: IssueNode) => unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(IssueNode.prototype, name)
  if (descriptor?.get === undefined) throw new Error(`[plants] no getter ${name} on IssueNode`)
  Object.defineProperty(IssueNode.prototype, name, { get: get as never, configurable: true })
  return () => {
    Object.defineProperty(IssueNode.prototype, name, descriptor)
  }
}

describe('visibility plants against the oracle (POD-4681)', () => {
  it('plant keeps ignoring excluded fails every seed', async () => {
    const restore = patchGetter('keeps', function (this: IssueNode) {
      if (this.standing === undefined) return false
      return this.flat || this.keptBelow
    })
    await expectPlant(
      () => {},
      restore,
      { snapshot: 6, missing: '', extra: 'i-g1' },
    )
  }, GATE_TIMEOUT_MS)

  it('plant no R3 members fails every seed', async () => {
    // Planted at the `memberIds` composition point (R2 only, the lane's R3
    // part dropped), mirroring the hand arm's plant line for line. Driven
    // without the rebuild comparison (see `collectOracleLog`): the shape's
    // row must be missing from snapshot 11 on every seed.
    const restore = patchGetter('memberIds', function (this: IssueNode) {
      return this.seatIds
    })
    try {
      for (const seed of SEEDS) {
        const log = (await collectOracleLog(gen(seed, STEPS))).join('\n')
        expect(log, `seed ${seed}: plant not caught`).not.toBe('')
        if (seed === FIRST_SEED) {
          expect(log).toContain('snapshot 11')
          expect(log).toContain('i-g4')
        }
      }
    } finally {
      restore()
    }
  }, GATE_TIMEOUT_MS)

  it('plant draft vessel ignored fails every seed', async () => {
    const restore = patchGetter('nestParent', function (this: IssueNode) {
      const input = (this as unknown as { input: VisibleInputs }).input
      return plantNestParentNoDraft(input, this.id, this)
    })
    await expectPlant(
      () => {},
      restore,
      { snapshot: 15, missing: 'i-g9', extra: '' },
    )
  }, GATE_TIMEOUT_MS)
})
