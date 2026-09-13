/**
 * THE OPERATION-TARGET GATE AS A PORT (PDM-297) — the target-machine `manage`
 * check that all three operation write contracts declare, and the dispatch the
 * engine forwards, both pre-bound to ONE caller so a derived handler can run
 * them without ever being handed an authority object.
 *
 * ---------------------------------------------------------------------------
 * WHY A PORT AND NOT A PRINCIPAL ON THE STATE BUNDLE
 * ---------------------------------------------------------------------------
 *
 * Argued ONCE, in `derived-family.ts`'s header section "THE DECISIONS THIS FILE
 * DOES TAKE", under the THIRD position `PDM-290` opened — not re-argued here,
 * because two statements of one rule is how the two come to disagree.
 *
 * What is worth saying HERE is what this file is evidence OF. `PDM-290` wrote
 * that position for `sessionTargets` and it had exactly one member, and a
 * position with one member is indistinguishable from an exception with a nice
 * name. This is its SECOND member, built by a different family for a different
 * question, and it needed no new rule to fit. That is the difference between an
 * invariant that admits a shape and an invariant someone carved a hole in.
 *
 * ---------------------------------------------------------------------------
 * TWO ACTORS, DELIBERATELY, AND NOT CONVERGED HERE
 * ---------------------------------------------------------------------------
 *
 * `operations/trpc.ts` has always used two different answers to "who is
 * calling", and this port PRESERVES the split rather than quietly picking one:
 *
 *   - `authorizingActor` — resolved from the CAPABILITY through `roleFloorDeps`,
 *     which walks live `spawnedBy` rows so a sub-agent's chain roots at exactly
 *     one human (D16.2). This is what the machine-verb decision reads, and it is
 *     what `assertActionAuthorized` read before this file existed.
 *   - `dispatchActor` — the request context's own `ctx.principal`, FORWARDED
 *     into kind-specific `onAction` handlers (`kinds.ts`'s `onAction({operation,
 *     actionId, principal, mode})`). It is not attribution this port could
 *     encode away: it reaches third-party kind definitions.
 *
 * For a human the two agree. For an agent they can differ, because only the
 * first walks the delegation chain live. `PDM-299` raised converging them with
 * `PDM-107` and was told to stop rather than converge; that ruling is still
 * pending, so this file carries both and changes neither. Converging them is a
 * BEHAVIOUR change to who may drive an operation, not a tidy-up, and it does not
 * belong in a cutover graded behaviour-preserving.
 *
 * THE ROLE FLOOR IS NOT HERE, and its absence is the join doing its job. All
 * three contracts declare `roleFloor: 'admin'`; since `PDM-294` the derived
 * builder reads `contract.policy.roleFloor` and refuses below it at the
 * transport, before the service is selected. `assertActionAuthorized`'s
 * hard-coded admin comparison is deleted rather than moved — `PDM-299`'s note in
 * `trpc.ts` handed that follow-through to this issue by name. What remains here
 * is the half a floor cannot answer: a floor is a claim about the CALLER's
 * grade and says nothing about the TARGET, and "may this caller manage the
 * machine this operation is acting on" is a row-level question that has to read
 * the row.
 */

import { asMachineId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import type { CommandPrincipal } from '../../command-principal'
import { checkMachineVerb, ownershipSnapshotFromMachines } from '../../machine-access'
import type { RegistryModules } from '../../relay'
import type { ActionDispatchResult, CancelResult } from './engine'

/** The two modules an operation-target decision reads. A `Pick`, so a caller
 *  cannot reach the rest of the seam through this argument. */
export type OperationAccessModules = Pick<RegistryModules, 'operations' | 'machines'>

/**
 * One caller's operation-target gate.
 *
 * Every method REFUSES OR ACTS — there is no boolean for a service to forget.
 * `requireManageable` is exposed alongside the two acting methods because the
 * engine reads are ungoverned by it and a future write must be able to say which
 * rule it is running.
 */
export interface OperationTargetGate {
  /**
   * Refuse unless this caller may `manage` the machine this operation targets.
   *
   * AN OPERATION WITH NO TARGET MACHINE IS NOT REFUSED, which is the shipped
   * behaviour and not an oversight: `targetMachineId` lives in the operation's
   * durable `details`, and a kind that names no machine (a purely local
   * lifecycle operation) has no target for a machine verb to be about. The
   * admin floor still governs it at the transport.
   *
   * ABSENT AND INVISIBLE ARE ONE ANSWER — `checkMachineVerb` returns `absent`
   * for a machine this caller cannot see, and it becomes NOT_FOUND here, so the
   * surface is not an existence oracle for other people's machines.
   */
  requireManageable(operationId: string): Promise<void>
  /** Cancel, after the same gate. */
  cancel(operationId: string): Promise<CancelResult>
  /** Dispatch, after the same gate, with this caller's principal forwarded. */
  dispatchAction(
    operationId: string,
    actionId: string,
    options: { settleAsk: boolean },
  ): Promise<ActionDispatchResult>
}

export function operationTargetGate(
  modules: OperationAccessModules,
  authorizingActor: () => Promise<CommandPrincipal>,
  dispatchActor: CommandPrincipal,
): OperationTargetGate {
  const engine = () => modules.operations.engine

  async function requireManageable(operationId: string): Promise<void> {
    const principal = await authorizingActor()
    const operation = (await engine().get(operationId))?.operation
    const details: Record<string, unknown> =
      operation?.details && typeof operation.details === 'object'
        ? (operation.details as Record<string, unknown>)
        : {}
    const targetMachineId = details.targetMachineId
    if (typeof targetMachineId !== 'string') return

    const failure = checkMachineVerb(
      principal,
      asMachineId(targetMachineId),
      await ownershipSnapshotFromMachines(modules.machines),
      'manage',
    )
    if (!failure) return
    throw new TRPCError({
      code: failure === 'absent' ? 'NOT_FOUND' : 'FORBIDDEN',
      message:
        failure === 'absent'
          ? `unknown machine '${targetMachineId}'`
          : `you cannot manage machine '${targetMachineId}'`,
    })
  }

  return {
    requireManageable,
    async cancel(operationId) {
      await requireManageable(operationId)
      return await engine().cancel(operationId)
    },
    async dispatchAction(operationId, actionId, options) {
      await requireManageable(operationId)
      return await engine().dispatchAction(operationId, actionId, dispatchActor, options)
    },
  }
}
