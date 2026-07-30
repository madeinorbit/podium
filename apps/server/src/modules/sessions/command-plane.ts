/**
 * COMMAND-PLANE HANDLERS (POD-381) — the L3 half of
 * `@podium/protocol`'s `session-command-plane.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CONTRACT OWNS AND WHAT THE HANDLER OWNS
 * ---------------------------------------------------------------------------
 *
 * The CONTRACT owns authz (its `policy`, enforced by the two gates below),
 * idempotency (whether a `mutationId` is honoured) and the envelope (the dotted
 * name every receipt is recorded under). The HANDLER owns only the daemon
 * control leg: it calls `SessionsService` and returns what the service returns.
 *
 * That split is why the two transports stop diverging. Today `sessions.sendText`
 * is authorized one way on tRPC (operator, no gate at all) and another way in
 * `relay.ts` (a hand-written subtree check with its own strings), and the
 * idempotency wrapper is applied in two places under two spellings of the proc
 * name. Both now call {@link dispatchSessionCommand}; the gates run once, and a
 * third transport cannot forget either of them.
 *
 * ---------------------------------------------------------------------------
 * BEHAVIOUR PRESERVATION
 * ---------------------------------------------------------------------------
 *
 * Every not-found shape stays as POD-379's oracle pinned it — a silent no-op for
 * `kill`, `{ok:false, reason:'unknown session'}` for the lifecycle primitives, a
 * `dead_letter` disposition for the tRPC sends, a thrown `session not found` for
 * a relayed send, a bare `{ok:false}` for `answer` and `continue`. What changed
 * is that the question "is this target addressable at all" is now asked ONCE, in
 * `session-access.ts`, so an invisible id and a nonexistent id reach the same
 * answer by the same path instead of by two coincidences.
 */

import type { AgentKind, IssueId } from '@podium/model'
import type { CommandDef } from '@podium/protocol'
import { sessionCommandPlane, sessionCommandPlaneInputs } from '@podium/protocol'
import type { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import { attributionOf } from '../../command-principal'
import {
  checkMachineUse,
  machineAccessMessage,
  type MachineOwnershipIndex,
  machineUseDecision,
} from '../../machine-access'
import type { MachineUseResolver } from '../machines/service'
import type { MessageDeliveryService } from '../messages/service'
import {
  assertMayCommandSession,
  resolveSessionTarget,
  SESSION_NOT_FOUND,
  type SessionAccessDeps,
  type SessionTargetRow,
} from './session-access'
import type { SessionsService } from './service'

// ---------------------------------------------------------------------------
// Execution context
// ---------------------------------------------------------------------------

/**
 * The daemon control leg, as the handlers need it.
 *
 * A `Pick` of the real service rather than a hand-written port: a restated
 * signature is a second declaration that typechecks while drifting, and the
 * service is where these methods are already documented.
 */
export type SessionCommandServices = Pick<
  SessionsService,
  | 'createSession'
  | 'resumeSession'
  | 'prepareSessionTarget'
  | 'killSession'
  | 'hibernateSession'
  | 'resurrectSession'
  | 'answerAskUserQuestion'
  | 'continueSession'
  | 'listSessions'
  | 'withMutation'
>

/** The substrate both chat paths ride (#237) [spec:SP-34d7]. */
export type SessionMessageSend = Pick<MessageDeliveryService, 'send'>

export interface SessionCommandDeps {
  sessions(): SessionCommandServices
  messages(): SessionMessageSend
  /** Draft-issue vessel creation for the low-friction start path. */
  createDraftIssue(
    repoPath: string,
    agentKind: AgentKind | undefined,
    issueId?: IssueId,
  ): { id: IssueId }
  access: SessionAccessDeps
  ownership: MachineOwnershipIndex
}

/** Per-call execution context: who is calling, and what they may reach. */
export class SessionCommandCtx {
  constructor(
    readonly deps: SessionCommandDeps,
    readonly principal: CommandPrincipal,
    readonly overrideScope?: boolean,
  ) {}

  get sessions(): SessionCommandServices {
    return this.deps.sessions()
  }

  /**
   * This principal's `use` decision per machine, in the form `MachinesService`
   * threads into `agentCapabilityRejection`. Passing it is what stops the
   * IMPLICIT placement path from picking a machine the principal may not
   * execute on (readiness §3.1.4 M5, "must not offer").
   */
  get machineUse(): MachineUseResolver {
    return (machineId) => machineUseDecision(this.principal, machineId, this.deps.ownership)
  }

  /**
   * Gate an EXPLICIT machine reference, before any side effect.
   *
   * One machine per call, deliberately: a caller needing two (handoff checks its
   * source and its target) calls twice, so the refusal names WHICH machine and
   * so a re-check at apply time reads as the re-authorization it is rather than
   * as a repeat.
   */
  assertMachineUse(machineId: string): void {
    // No sentinel exemption here: `machine-access.ts` resolves the local
    // sentinels to a SYNTHESIZED host row owned by the instance owner, so they
    // go through the same rules as any other machine. An early return here
    // would have been an exemption, and M4 is precisely the case where the host
    // machine must NOT be ambient team compute.
    const failure = checkMachineUse(this.principal, machineId, this.deps.ownership)
    if (!failure) return
    throw new Error(
      machineAccessMessage(failure, machineId, this.deps.ownership.rowFor(machineId)?.name),
    )
  }

  /**
   * Resolve an existing target through the ONE shared helper, run both gates,
   * and hand back the row — or `undefined` when the target is absent, which is
   * the caller's cue to produce that command's pinned not-found shape.
   */
  target(sessionId: string, proc: string): (SessionTargetRow & { machineId?: string }) | undefined {
    const resolved = resolveSessionTarget(this.principal, sessionId, this.deps.access)
    if (resolved.kind === 'absent') return undefined
    assertMayCommandSession(
      this.principal,
      resolved.session,
      proc,
      this.deps.access,
      this.overrideScope,
    )
    const row = this.sessions
      .listSessions()
      .find((candidate) => candidate.sessionId === resolved.session.sessionId)
    // Commanding an existing session is execution on the machine it lives on.
    if (row?.machineId !== undefined) this.assertMachineUse(row.machineId)
    return row ?? resolved.session
  }
}

// ---------------------------------------------------------------------------
// Attribution and ownership, both read off the principal
// ---------------------------------------------------------------------------

/**
 * Today's `spawnedBy` value for this principal — the ACTOR half of ADR 3 D17's
 * pair, in the vocabulary the column already speaks.
 *
 * `'user'` for a human is a ROLE, not a person, because the column cannot yet
 * hold one (POD-1075 widens it); `session:<id>` for an agent is exactly what
 * `relay.ts` already stamps from the capability. Reading it from the principal
 * rather than hard-coding `'user'` at the tRPC seam is what makes the pair come
 * from the TRANSPORT on every path (D7.3) instead of from whichever router the
 * call happened to enter through.
 */
export function spawnedByFor(principal: CommandPrincipal): string {
  return principal.kind === 'user' ? 'user' : attributionOf(principal).actor
}

/**
 * Ownership of a session this command creates (ADR 9 D5 A4; readiness §3.1.2's
 * inheritance-on-create item, which is declared PER CLASS — and this is the
 * class).
 *
 * A session created by an agent is owned by that agent's `onBehalfOf` HUMAN with
 * the agent as actor; a session spawned under an issue inherits THAT ISSUE's
 * owner instead — otherwise sharing an issue does not share its work, and
 * retiring an agent orphans everything it made.
 *
 * NOT PERSISTED, and that is a boundary rather than an omission: the `sessions`
 * table has no owner column, and POD-379's attribution oracle pins that row's
 * full attribution key set against POD-1075 as the issue that changes it. A
 * column added here would edit another issue's characterization in order to
 * record a value nothing reads yet. What this issue owes is ONE producer of the
 * rule, so POD-1075 wires a column to it rather than re-deciding it.
 */
export interface CreatedOwnership {
  readonly owner: string | null
  readonly actor: string
  readonly inheritedFrom: { kind: 'issue'; id: string } | { kind: 'principal' }
}

export function createdOwnership(
  principal: CommandPrincipal,
  parentIssue: { id: string; owner?: string | null } | undefined,
): CreatedOwnership {
  const attribution = attributionOf(principal)
  if (parentIssue) {
    return {
      // The issue's owner when it has one. Before POD-1075 an issue row has no
      // owner column either, so it falls back to the delegating human — the same
      // person in a one-account instance, and still correct the moment issues
      // grow the column.
      owner: parentIssue.owner ?? attribution.onBehalfOf,
      actor: attribution.actor,
      inheritedFrom: { kind: 'issue', id: parentIssue.id },
    }
  }
  return {
    owner: attribution.onBehalfOf,
    actor: attribution.actor,
    inheritedFrom: { kind: 'principal' },
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * The handler-side input types are INFERRED from the contract schemas, never
 * restated beside them.
 *
 * A hand-written mirror of a zod object is a second declaration of the session
 * vocabulary: it typechecks, it encodes identically, and it drifts the first
 * time either side gains a field. `scripts/rearch-audit.ts` counts exactly that
 * as debt, and it counted these two before they were derived.
 */
type CreateInput = z.infer<typeof sessionCommandPlaneInputs.create>
type ResumeInput = z.infer<typeof sessionCommandPlaneInputs.resume>
type SendInput = { sessionId: string; text: string; mutationId?: string }
type TargetInput = { sessionId: string }
type AnswerInput = { sessionId: string; choices: { optionIndices: number[] }[] }

/**
 * The substrate send both chat paths ride. The sender is stamped from the
 * PRINCIPAL — an operator's send stays unwrapped and unclamped, an agent's rides
 * as that agent — so the wrapping is decided by who called, never by which
 * router they reached.
 */
function substrateSend(ctx: SessionCommandCtx, input: SendInput, lifecycle: 'wait' | 'wake') {
  const from =
    ctx.principal.kind === 'agent'
      ? ({ kind: 'agent', sessionId: ctx.principal.agentSessionId } as const)
      : ({ kind: 'operator' } as const)
  const { ok, queued, reason, disposition } = ctx.deps.messages().send(from, {
    to: { kind: 'session', id: input.sessionId },
    body: input.text,
    urgency: 'next-turn',
    lifecycle,
  })
  return {
    ok,
    ...(queued !== undefined ? { queued } : {}),
    ...(reason !== undefined ? { reason } : {}),
    // Honest outcome (#834): a send to a gone target dead-letters rather than
    // silently queueing into a black hole.
    disposition,
  }
}

/**
 * A relayed send whose target is absent throws; the operator's returns the
 * substrate's `dead_letter`. Both are POD-379-pinned, and they differ because
 * the transports differ, not because the check does.
 */
function sendHandler(lifecycle: 'wait' | 'wake', proc: string) {
  return (ctx: SessionCommandCtx, input: SendInput) =>
    ctx.sessions.withMutation(input.mutationId, proc, () => {
      const target = ctx.target(input.sessionId, proc)
      if (!target && ctx.principal.kind === 'agent') throw new Error(SESSION_NOT_FOUND)
      return substrateSend(ctx, input, lifecycle)
    })
}

// biome-ignore lint/suspicious/noExplicitAny: the table is heterogeneous by construction
type Handler = (ctx: SessionCommandCtx, input: any) => unknown

/**
 * One handler per contract. `satisfies` against the contract table's own keys,
 * so adding a contract without a handler — or a handler for a command no
 * contract declares — is a compile error rather than a 404 at runtime.
 */
export const SESSION_COMMAND_HANDLERS = {
  create: (ctx: SessionCommandCtx, input: CreateInput) =>
    ctx.sessions.withMutation(input.mutationId, 'sessions.create', async () => {
      const { draftIssue, mutationId: _mutationId, ...rest } = input
      // Explicit placement is gated BEFORE the target is prepared, because
      // preparing may clone a repository onto the target machine — a side effect
      // a denied principal must never cause.
      if (rest.machineId !== undefined) ctx.assertMachineUse(rest.machineId)
      const target = await ctx.sessions.prepareSessionTarget({ ...rest, use: ctx.machineUse })
      const issueId =
        rest.issueId ??
        (draftIssue
          ? ctx.deps.createDraftIssue(draftIssue.repoPath, rest.agentKind, draftIssue.issueId).id
          : undefined)
      // The draft-issue vessel path produces an OWNED draft, not an ownerless
      // one: the session and its vessel resolve the same owner because they
      // resolve it from the same principal.
      void createdOwnership(ctx.principal, issueId ? { id: issueId } : undefined)
      return ctx.sessions.createSession({
        ...rest,
        ...target,
        ...(issueId ? { issueId } : {}),
        use: ctx.machineUse,
        spawnedBy: spawnedByFor(ctx.principal),
      })
    }),

  resume: (ctx: SessionCommandCtx, input: ResumeInput) => {
    if (input.machineId !== undefined) ctx.assertMachineUse(input.machineId)
    // A resume landing on an EXISTING row keeps that row's provenance; the stamp
    // here is the fresh-spawn fallback only.
    return ctx.sessions.resumeSession({
      ...input,
      resume: input.resume as ResumeInput['resume'] & { kind: string; value: string },
      use: ctx.machineUse,
      spawnedBy: spawnedByFor(ctx.principal),
    })
  },

  kill: (ctx: SessionCommandCtx, input: TargetInput) => {
    // Absent ⇒ the pinned shape: kill neither throws nor tombstones.
    if (!ctx.target(input.sessionId, 'sessions.kill')) return undefined
    return ctx.sessions.killSession(input)
  },

  hibernate: (ctx: SessionCommandCtx, input: TargetInput) =>
    ctx.target(input.sessionId, 'sessions.hibernate')
      ? ctx.sessions.hibernateSession(input)
      : { ok: false, reason: 'unknown session' },

  resurrect: (ctx: SessionCommandCtx, input: TargetInput) =>
    ctx.target(input.sessionId, 'sessions.resurrect')
      ? ctx.sessions.resurrectSession(input)
      : Promise.resolve({ ok: false, reason: 'unknown session' }),

  sendText: sendHandler('wait', 'sessions.sendText'),

  resumeAndSend: sendHandler('wake', 'sessions.resumeAndSend'),

  answerAskUserQuestion: (ctx: SessionCommandCtx, input: AnswerInput) => {
    // WHICH HUMAN answered is the transport's answer: the contract's schema
    // carries no identity field, so there is nothing to ignore and nothing to
    // spoof. The pair comes from `ctx.principal`.
    if (!ctx.target(input.sessionId, 'sessions.answerAskUserQuestion')) return { ok: false }
    return ctx.sessions.answerAskUserQuestion(input)
  },

  continue: (ctx: SessionCommandCtx, input: TargetInput) => {
    if (!ctx.target(input.sessionId, 'sessions.continue')) return { ok: false }
    return ctx.sessions.continueSession(input)
  },
} satisfies Record<keyof typeof sessionCommandPlane.defs, Handler>

export type SessionCommandKey = keyof typeof SESSION_COMMAND_HANDLERS

/**
 * What one command returns.
 *
 * Derived from the handler table rather than declared beside it: a hand-written
 * result map is a second declaration that drifts silently, and the drift here
 * would land on the CLIENT's inferred tRPC types — where it reads as `unknown`
 * at every call site rather than as an error at the source.
 */
export type SessionCommandResult<K extends SessionCommandKey> = ReturnType<
  (typeof SESSION_COMMAND_HANDLERS)[K]
>

/**
 * Dispatch one command: parse against the CONTRACT's schema, then run its
 * handler behind the gates the contract declares.
 *
 * Deliberately the only way in. A transport asks for a command by name; it
 * cannot reach a handler with an unparsed input or with a principal it invented.
 */
export function dispatchSessionCommand<K extends SessionCommandKey>(
  ctx: SessionCommandCtx,
  key: K,
  rawInput: unknown,
): SessionCommandResult<K> {
  const contract = (sessionCommandPlane.defs as Record<string, CommandDef>)[key]
  if (!contract) throw new Error(`unknown session command '${key}'`)
  const handler = SESSION_COMMAND_HANDLERS[key] as (
    ctx: SessionCommandCtx,
    input: unknown,
  ) => SessionCommandResult<K>
  return handler(ctx, contract.input.parse(rawInput))
}

/** Is this proc one of the migrated command-plane commands? */
export function isCommandPlaneProc(proc: string): proc is SessionCommandKey {
  return Object.hasOwn(SESSION_COMMAND_HANDLERS, proc)
}
