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

import type { AgentKind } from '@podium/model'
import type { CommandDef } from '@podium/protocol'
import { sessionCommandPlane, type sessionCommandPlaneInputs } from '@podium/protocol'
import type { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import { attributionOf } from '../../command-principal'
import {
  checkMachineUse,
  type MachineOwnershipIndex,
  machineAccessMessage,
  machineUseDecision,
} from '../../machine-access'
import type { MachineUseResolver } from '../machines/service'
import type { SendDisposition } from '../messages/service'
import type { SessionsService } from './service'
import {
  assertMayCommandSession,
  resolveSessionTarget,
  SESSION_NOT_FOUND,
  type SessionAccessDeps,
  type SessionTargetRow,
} from './session-access'

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

/**
 * THE SUBSTRATE BOTH CHAT PATHS RIDE (#237) [spec:SP-34d7] — as a dispatch of
 * the `mail.send` CONTRACT, not as a call on the delivery service.
 *
 * This is POD-729's second deletion and the one that matters for security.
 * Until now `sessions.sendText` and `sessions.resumeAndSend` called
 * `MessageDeliveryService.send` directly: they went through the session command
 * plane's own gates and then reached delivery WITHOUT passing the mail
 * contract's policy. Two consequences, both of which multi-user turns from
 * untidiness into a hole (readiness §3.1.5, §3.1.3 A3):
 *
 *  - the send was not bounded by the delegating human's ceiling, because the
 *    ceiling is applied when an ADDRESS is resolved and these two never resolved
 *    an address; and
 *  - the sender was stamped by a private four-line `from` expression here rather
 *    than by `senderFromCapability`, so the attribution PAIR came from a second
 *    site that could drift from the one every other send uses.
 *
 * The port is bound at the composition root with the caller's capability already
 * closed over, exactly like every other transport binding — a handler cannot
 * invent a principal, and there is no argument here through which it could pass
 * one.
 */
export type MailSendPort = (input: {
  to: string
  body: string
  urgency?: 'fyi' | 'next-turn' | 'interrupt'
  lifecycle?: 'wait' | 'wake'
}) => Promise<unknown>

export interface SessionCommandDeps {
  sessions(): SessionCommandServices
  mailSend: MailSendPort
  /** Draft-issue vessel creation for the low-friction start path. */
  createDraftIssue(
    repoPath: string,
    agentKind: AgentKind | undefined,
    issueId?: string,
  ): { id: string }
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

/** What `mail.send` answers with, narrowed to the keys the chat paths return.
 *  Exported because it is the INFERRED return type of two tRPC procedures — an
 *  unnameable local type here becomes `unknown` on the client. */
export interface SubstrateOutcome {
  ok: boolean
  queued?: boolean
  reason?: string
  disposition: SendDisposition
}

/**
 * The substrate send both chat paths ride — one dispatch of `mail.send`.
 *
 * The sender is stamped from the CAPABILITY inside the mail handler
 * (`senderFromCapability`), so an operator's send stays unwrapped and unclamped
 * and an agent's rides as that agent: decided by who called, never by which
 * router they reached, and now by the SAME expression every other send uses.
 *
 * The address is the raw session id, deliberately. It is re-resolved under the
 * human ceiling by the handler rather than handed over pre-resolved, which is
 * what makes the absent-target case converge: an id that names nothing and an id
 * beyond the ceiling both resolve to `unresolvable`, are both written to the one
 * UNADDRESSABLE address and both dead-letter — which is exactly POD-379's pinned
 * shape for a send to an unknown session. Pre-resolving here would have been a
 * second answer to "who may this caller address".
 *
 * The RETURN is narrowed back to the four pinned keys. `mail.send` answers with
 * more (id, urgency, lifecycle, clamped), and the oracle asserts these results
 * with `toEqual` — widening the chat path's reply is a wire change and not this
 * issue's to make.
 */
async function substrateSend(
  ctx: SessionCommandCtx,
  input: SendInput,
  lifecycle: 'wait' | 'wake',
): Promise<SubstrateOutcome> {
  const { ok, queued, reason, disposition } = (await ctx.deps.mailSend({
    to: input.sessionId,
    body: input.text,
    urgency: 'next-turn',
    lifecycle,
  })) as SubstrateOutcome
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
 *
 * NO `withMutation` HERE ANY MORE (POD-729). Idempotency is the framework
 * envelope's, applied once in {@link dispatchSessionCommand} for every command
 * in the table — the same move POD-380 made for the presence class. A wrapper
 * per handler is how two commands end up recording receipts under two spellings
 * of their own proc name, which is the defect the relay arm already had.
 */
function sendHandler(lifecycle: 'wait' | 'wake', proc: string) {
  return async (ctx: SessionCommandCtx, input: SendInput): Promise<SubstrateOutcome> => {
    const target = ctx.target(input.sessionId, proc)
    if (!target && ctx.principal.kind === 'agent') throw new Error(SESSION_NOT_FOUND)
    return substrateSend(ctx, input, lifecycle)
  }
}

// biome-ignore lint/suspicious/noExplicitAny: the table is heterogeneous by construction
type Handler = (ctx: SessionCommandCtx, input: any) => unknown

/**
 * One handler per contract. `satisfies` against the contract table's own keys,
 * so adding a contract without a handler — or a handler for a command no
 * contract declares — is a compile error rather than a 404 at runtime.
 */
export const SESSION_COMMAND_HANDLERS = {
  create: async (ctx: SessionCommandCtx, input: CreateInput) => {
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
  },

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
 * handler behind the gates the contract declares — inside the FRAMEWORK's
 * idempotency envelope.
 *
 * Deliberately the only way in. A transport asks for a command by name; it
 * cannot reach a handler with an unparsed input or with a principal it invented.
 *
 * IDEMPOTENCY IS HERE, ONCE (POD-729), not in the handlers and not in the
 * transports. Two properties fall out of that which a per-handler wrapper never
 * gave us. First, the receipt's proc name is DERIVED from the key rather than
 * spelled by hand at each site — the relay arm used to apply the wrapper again
 * under a locally-spelled name, so one command wrote receipts under two names
 * and neither deduped the other. Second, a NEW command is idempotent by
 * existing: forgetting the wrapper is no longer possible, because there is no
 * wrapper to forget.
 *
 * A command with no `mutationId` in its input is unaffected — `withMutation`
 * with an undefined id runs the function and records nothing, which is what a
 * command that declares no idempotency key means.
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
  const input = contract.input.parse(rawInput)
  const mutationId = (input as { mutationId?: string } | null)?.mutationId
  return ctx.sessions.withMutation(mutationId, `sessions.${key}`, () =>
    handler(ctx, input),
  ) as SessionCommandResult<K>
}

/** Is this proc one of the migrated command-plane commands? */
export function isCommandPlaneProc(proc: string): proc is SessionCommandKey {
  return Object.hasOwn(SESSION_COMMAND_HANDLERS, proc)
}
