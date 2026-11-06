/**
 * THE DERIVED INTERACTION SURFACE — `answer` from `INTERACTION_COMMANDS_TRPC`,
 * `list` and `forSession` from `INTERACTION_QUERIES`.
 *
 * Three lines of declaration, because the shape lives in
 * `modules/derived-family.ts` and this family differs from its siblings in
 * exactly three respects: which contract table, which service, which query
 * table. Everything that file's header claims — default-closed exposure,
 * both-directions membership checked at module load, output types read off the
 * joined handler so `AppRouter` inference survives — applies here and is not
 * restated.
 */

import type { InteractionAnswerOutcome } from '@podium/protocol'
import { derivedFamilyProcedures, type FamilyProcedures, type FamilyState } from '../derived-family'
import { answerThroughEffect, settledResult } from './answer-effect'
import { INTERACTION_QUERIES } from './queries'
import { INTERACTION_COMMANDS_TRPC } from './registry'
import type { AnswerInput, InteractionService } from './service'

/**
 * `interactions.answer` as a `session.answer` effect record (POD-6415), as the
 * caller: the route never claims or delivers itself. The reads are the service's
 * own. An ask of a session out of this caller's reach answers as a missing one.
 */
async function answerAs(
  state: FamilyState,
  input: AnswerInput,
): Promise<InteractionAnswerOutcome & { detail?: string }> {
  const row = await state.modules.interactions.get(input.id)
  if (!row) return { ok: false, reason: 'unknown-interaction' }
  const settled = await answerThroughEffect(
    state.modules,
    state.principal,
    { kind: 'session', id: row.sessionId },
    {
      via: 'interaction',
      interactionId: input.id,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.answer !== undefined
        ? { answer: input.answer as unknown as { kind: string } & Record<string, unknown> }
        : {}),
    },
  )
  if (settled.kind === 'refused') return { ok: false, reason: 'unknown-interaction' }
  const answer = settledResult(settled)
  return 'result' in answer
    ? (answer.result as InteractionAnswerOutcome & { detail?: string })
    : { ok: false, reason: 'delivery-failed', detail: answer.message }
}

/** The service, with its one write answered through the effect path. */
const interactionsAs = (state: FamilyState): InteractionService =>
  Object.assign(Object.create(state.modules.interactions) as InteractionService, {
    answer: async (input: AnswerInput) => await answerAs(state, input),
  })

export type InteractionProcedures = FamilyProcedures<
  typeof INTERACTION_COMMANDS_TRPC,
  typeof INTERACTION_QUERIES
>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `interactions` router. */
export const interactionFamilyProcedures = (): InteractionProcedures =>
  derivedFamilyProcedures({
    family: 'interactions',
    service: interactionsAs,
    commands: INTERACTION_COMMANDS_TRPC,
    queries: INTERACTION_QUERIES,
  })
