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
import { parityLocals } from '../../../../harness/src/fence-scenarios'
import {
  legacyDerivationFromStore,
  visibleIssueRows,
} from '../../../../harness/src/oracle/index'
import type { CheckableArm } from '../../../../shared/src/arm'
import { gen } from '../../../../shared/src/gen/changes'
import { checkArm } from '../../../../shared/src/gen/check'
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

function patchGetter(name: 'keeps' | 'laneMemberIds' | 'nestParent', get: (this: IssueNode) => unknown): () => void {
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
    const restore = patchGetter('laneMemberIds', function (this: IssueNode) {
      return []
    })
    await expectPlant(
      () => {},
      restore,
      { snapshot: 11, missing: 'i-g4', extra: '' },
    )
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
