/**
 * ANSWERING AN AGENT'S QUESTION IS AN EFFECT RECORD (POD-6415, ADR 12 D5 E2 and
 * O3; decided on POD-6241).
 *
 * An answer is delivered to a running agent: digits typed at a live menu, a
 * reply over a protocol driver, or the answerer's own message when no menu is
 * up. That is work on a machine, so it has no place inside a request. It is a
 * one-off action of kind `session.answer`, one kind for every way Podium
 * answers, chosen by `via`:
 *
 *  - `menu`: `sessions.answerAskUserQuestion`'s choices for the live menu;
 *  - `interaction`: `interactions.answer` on a durable ask row (`text`, or an
 *    already-typed `answer`); the row's own claim-before-delivery order holds;
 *  - `issue`: the Tray's `issues.answerQuestion`, whose TARGET is the issue (its
 *    write gate, as before); the run is that command's own code, which reads
 *    the asking session the issue recorded and clears the question after the
 *    delivery;
 *  - `tool`: the superagent's `answer_question` tool, menu only.
 *
 * TARGET. A session the writer may type at: the command plane's own gate for
 * `sessions.answerAskUserQuestion` (the session is visible, machine `use`, the
 * issue scope). An `issue` answer names the issue, and the issue family decides.
 * The input must address the target (`admit`): an ask row of another session
 * reads as a missing one.
 *
 * NO READY GATE. The old routes delivered at once and answered what delivery
 * said (a session whose machine is away refuses there), so a record runs at once
 * too. DEADLINE: one minute, the contract's online-only rule. An answer typed
 * later would land on whatever menu is up by then.
 *
 * RUN: once per record id (the runner's claim), as the writer re-read NOW
 * ({@link writerPrincipalNow}) and re-gated on the target. A refusal is `failed`
 * with the old reply as its result, so the old routes answer unchanged.
 *
 * RECOVER (the server stopped mid-run): an ask row that shows the answer
 * delivered is `succeeded`; an ask row still open was never claimed, so nothing
 * was typed and it is safely `failed`; an issue whose question is cleared is
 * `succeeded`. Anything else is `unknown`: digits may or may not have been
 * typed, and the session is where to look.
 *
 * THE OLD ROUTES create the record through `sync.submit` as their caller and wait
 * for it ({@link answerThroughEffect}): `sessions.answerAskUserQuestion` (tRPC and
 * relay), `interactions.answer` (tRPC and CLI) and the superagent tool here;
 * `issues.answerQuestion` through the issue work-effect port.
 */

import { randomUUID } from 'node:crypto'
import { sessionCommandPlaneInputs } from '@podium/commands'
import {
  asIssueId,
  asMutationId,
  asUserId,
  type EffectTarget,
  mintDeviceId,
  parseSpawnedBy,
  type SessionId,
  type ThreadId,
  type UserId,
} from '@podium/model'
import type { InteractionAnswer } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { type CommandPrincipal, userCommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { EffectRow } from '../../store/effects'
import type { UsersRepository } from '../../store/users'
import type { EffectExecutor, EffectOutcome, EffectRunContext } from '../effects/registry'
import { WRITER_NO_LONGER_ALLOWED, writerPrincipalNow, writingAgentOf } from '../effects/writer'
import type { IssueCaller } from '../issues/command-ctx'
import { issueRegistry } from '../issues/registry'
import { issueTarget } from '../issues/sync-write'
import { issueCommandFailure } from '../issues/work-effects'
import { sessionCommandCtx } from '../sessions/command-ctx'
import {
  type AnswerChoice,
  type InboxPrincipalReference,
  inboxPrincipalFromCommand,
  SYSTEM_INBOX_PRINCIPAL,
} from '../sessions/inbox'
import { NO_TARGET, type SyncWriteTarget } from '../sync-write/registry'

export const SESSION_ANSWER_KIND = 'session.answer'

/** An answer that has not started by now would land on a later menu: unrun. */
export const SESSION_ANSWER_DEADLINE_MS = 60_000

/** How long an old route waits for its record to settle. */
export const SESSION_ANSWER_WAIT_MS = 60_000

const MenuAnswer = z
  .object({
    via: z.literal('menu'),
    interactionId: z.string().min(1).optional(),
    skip: z.literal(true).optional(),
    // Checked against the command plane's own schema at create (`admit`).
    choices: z.array(z.record(z.unknown())).min(1).optional(),
  })
  .strict()

const InteractionAnswerInput = z
  .object({
    via: z.literal('interaction'),
    interactionId: z.string().min(1),
    text: z.string().min(1).optional(),
    answer: z
      .object({ kind: z.string().min(1) })
      .passthrough()
      .optional(),
  })
  .strict()

const IssueAnswer = z.object({ via: z.literal('issue'), text: z.string().trim().min(1) }).strict()

const ToolAnswer = z.object({ via: z.literal('tool'), text: z.string().min(1) }).strict()

export const SessionAnswerInput = z.discriminatedUnion('via', [
  MenuAnswer,
  InteractionAnswerInput,
  IssueAnswer,
  ToolAnswer,
])
export type SessionAnswerInput = z.infer<typeof SessionAnswerInput>

/** The superagent tool's delivery: the menu-only answer path (answer-delivery.ts). */
export type DeliverMenuText = (input: {
  sessionId: SessionId
  answer: string
  principal: InboxPrincipalReference
}) => Promise<{ ok: true; choices: unknown; note?: string } | { ok: false; message: string }>

export interface SessionAnswerEffectDeps {
  modules(): RegistryModules
  /** The writer's account as it is now. */
  users: Pick<UsersRepository, 'get'>
  /** A superagent thread, for the reach of the session bound to it. */
  superagentThread(
    id: ThreadId,
  ): Promise<{ podiumSessionId?: SessionId | null; ownerUserId?: UserId | null } | undefined>
  deliverMenuText: DeliverMenuText
}

const failed = (code: string, message: string, result?: unknown): EffectOutcome => ({
  status: 'failed',
  error: { code, message },
  ...(result !== undefined ? { result } : {}),
})

const LOST_TRACK: EffectOutcome = {
  status: 'unknown',
  error: {
    code: 'lost-track',
    message:
      'The server stopped while the answer was being delivered; check the session before answering again.',
  },
}

const issueCaller = (principal: CommandPrincipal): IssueCaller | undefined =>
  principal.kind === 'system' ? undefined : { capability: principal.capability, principal }

/**
 * Whose reach an answer is gated on. A person's and an agent's own, except a
 * superagent: the session BOUND to a superagent thread acts with its owner's
 * reach (the tool belt reads sessions as the owner, `principalForTrustedUser`),
 * so its `answer_question` reaches what the owner may answer. A session the
 * superagent merely started carries the same `superagent:<thread>` tag but is
 * not the thread's binding, and keeps its own reach.
 */
async function answerReach(
  modules: RegistryModules,
  deps: Pick<SessionAnswerEffectDeps, 'users' | 'superagentThread'>,
  principal: CommandPrincipal,
): Promise<CommandPrincipal> {
  if (principal.kind !== 'agent') return principal
  const ref = parseSpawnedBy(
    (await modules.sessions.sessionById(principal.agentSessionId))?.spawnedBy,
  )
  if (ref?.kind !== 'superagent' || ref.threadId === undefined) return principal
  const thread = await deps.superagentThread(ref.threadId)
  if (thread?.podiumSessionId !== principal.agentSessionId) return principal
  if (thread.ownerUserId !== principal.onBehalfOf) return principal
  const owner = await deps.users.get(thread.ownerUserId)
  if (!owner || owner.disabledAt) return principal
  return userCommandPrincipal(asUserId(owner.id), owner.role)
}

/** A session this principal may type at, by its full id (the plane's gate). */
async function sessionAnswerTarget(
  modules: RegistryModules,
  deps: Pick<SessionAnswerEffectDeps, 'users' | 'superagentThread'>,
  sessionId: string,
  writer: CommandPrincipal,
): Promise<SyncWriteTarget> {
  if (writer.kind === 'system') return undefined
  const principal = await answerReach(modules, deps, writer)
  if (principal.kind === 'system') return undefined
  const plane = await sessionCommandCtx(modules, principal.capability, false, 'trpc')
  try {
    const row = await plane.target(sessionId as SessionId, 'sessions.answerAskUserQuestion')
    return row?.sessionId === sessionId ? NO_TARGET : undefined
  } catch {
    return undefined
  }
}

/** The record's target, decided for `principal`: the issue family for an issue, the plane otherwise. */
async function answerTarget(
  modules: RegistryModules,
  deps: Pick<SessionAnswerEffectDeps, 'users' | 'superagentThread'>,
  target: EffectTarget,
  principal: CommandPrincipal,
): Promise<SyncWriteTarget> {
  if (target.kind === 'issue') {
    const caller = issueCaller(principal)
    if (caller === undefined) return undefined
    return await issueTarget(modules, issueRegistry.defs.answerQuestion, { id: target.id }, caller)
  }
  if (target.kind !== 'session') return undefined
  return await sessionAnswerTarget(modules, deps, target.id, principal)
}

export function registerSessionAnswerEffect(deps: SessionAnswerEffectDeps): void {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('session answer: no effects module')

  const run = async (ctx: EffectRunContext<SessionAnswerInput>): Promise<EffectOutcome> => {
    const modules = deps.modules()
    const { record, input } = ctx
    const writer = await writerPrincipalNow(modules, deps.users, record)
    const allowed = writer && (await answerTarget(modules, deps, record.target, writer))
    if (writer === undefined || allowed === undefined || writer.kind === 'system') {
      return failed('unauthorized', WRITER_NO_LONGER_ALLOWED)
    }
    const sessionId = record.target.id as SessionId
    switch (input.via) {
      case 'menu': {
        const outcome = await modules.sessions.answerAskUserQuestion({
          sessionId,
          ...(input.interactionId !== undefined ? { interactionId: input.interactionId } : {}),
          ...(input.choices !== undefined ? { choices: input.choices as AnswerChoice[] } : {}),
          ...(input.skip === true ? { skip: true } : {}),
          principal: inboxPrincipalFromCommand(writer),
        })
        return outcome.ok
          ? { status: 'succeeded', result: outcome }
          : failed('not-delivered', outcome.reason ?? 'the answer was not delivered', outcome)
      }
      case 'interaction': {
        const outcome = await modules.interactions.answer({
          id: input.interactionId,
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.answer !== undefined
            ? { answer: input.answer as unknown as InteractionAnswer }
            : {}),
          answeredBy: 'human',
          // The delivery's own principal, as the route always passed it; WHO
          // answered is the record's writer.
          principal: SYSTEM_INBOX_PRINCIPAL,
        })
        return outcome.ok
          ? { status: 'succeeded', result: outcome }
          : failed(outcome.reason, outcome.detail ?? outcome.reason, outcome)
      }
      case 'issue': {
        const caller = issueCaller(writer)
        if (caller === undefined) return failed('unauthorized', WRITER_NO_LONGER_ALLOWED)
        try {
          const result = await modules.issueCommands
            .forEffectRun()
            .run(caller, 'answerQuestion', issueRegistry.defs.answerQuestion, {
              id: asIssueId(record.target.id),
              answer: input.text,
            })
          return { status: 'succeeded', result }
        } catch (error) {
          return issueCommandFailure(error)
        }
      }
      case 'tool': {
        // Attributed as the tool always was: the superagent's own session.
        const agent = writingAgentOf(record)
        const outcome = await deps.deliverMenuText({
          sessionId,
          answer: input.text,
          principal:
            (agent !== undefined
              ? await modules.sessions.inboxPrincipalForSession(agent)
              : undefined) ?? inboxPrincipalFromCommand(writer),
        })
        return outcome.ok
          ? { status: 'succeeded', result: outcome }
          : failed('not-delivered', outcome.message, outcome)
      }
    }
  }

  const recover = async (ctx: EffectRunContext<SessionAnswerInput>): Promise<EffectOutcome> => {
    const modules = deps.modules()
    const { input, record } = ctx
    if (input.via === 'interaction') {
      const row = await modules.interactions.get(input.interactionId)
      if (row?.status === 'asked') {
        return failed(
          'interrupted',
          'The server restarted before the answer was sent; nothing was typed.',
        )
      }
      if (row?.status === 'answered' && row.deliveredVia !== 'unverified') {
        return { status: 'succeeded', result: { ok: true } }
      }
      return LOST_TRACK
    }
    if (input.via === 'issue') {
      const issue = await modules.issues.reports.getMeta(record.target.id)
      return issue !== undefined && issue !== null && !issue.needsHuman
        ? { status: 'succeeded', result: { issue } }
        : LOST_TRACK
    }
    return LOST_TRACK
  }

  const executor: EffectExecutor<SessionAnswerInput> = {
    kind: SESSION_ANSWER_KIND,
    input: SessionAnswerInput,
    deadlineMs: SESSION_ANSWER_DEADLINE_MS,
    target: async (target, principal) =>
      await answerTarget(deps.modules(), deps, target, principal),
    admit: async (input, target) => {
      if ((input.via === 'issue') !== (target.kind === 'issue')) {
        return {
          kind: 'invalid',
          message: 'an issue answer names its issue; any other names a session',
        }
      }
      if (input.via === 'menu') {
        const parsed = sessionCommandPlaneInputs.answerAskUserQuestion.safeParse({
          sessionId: target.id,
          ...input,
          via: undefined,
        })
        if (!parsed.success) {
          return { kind: 'invalid', details: parsed.error.issues.map((issue) => issue.message) }
        }
      }
      if (input.via === 'interaction') {
        if ((input.text === undefined) === (input.answer === undefined)) {
          return {
            kind: 'invalid',
            message: 'answer takes exactly one of `text` or `answer`',
          }
        }
        // An ask of another session fails as a missing one (no existence oracle).
        const row = await deps.modules().interactions.get(input.interactionId)
        if (row?.sessionId !== target.id) return { kind: 'target-not-found' }
      }
      return undefined
    },
    // The feed shows how it was answered, never the answer.
    publish: (input) => ({
      via: input.via,
      ...('interactionId' in input && input.interactionId !== undefined
        ? { interactionId: input.interactionId }
        : {}),
    }),
    run,
    recover,
  }
  effects.executors.register(executor)
}

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
