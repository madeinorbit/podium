/**
 * THE JOIN (PDM-297) — the three operation write contracts (L1) paired with the
 * engine calls that implement them (L3), per ADR 3 D1, and the two reads that
 * are deliberately NOT contracts.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG, AND WHY IT WAS INVISIBLE
 * ---------------------------------------------------------------------------
 *
 * `modules/operations/trpc.ts` hand-wrote five procedures and imported no
 * contract. `OPERATION_CONTRACTS` existed, all three entries declared
 * `exposure: ['trpc']` and a `roleFloor`, and NOTHING COMPARED THE TWO. The
 * consequence is the reason this is its own issue rather than a line in a
 * role-floor census: the contract could have declared the command served
 * NOWHERE and the server would have kept serving it, because the instruments
 * the epic relies on for exposure — the totality tests, the census, the
 * deferred-capability mechanism — are all defined over contracts that are
 * JOINED to their procedures. An unjoined contract is not merely unenforced; it
 * is unseen, and every instrument reports green.
 *
 * That was measured before it was fixed rather than argued from the shape.
 * Planting `exposure: ['mcp']` on `operations.cancel` — the contract saying "not
 * served on tRPC" while the router served it on tRPC — reddened NOTHING: the
 * `@podium/commands` suite and the server `services` shard both came back with
 * exactly their pre-existing failures and `operations/trpc.test.ts` passed in
 * full. `exposure: SERVED_NOWHERE` reddened only the generic dead-weight lint in
 * `classification-totality.test.ts`, which fires on the empty-array SHAPE and
 * never consults a router, so the procedure kept serving either way.
 *
 * With this table in place the same plant fails at MODULE LOAD, by name, out of
 * `assertSurfaceMatchesDeclarations` — "operations.cancel: the derived router
 * serves it, but its contract does not declare trpc exposure" — because the
 * family now goes through the one builder that checks membership in both
 * directions against the object it will actually serve.
 *
 * ---------------------------------------------------------------------------
 * WHY THE READS ARE NOT CONTRACTS
 * ---------------------------------------------------------------------------
 *
 * `active` and `history` are `DerivedQuery` entries, not `CommandContract`s, for
 * the reason `workflows/queries.ts` gives: a `visibility` class describes what a
 * command WRITES, and a read writes nothing. They are declared here anyway, with
 * their transports, so the same both-directions check covers them — a read that
 * stopped being served fails exactly as a write would.
 *
 * `active` SERVES THE STORED BYTES and this table does not re-shape them, which
 * is the frozen contract (P8) `trpc.ts` argued at length and this file inherits:
 * the web bundle is swapped during the operation it is rendering, so a server
 * must be able to hand an old bundle a field it has never heard of. `history`
 * likewise parses the stored payload and hands it on.
 */

import type { DerivedCommand, DerivedQuery } from '../derived-family'
import {
  type AnyCommandContract,
  OPERATION_CONTRACTS,
  type OperationContractName,
  registryClassificationErrors,
  type TransportTag,
} from '@podium/commands'
import { z } from 'zod'
import type { RegistryModules } from '../../relay'
import type { OperationEngine } from './engine'
import type { OperationTargetGate } from './operation-target-gate'

/**
 * Exactly what the operation family reaches, named.
 *
 * THE ENGINE IS HERE FOR THE READS ONLY. Every WRITE goes through `targets`,
 * which is the same engine with this caller's gate in front of it — so a handler
 * cannot reach an ungoverned `cancel` or `dispatchAction` by accident, because
 * the ungoverned ones are not on the object it is handed for those commands.
 */
export interface OperationState {
  readonly engine: OperationEngine
  readonly targets: OperationTargetGate
}

export type OperationCommand = DerivedCommand<OperationState>

/**
 * THE TABLE. `satisfies Record<OperationContractName, OperationCommand>` is the
 * join itself and it is checked BOTH WAYS by the compiler: a contract with no
 * entry here fails to satisfy the `Record`, and an entry naming a command that
 * is not an `OperationContractName` fails as an excess property. A fourth
 * operation command cannot be served without a contract, and a contract cannot
 * be retired while a handler still implements it.
 */
export const OPERATION_COMMANDS_TRPC = {
  cancel: {
    contract: OPERATION_CONTRACTS.cancel,
    handler: (async (state, input) =>
      await state.targets.cancel(input.id)) satisfies OperationCommand['handler'],
  },
  settleAsk: {
    contract: OPERATION_CONTRACTS.settleAsk,
    handler: (async (state, input) =>
      await state.targets.dispatchAction(input.id, input.actionId, {
        settleAsk: true,
      })) satisfies OperationCommand['handler'],
  },
  action: {
    contract: OPERATION_CONTRACTS.action,
    handler: (async (state, input) =>
      await state.targets.dispatchAction(input.id, input.actionId, {
        settleAsk: false,
      })) satisfies OperationCommand['handler'],
  },
} as const satisfies Record<OperationContractName, OperationCommand>

export type OperationCommandName = keyof typeof OPERATION_COMMANDS_TRPC

/** The two reads. Declared with their transports so the builder's
 *  both-directions check covers them alongside the writes. */
export const OPERATION_QUERIES = {
  active: {
    input: z.object({ group: z.string().optional() }).optional(),
    exposure: ['trpc'] as readonly TransportTag[],
    run: (async (state: OperationState, input: { group?: string } | undefined) => {
      const row = await state.engine.active(input?.group)
      return row ? await state.engine.project(row) : null
    }),
  },
  history: {
    input: z
      .object({
        kind: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .optional(),
    exposure: ['trpc'] as readonly TransportTag[],
    run: (async (
      state: OperationState,
      input: { kind?: string; limit?: number } | undefined,
    ) =>
      (await state.engine.history(input?.kind, input?.limit)).map(
        (row) => JSON.parse(row.payload) as unknown,
      )),
  },
} as const satisfies Record<string, DerivedQuery<OperationState>>

export const isOperationCommand = (name: string): name is OperationCommandName =>
  Object.hasOwn(OPERATION_COMMANDS_TRPC, name)

/** ADR 3 D3, default-closed. */
export function isOperationCommandExposedOn(name: string, transport: TransportTag): boolean {
  if (!isOperationCommand(name)) return false
  const contract: AnyCommandContract = OPERATION_COMMANDS_TRPC[name].contract
  return contract.exposure.includes(transport)
}

export const operationRegistryClassificationErrors = (): string[] =>
  registryClassificationErrors(
    Object.values(OPERATION_COMMANDS_TRPC).map((c) => c.contract as AnyCommandContract),
  )

/** Bundle used by `operationFamilyProcedures` — keeps the selector in one place. */
export function selectOperationState(
  modules: RegistryModules,
  targets: OperationTargetGate,
): OperationState {
  return { engine: modules.operations.engine, targets }
}
