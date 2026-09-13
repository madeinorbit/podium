/**
 * THE JOIN (PDM-308) — the one feed-cursor write contract (L1) paired with the
 * service call that implements it (L3), per ADR 3 D1, and the one read that is
 * deliberately not a contract.
 *
 * The defect, the measurement and the reason the gate did not fold into the
 * contract's declared floor are written once, in `modules/layout/registry.ts`
 * and `modules/per-user-actor-gate.ts`, because this family is the same shape
 * for the same reason and two statements of one argument is how the two come to
 * disagree.
 *
 * WHAT IS WORTH SAYING HERE is the half that is sharper in this family than in
 * `layout`. `read-position` had NO contracts test at all — nothing anywhere
 * restated its declared transports — so the plant that reddened one hand-written
 * assertion over in `packages/commands/src/layout/contracts.test.ts` reddened
 * NOTHING here, in either package, in either direction. `readPosition.advance`
 * could declare `exposure: ['mcp']`, or `SERVED_NOWHERE`, and every lane stayed
 * green while `router.ts` kept serving it on tRPC.
 *
 * `advance` IS THE ONLY WRITE, because a cursor has one verb, and the contract
 * declares `exposure: ['trpc']` alone — deliberately NOT on the Outbox, which
 * its own header argues at length: a position names an event id that can only
 * have been learned from a live read of the same log, so there is no offline
 * advance to queue. That declaration is now CHECKED rather than merely written:
 * the builder serves this family on tRPC because the contract says tRPC, and
 * would refuse to assemble if the two disagreed.
 */

import {
  type ReadPositionContractName,
  readPositionAdvanceContract,
  type TransportTag,
} from '@podium/commands'
import { z } from 'zod'
import type { RegistryModules } from '../../relay'
import type { DerivedCommand, DerivedQuery } from '../derived-family'
import type { PerUserActorGate } from '../per-user-actor-gate'

/**
 * Exactly what the feed-cursor family reaches, named. `actors` is the pre-bound
 * gate — see `../per-user-actor-gate.ts`.
 */
export interface ReadPositionState {
  readonly readPosition: RegistryModules['readPosition']
  readonly actors: PerUserActorGate
}

export type ReadPositionCommand = DerivedCommand<ReadPositionState>

/** See `layout/registry.ts` — the contracts table is keyed by QUALIFIED name
 *  while the router key is the bare verb, so the prefix is stripped in the type
 *  rather than the verb being retyped. */
type ReadPositionProcedureName = ReadPositionContractName extends `readPosition.${infer Verb}`
  ? Verb
  : never

const nowIso = (): string => new Date().toISOString()

/** THE TABLE, checked both ways by the compiler. */
export const READ_POSITION_COMMANDS_TRPC = {
  advance: {
    contract: readPositionAdvanceContract,
    handler: (async (state, input) => {
      const actor = await state.actors.requireActor(readPositionAdvanceContract.name)
      return await state.readPosition.advance(
        actor,
        input.streamId,
        { lastEventId: input.lastEventId, seenAt: input.seenAt ?? null },
        nowIso(),
      )
    }) satisfies ReadPositionCommand['handler'],
  },
} as const satisfies Record<ReadPositionProcedureName, ReadPositionCommand>

export type ReadPositionCommandName = keyof typeof READ_POSITION_COMMANDS_TRPC

/** The one read, declared with its transport so the both-directions check
 *  covers it. Gated identically to the write: a read position is per-user
 *  state, so "who may see it" and "who may move it" are one question. */
export const READ_POSITION_QUERIES = {
  get: {
    input: z.void(),
    exposure: ['trpc'] as readonly TransportTag[],
    run: async (state: ReadPositionState) => {
      const actor = await state.actors.requireActor(readPositionAdvanceContract.name)
      return await state.readPosition.getSnapshot(actor)
    },
  },
} as const satisfies Record<string, DerivedQuery<ReadPositionState>>

/** Bundle used by `readPositionFamilyProcedures` — the selector in one place. */
export function selectReadPositionState(
  modules: RegistryModules,
  actors: PerUserActorGate,
): ReadPositionState {
  return { readPosition: modules.readPosition, actors }
}
