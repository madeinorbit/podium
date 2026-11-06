/**
 * INTERRUPT NAMES THE TURN IT IS FOR (POD-6397, ADR 12 D5 E2 / O2).
 *
 * Pressing Stop is an effect record of kind `session.interrupt`, its target the
 * session, its input the turn the person saw running (`turn`: the session's
 * `agentState.turnStartedAt`). It ends when THAT turn ends, so every device
 * shows "Interrupting…" until the agent has actually stopped, and a Stop that
 * arrives late never stops the next turn:
 *
 *  - IT ALWAYS ASKS, carrying the turn. The DAEMON owns the turn marker and is
 *    the only judge of agent state, so it alone says whether that turn is over:
 *    over, it stops nothing and answers `turn_ended`, recorded as `succeeded`
 *    with `ended: 'already'`. The server never skips the request on its own
 *    stored copy of the state. A daemon from before the marker drops the turn
 *    and stops whatever turn runs, as the old route did.
 *  - ASKED, it waits for the turn to end (as the daemon reports it): `succeeded`.
 *    A named turn pulls back only a send it names: the head of the queue may be
 *    the next turn's message.
 *  - A REFUSED request is `failed` with the driver's own reason.
 *  - PAST ITS DEADLINE ({@link SESSION_INTERRUPT_DEADLINE_MS} from the press,
 *    the record's own `deadline`, so every device knows when it comes) the turn
 *    still runs: `failed` with code `deadline`, and the app offers Kill
 *    (POD-6356's desired `stopped` with `force`). A Stop the server could not
 *    even start by then expires unrun, which the app reads the same way.
 *  - A shell has no turns to observe: the keystroke is the whole effect.
 *  - RECOVER (the server stopped while it waited): the turn ended → `succeeded`;
 *    it still runs → `failed`. Saying so is safe: asking again is harmless.
 *
 * WAITING. The run subscribes to the session's state changes and exits BEFORE
 * it sends the stop, so an end that commits in between is not missed, and
 * re-reads the session on a slow tick in case a state sink does not publish.
 * What it reads is the daemon's report, marker included; it only records.
 */

import { randomUUID } from 'node:crypto'
import {
  actorAgent,
  actorSystem,
  actorUser,
  asAgentIdentityId,
  asMutationId,
  type EffectTarget,
  hasTurnEnded,
  mintDeviceId,
  SESSION_INTERRUPT_KIND,
  type SessionId,
  type SessionMeta,
  type UserId,
} from '@podium/model'
import { asDelegationRef } from '@podium/protocol'
import { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { EffectRow } from '../../store/effects'
import type { EffectExecutor, EffectOutcome, EffectRunContext } from '../effects/registry'
import { NO_TARGET } from '../sync-write/registry'
import { sessionCommandCtx } from './command-ctx'
import type { InboxPrincipalReference, InterruptOutcome } from './inbox'
import { isRunningStatus } from './session-record'

export { SESSION_INTERRUPT_KIND }

/** How long after the press the named turn has to end; then the app offers Kill. */
export const SESSION_INTERRUPT_DEADLINE_MS = 30_000

/** How often a wait re-reads the session besides its state events. */
const RECHECK_MS = 1_000

export const SessionInterruptInput = z.object({
  /** The turn the person saw (`agentState.turnStartedAt`); absent: the one running now. */
  turn: z.string().min(1).max(64).optional(),
  /** The send this stop retracts if it has not reached the agent (the old route's). */
  messageId: z.string().min(1).max(200).optional(),
})
export type SessionInterruptInput = z.infer<typeof SessionInterruptInput>

export interface SessionInterruptEffectDeps {
  modules(): RegistryModules
  /** The server's clock, which the record's deadline is on. */
  now(): number
  recheckMs?: number
}

/** The ways an interrupt can end, as its record's `result.ended`. */
export type InterruptEnded = 'already' | 'stopped' | 'requested'

/** The delivery the stop took, kept in process for the old route (bounded). */
const RECENT_REQUESTS = 256

export interface SessionInterruptsHandle {
  /**
   * How the stop of an interrupt this process runs was delivered, once it was
   * asked for: the old route answers then, not when the turn ends. Never
   * resolves for a run that sent nothing (its record settles instead).
   */
  requested(effectId: string): Promise<InterruptOutcome>
}

export function registerSessionInterruptEffect(
  deps: SessionInterruptEffectDeps,
): SessionInterruptsHandle {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('session interrupt: no effects module')
  const recheckMs = deps.recheckMs ?? RECHECK_MS
  const requests = new Map<string, InterruptOutcome>()
  const waiters = new Map<string, Set<(outcome: InterruptOutcome) => void>>()
  const remember = (id: string, outcome: InterruptOutcome) => {
    requests.set(id, outcome)
    if (requests.size > RECENT_REQUESTS) {
      const oldest = requests.keys().next().value
      if (oldest !== undefined) requests.delete(oldest)
    }
    for (const resolve of waiters.get(id) ?? []) resolve(outcome)
    waiters.delete(id)
  }
  const requested = (id: string): Promise<InterruptOutcome> => {
    const known = requests.get(id)
    if (known !== undefined) return Promise.resolve(known)
    return new Promise((resolve) => {
      const set = waiters.get(id) ?? new Set()
      waiters.set(id, set)
      set.add(resolve)
    })
  }

  const read = async (sessionId: SessionId): Promise<SessionMeta | undefined> =>
    await deps.modules().sessions.sessionById(sessionId)

  /**
   * Has the named turn ended, as the server sees the session now? A session
   * that has reported no state yet cannot say: not ended.
   */
  const ended = (session: SessionMeta | undefined, turn: string | undefined): boolean => {
    if (session === undefined || !isRunningStatus(session.status)) return true
    return session.agentState !== undefined && hasTurnEnded(session.agentState, turn)
  }

  /**
   * Resolves `true` once the named turn has ended, `false` at `deadlineAt` (on
   * the server's clock) or on cancel. Subscribed at once: call it BEFORE the
   * stop is sent.
   */
  const watchTurnEnd = (
    sessionId: SessionId,
    turn: string | undefined,
    deadlineAt: number,
    signal: AbortSignal,
  ) => {
    const { bus } = deps.modules()
    let settle: (value: boolean) => void = () => undefined
    const done = new Promise<boolean>((resolve) => {
      settle = resolve
    })
    const check = () => {
      if (deps.now() >= deadlineAt) return settle(false)
      void read(sessionId).then(
        (session) => {
          if (ended(session, turn)) settle(true)
        },
        () => undefined,
      )
    }
    const offState = bus.on('session.stateChanged', (event) => {
      if (event.sessionId !== sessionId) return
      if (hasTurnEnded(event.next, turn)) settle(true)
      else check()
    })
    const offExit = bus.on('session.exited', (event) => {
      if (event.sessionId === sessionId) settle(true)
    })
    const tick = setInterval(check, recheckMs)
    tick.unref?.()
    const onAbort = () => settle(false)
    signal.addEventListener('abort', onAbort, { once: true })
    return {
      ended: async (): Promise<boolean> => {
        const timer = setTimeout(() => settle(false), Math.max(0, deadlineAt - deps.now()))
        timer.unref?.()
        try {
          return await done
        } finally {
          clearTimeout(timer)
        }
      },
      dispose: () => {
        offState()
        offExit()
        clearInterval(tick)
        signal.removeEventListener('abort', onAbort)
        settle(false)
      },
    }
  }

  /**
   * The run cannot wait any longer (the server stopped): the turn ended →
   * `succeeded`; it still runs → `failed`, which is safe to say because asking
   * again is harmless.
   */
  const settleNow = async (ctx: EffectRunContext<SessionInterruptInput>): Promise<EffectOutcome> =>
    ended(await read(ctx.record.target.id as SessionId), ctx.input.turn)
      ? { status: 'succeeded', result: { ended: 'stopped' } }
      : {
          status: 'failed',
          error: {
            code: 'interrupted',
            message:
              'The server restarted while waiting for the agent to stop; it is still working.',
          },
        }

  const run = async (ctx: EffectRunContext<SessionInterruptInput>): Promise<EffectOutcome> => {
    const sessionId = ctx.record.target.id as SessionId
    const { turn, messageId } = ctx.input
    const before = await read(sessionId)
    // A shell has no observed turns: the keystroke (or the retraction) is all.
    const observable = before?.agentKind !== 'shell'
    const deadlineAt = ctx.record.deadlineAt ?? deps.now() + SESSION_INTERRUPT_DEADLINE_MS
    const watch = watchTurnEnd(sessionId, turn, deadlineAt, ctx.signal)
    try {
      const outcome = await deps.modules().sessions.interruptTurn({
        sessionId,
        ...(messageId ? { sourceMessageId: messageId } : {}),
        ...(turn !== undefined ? { turn } : {}),
        principal: inboxPrincipalOf(ctx.record),
      })
      remember(ctx.record.id, outcome)
      if (!outcome.ok) {
        // The daemon's word: the named turn was over, nothing was stopped.
        if (outcome.turnEnded) return alreadyEnded()
        return {
          status: 'failed',
          error: { code: 'refused', message: outcome.reason },
        }
      }
      // Pulling a send back stopped nothing that runs; a shell shows no turn.
      if (!observable || outcome.requested === 'retraction') {
        return { status: 'succeeded', result: { ended: 'requested', requested: outcome.requested } }
      }
      await ctx.stage('interrupting')
      if (await watch.ended()) {
        return { status: 'succeeded', result: { ended: 'stopped', requested: outcome.requested } }
      }
      if (ctx.signal.aborted) {
        // Aborted by a cancel, or by the server stopping: then say what is true.
        return (await ctx.cancelRequested()) ? { status: 'cancelled' } : await settleNow(ctx)
      }
      const seconds = Math.round((deadlineAt - ctx.record.createdAt) / 1000)
      return {
        status: 'failed',
        error: { code: 'deadline', message: `The agent did not stop within ${seconds} s.` },
      }
    } finally {
      watch.dispose()
    }
  }

  const executor: EffectExecutor<SessionInterruptInput> = {
    kind: SESSION_INTERRUPT_KIND,
    input: SessionInterruptInput,
    deadlineMs: SESSION_INTERRUPT_DEADLINE_MS,
    /** A session this caller may command (`sessions.interrupt`), by its full id. */
    target: async (target: EffectTarget, principal: CommandPrincipal) => {
      if (principal.kind === 'system' || target.kind !== 'session') return undefined
      const plane = await sessionCommandCtx(deps.modules(), principal.capability, false, 'trpc')
      try {
        const row = await plane.target(target.id as SessionId, 'sessions.interrupt')
        return row?.sessionId === target.id ? NO_TARGET : undefined
      } catch {
        return undefined
      }
    },
    run,
    recover: settleNow,
  }
  effects.executors.register(executor)

  return { requested }
}

const alreadyEnded = (): EffectOutcome => ({ status: 'succeeded', result: { ended: 'already' } })

/** Who pressed Stop, as the inbox attributes the keystroke it may type. */
function inboxPrincipalOf(record: EffectRow): InboxPrincipalReference {
  const agent = record.actor?.startsWith('session:')
    ? record.actor.slice('session:'.length)
    : undefined
  const onBehalfOf = record.createdBy as UserId | null
  if (agent !== undefined) {
    return {
      kind: 'agent',
      attribution: { actor: actorAgent(asAgentIdentityId(agent)), onBehalfOf },
      principalRef: agent,
      delegation: asDelegationRef(agent),
    }
  }
  if (onBehalfOf !== null) {
    return {
      kind: 'user',
      attribution: { actor: actorUser(onBehalfOf), onBehalfOf },
      principalRef: onBehalfOf,
      delegation: null,
    }
  }
  return {
    kind: 'system',
    attribution: { actor: actorSystem('session.interrupt'), onBehalfOf: null },
    principalRef: 'session.interrupt',
    delegation: null,
  }
}

/** How long the old route waits for the stop to be asked for. */
export const SESSION_INTERRUPT_WAIT_MS = 15_000

/** The old route's refusal when no turn was running to stop. */
export const NO_TURN_RUNNING = 'no turn is running'

/**
 * `sessions.interrupt` through the effect path, as its caller (POD-6397):
 * create a `session.interrupt` record naming whatever turn runs now, and answer
 * the old shape once the stop has been asked for, or once the record ended
 * without one. It never interrupts directly (POD-6416): a refused record is
 * answered in the route's `{ ok: false, reason }` shape.
 */
export async function interruptThroughEffect(
  modules: RegistryModules,
  principal: CommandPrincipal,
  interrupts: SessionInterruptsHandle,
  input: { sessionId: SessionId; messageId?: string },
): Promise<InterruptOutcome> {
  const effects = modules.effects
  if (effects === undefined) throw new Error('sessions.interrupt: no effects module is composed')
  if (principal.kind === 'system') return { ok: false, reason: 'unknown session' }
  const id = mintDeviceId('eff_')
  const { reply, cause } = await modules.syncWrite.submitDetailed(
    {
      mutationId: asMutationId(`mut_interrupt_${randomUUID()}`),
      command: 'effects.create',
      version: 1,
      input: {
        id,
        kind: SESSION_INTERRUPT_KIND,
        target: { kind: 'session', id: input.sessionId },
        input: input.messageId ? { messageId: input.messageId } : {},
      },
    },
    principal,
    'trpc',
  )
  if (reply.outcome !== 'applied') {
    if (cause !== undefined) throw cause
    // The route's gate passed on this full id a moment ago: an unauthorized
    // answer now is a session gone out of reach, which reads as an unknown one.
    if (reply.refusal.kind === 'unauthorized' || reply.refusal.kind === 'target-not-found') {
      return { ok: false, reason: 'unknown session' }
    }
    return { ok: false, reason: `the interrupt was refused (${reply.refusal.kind})` }
  }
  // Answer once the stop was asked for, or once the record ended without one.
  const settled = effects.awaitSettled(id, SESSION_INTERRUPT_WAIT_MS)
  const first = await Promise.race([
    interrupts.requested(id).then((outcome) => ({ outcome })),
    settled.then((row) => ({ row })),
  ])
  if ('outcome' in first && first.outcome.ok) return first.outcome
  // A refusal: the record says whether the turn had ended meanwhile.
  const row = 'row' in first ? first.row : await settled
  if (row?.status === 'succeeded') {
    const result = row.result as { ended?: string; requested?: string } | null
    if (result?.ended === 'already') return { ok: false, reason: NO_TURN_RUNNING }
    return { ok: true, requested: (result?.requested as 'protocol' | undefined) ?? 'protocol' }
  }
  if (row?.status === 'failed') {
    return { ok: false, reason: row.error?.message ?? 'the interrupt failed' }
  }
  return { ok: false, reason: `the interrupt is ${row?.status ?? 'unknown'}` }
}
