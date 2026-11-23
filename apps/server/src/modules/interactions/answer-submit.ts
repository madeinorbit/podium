/** Submission is independent of effect execution and target authorization. */
import { randomUUID } from 'node:crypto'
import { asMutationId, type EffectTarget, mintDeviceId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { EffectRow } from '../../store/effects'
import type { SessionAnswerInput } from './answer-effect'

export const SESSION_ANSWER_KIND = 'session.answer'
export const SESSION_ANSWER_WAIT_MS = 60_000

/** A settled (or not) answer record, as the old routes read it. */
export type AnswerSettled =
  | { kind: 'refused'; refusal: import('@podium/protocol').SyncSubmitRefusal }
  | { kind: 'settled'; row: EffectRow | undefined; id: string }

/**
 * Answer through the effect path, as `principal`: create a `session.answer`
 * record through `sync.submit` and wait for it to settle. Each old route reads
 * its own reply shape off the result.
 */
export async function answerThroughEffect(
  modules: RegistryModules,
  principal: CommandPrincipal,
  target: EffectTarget,
  input: SessionAnswerInput,
  opts: { mutationId?: string; confirmed?: boolean } = {},
): Promise<AnswerSettled> {
  const effects = modules.effects
  if (effects === undefined) throw new Error('answers: no effects module is composed')
  const id = mintDeviceId('eff_')
  const { reply, cause } = await modules.syncWrite.submitDetailed(
    {
      mutationId: asMutationId(opts.mutationId ?? `mut_answer_${randomUUID()}`),
      command: 'effects.create',
      version: 1,
      input: { id, kind: SESSION_ANSWER_KIND, target, input },
      ...(opts.confirmed === true ? { confirmed: true as const } : {}),
    },
    principal,
    // An agent reaches these over the daemon relay; a person over tRPC.
    principal.kind === 'agent' ? 'relay' : 'trpc',
  )
  if (reply.outcome !== 'applied') {
    if (cause !== undefined) throw cause
    return { kind: 'refused', refusal: reply.refusal }
  }
  return { kind: 'settled', id, row: await effects.awaitSettled(id, SESSION_ANSWER_WAIT_MS) }
}

/** The record's own answer (its result), or what to say when there is none. */
export function settledResult(settled: AnswerSettled): { result: unknown } | { message: string } {
  if (settled.kind === 'refused') {
    return {
      message: settled.refusal.message ?? `the answer was refused (${settled.refusal.kind})`,
    }
  }
  const row = settled.row
  if (row?.result !== undefined && row.result !== null) return { result: row.result }
  if (row?.status === 'failed' || row?.status === 'unknown' || row?.status === 'expired') {
    return { message: row.error?.message ?? `the answer ${row.status}` }
  }
  return {
    message: `the answer is ${row?.status ?? 'still pending'} as effect ${settled.id}; it was not confirmed in time`,
  }
}

/** A refusal at create, as the old tRPC routes threw it. */
export const answerRefusalError = (
  command: string,
  settled: AnswerSettled,
): TRPCError | undefined =>
  settled.kind === 'refused'
    ? new TRPCError({
        code: settled.refusal.kind === 'target-not-found' ? 'NOT_FOUND' : 'FORBIDDEN',
        message: settled.refusal.message ?? `${command} was refused`,
      })
    : undefined
