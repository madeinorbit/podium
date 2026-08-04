/**
 * COMMAND-PLANE HANDLERS (POD-381) — the L3 half of
 * `@podium/commands`'s `sessions/command-plane.ts` (moved there by POD-311).
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CONTRACT OWNS AND WHAT THE HANDLER OWNS
 * ---------------------------------------------------------------------------
 *
 * The CONTRACT owns authz (its `policy`, enforced by the two gates below),
 * idempotency (whether a `mutationId` is honoured) and the envelope (the dotted
 * name every receipt is recorded under). The HANDLER owns only the daemon
 * control leg: it calls `SessionLifecycle` and returns what the service returns.
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

import { type SpawnedByRef, spawnedByTag } from '@podium/model'
import {
  type CommandDef,
  sessionCommandPlane,
  type sessionCommandPlaneInputs,
} from '@podium/commands'
import type { AgentKind, Attribution, IssueId, SessionId, UserId } from '@podium/model'
import { actorAgent, actorSystem, actorUser, asAgentIdentityId } from '@podium/model'
import type { SessionBindingSpawnPrincipal } from '@podium/protocol'

import type { MutationLedgerPort } from '@podium/sync'
import { TRPCError } from '@trpc/server'
import type { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import { attributionOf } from '../../command-principal'
import {
  checkMachineUse,
  type MachineOwnershipIndex,
  machineAccessMessage,
  machineUseDecision,
} from '../../machine-access'
import type { DaemonRpcService } from '../machines/rpc'
import type { MachineUseResolver } from '../machines/service'
import type { SendDisposition } from '../messages/service'
import { inboxPrincipalFromCommand } from './inbox'
import type { IssueSessionLifecycle } from '../issue-session-lifecycle'
import type { SessionLifecycle } from './lifecycle'
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
  SessionLifecycle,
  | 'createSession'
  | 'workspace'
  | 'killSession'
  | 'hibernateSession'
  | 'answerAskUserQuestion'
  | 'continueSession'
  | 'listSessions'
  // POD-1646: the by-id read, so a command handler need not build the full list.
  | 'sessionById'
> &
  Pick<IssueSessionLifecycle, 'resumeSession' | 'resurrectSession' | 'stopSession'>

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

/** The daemon round-trip `uploadImage` is (bytes to the session's machine, an
 *  absolute path back). A `Pick` of the real service, not a restated signature. */
export type SessionDaemonRpc = Pick<DaemonRpcService, 'uploadImage'>

export interface SessionCommandDeps {
  sessions(): SessionCommandServices
  mailSend: MailSendPort
  /** Draft-issue vessel creation for the low-friction start path. */
  createDraftIssue(
    repoPath: string,
    agentKind: AgentKind | undefined,
    issueId: IssueId | undefined,
    ownership: {
      ownerUserId: import('@podium/model').UserId
      createdByActor: string
      createdByOnBehalfOf: import('@podium/model').UserId
    },
  ): { id: IssueId }
  issueOwner(issueId: IssueId): import('@podium/model').UserId | undefined
  /** The daemon control leg for `uploadImage`. */
  rpc(): SessionDaemonRpc
  access: SessionAccessDeps
  ownership: MachineOwnershipIndex
  /**
   * FRAMEWORK IDEMPOTENCY (POD-382) — applied by {@link dispatchSessionCommand}
   * for EVERY command in the table, after its gates and before its handler.
   *
   * It used to be `ctx.sessions.withMutation(input.mutationId, proc, …)` written
   * out inside three of the nine handlers, which is the per-proc shape POD-312
   * exists to delete: the other six were correct only because their inputs carry
   * no `mutationId`, and the tenth handler added would have had to remember.
   */
  mutations: MutationLedgerPort
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
  target(
    sessionId: SessionId,
    proc: string,
  ): (SessionTargetRow & { machineId?: string }) | undefined {
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
 *
 * It maps the principal to a `SpawnedByRef` and lets `spawnedByTag` spell it
 * (POD-1133) rather than borrowing `attributionOf(...).actor`, which is a
 * DIFFERENT vocabulary that happens to agree on the agent arm: its user arm is a
 * `UserId`, not the `'user'` role, so the two only coincided because this
 * function special-cased the human. The switch is exhaustive over the three
 * principal kinds.
 */
export function spawnedByFor(principal: CommandPrincipal): string {
  return spawnedByTag(spawnedByRefFor(principal))
}

function spawnedByRefFor(principal: CommandPrincipal): SpawnedByRef {
  switch (principal.kind) {
    case 'user':
      return { kind: 'user' }
    case 'agent':
      return { kind: 'session', id: principal.agentSessionId }
    case 'system':
      return { kind: 'system', job: principal.job }
  }
}
/** Binding authority from the already-resolved transport principal. There is no
 * payload parameter from which a caller could forge either identity half. */
export function bindingPrincipalFor(principal: CommandPrincipal): SessionBindingSpawnPrincipal {
  switch (principal.kind) {
    case 'user':
      return { kind: 'user', userId: principal.user }
    case 'agent':
      return { kind: 'agent', parentBindingId: principal.agentSessionId }
    case 'system':
      return { kind: 'system', job: principal.job }
  }
}

/**
 * THE SESSION'S ATTRIBUTION PAIR (POD-1516, ADR 9 D5 A3) — who created it, and
 * for whom, from the ALREADY-TRANSPORT-DERIVED binding principal.
 *
 * ONE DERIVATION, and it is deliberately this one. The binding principal is what
 * {@link bindingPrincipalFor} just built out of the authenticated
 * `CommandPrincipal`, and the protocol declares it "server-authored identity
 * input … no command payload has this shape". Deriving the pair from it — rather
 * than from `ownerUserId`, from `spawnedBy`, or from anything on the spawn input
 * — is what makes ADR 3 D7 structural instead of a convention: there is no
 * parameter here a caller could use to assert an actor.
 *
 * WHY NOT `ownerUserId`, WHICH IS RIGHT THERE. Under ADR 9 D5 A4 the owner IS
 * the pair's on-behalf-of half in the ordinary case, which is exactly what makes
 * it a trap: a session spawned under a SHARED issue inherits THAT ISSUE's owner,
 * who is not the human that delegated the spawn. Reading the human off the
 * principal keeps "who authorised this" and "whose tree it lands in" separable,
 * which is the whole content of A3.
 *
 * `delegatingHuman` IS ONLY THE AGENT ARM'S ANSWER. An agent acts for exactly
 * one human (D1, D5 A1) and the caller resolves which by walking the parent
 * binding; it is never consulted for the other two arms, so no arm can quietly
 * inherit another's human.
 *
 * TOTAL BY CONSTRUCTION — every arm returns a pair, none returns `undefined`.
 * That is what lets `SessionMeta.createdBy`'s absence mean "no attribution was
 * ever recorded" and never "not evaluated": there is no path through this
 * function that declines to stamp.
 */
export function createdByForBinding(
  principal: SessionBindingSpawnPrincipal,
  delegatingHuman: UserId,
): Attribution {
  switch (principal.kind) {
    case 'user':
      // A person acting directly: both halves name the same human.
      return { actor: actorUser(principal.userId), onBehalfOf: principal.userId }
    case 'agent':
      // POD-1164: the agent-session mint and the agent-identity mint are the
      // same, which is why this coercion is a re-brand and not a lookup. It is
      // the derivation `handoff/attribution.ts` already ships; a second spelling
      // here would be two answers to "which agent" from one capability.
      return {
        actor: actorAgent(asAgentIdentityId(principal.parentBindingId)),
        onBehalfOf: delegatingHuman,
      }
    case 'system':
      // ADR 9 D8 S5: a system job never acts AS a person, so the human half is
      // an explicit `null` — representable "there is none", never a failure to
      // record one, and never defaulted to the row's owner.
      return { actor: actorSystem(principal.job ?? 'unnamed-job'), onBehalfOf: null }
  }
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
 * Persisted by the lifecycle module as `sessions.owner_user_id`. This function
 * remains the ONE producer of the inheritance rule, so storage consumes the
 * decision without re-deciding it.
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
type SendInput = { sessionId: SessionId; text: string; mutationId?: string }
type TargetInput = { sessionId: SessionId }
type AnswerInput = { sessionId: SessionId; choices: { optionIndices: number[] }[] }

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
/**
 * A send whose target is ABSENT — nonexistent, or invisible to the principal's
 * delegating human — never reaches the substrate.
 *
 * FOUND BY POD-382's CROSS-COMMAND SWEEP, and it is the finding the gate existed
 * for. The handler used to fall through to `substrateSend` whenever the caller was
 * not an agent, and the substrate resolves the target from its OWN session list,
 * which knows nothing about a principal. So a nonexistent id dead-lettered while an
 * INVISIBLE-BUT-EXISTING session was `queued` — two observable answers, i.e. the
 * existence oracle §3.1.5 forbids, and worse: the message was actually DELIVERED to
 * a session the principal may not see.
 *
 * The shape is the substrate's own, reproduced rather than imported because it is
 * built inside a private `deadLetter` path. `session-cutover.audit.test.ts` asserts
 * this value equals what the substrate returns for a real ghost send, so the two
 * cannot drift: the duplication is checked, not trusted. POD-379 pins `ok:false` +
 * `disposition:'dead_letter'` for that path and asserts nothing about a ledger row,
 * which is what makes not writing one behaviour-preserving.
 */
const UNADDRESSABLE_SEND = {
  ok: false,
  reason: 'dead-lettered: session no longer exists',
  disposition: 'dead_letter',
} as const

function sendHandler(lifecycle: 'wait' | 'wake', proc: string) {
  return async (ctx: SessionCommandCtx, input: SendInput): Promise<SubstrateOutcome> => {
    const target = ctx.target(input.sessionId, proc)
    if (!target) {
      // A relayed agent's absent target throws; an operator's dead-letters. Both
      // POD-379-pinned, and they differ because the TRANSPORTS differ — not because
      // the target resolution does.
      if (ctx.principal.kind === 'agent') throw new Error(SESSION_NOT_FOUND)
      return { ...UNADDRESSABLE_SEND }
    }
    if (target.status === 'reconnecting') {
      return {
        ok: false,
        reason: 'machine unreachable',
        disposition: 'dead_letter',
      }
    }
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
    const target = await ctx.sessions.workspace.prepareTarget({ ...rest, use: ctx.machineUse })
    const ownership = createdOwnership(
      ctx.principal,
      rest.issueId ? { id: rest.issueId, owner: ctx.deps.issueOwner(rest.issueId) } : undefined,
    )
    if (!ownership.owner) throw new Error('session creation requires an accountable human owner')
    const issueId =
      rest.issueId ??
      (draftIssue
        ? ctx.deps.createDraftIssue(draftIssue.repoPath, rest.agentKind, draftIssue.issueId, {
            ownerUserId: ownership.owner as import('@podium/model').UserId,
            createdByActor: attributionOf(ctx.principal).actor,
            createdByOnBehalfOf: ownership.owner as import('@podium/model').UserId,
          }).id
        : undefined)
    // The draft-issue vessel path produces an OWNED draft, not an ownerless
    // one: the session and its vessel resolve the same owner because they
    // resolve it from the same principal.
    return ctx.sessions.createSession({
      ...rest,
      ...target,
      ...(issueId ? { issueId } : {}),
      use: ctx.machineUse,
      spawnedBy: spawnedByFor(ctx.principal),
      ownerUserId: ownership.owner as import('@podium/model').UserId,
      binding: {
        principal: bindingPrincipalFor(ctx.principal),
        ...(ctx.overrideScope && ctx.principal.kind !== 'system'
          ? {
              requestedScope: ctx.principal.capability.scope,
              scopeOverrideConfirmed: true,
            }
          : {}),
      },
    })
  },

  resume: (ctx: SessionCommandCtx, input: ResumeInput) => {
    if (input.machineId !== undefined) ctx.assertMachineUse(input.machineId)
    const ownership = createdOwnership(ctx.principal, undefined)
    if (!ownership.owner) throw new Error('session resume requires an accountable human owner')
    // A resume landing on an EXISTING row keeps that row's provenance; the stamp
    // here is the fresh-spawn fallback only.
    return ctx.sessions.resumeSession({
      ...input,
      resume: input.resume as ResumeInput['resume'] & { kind: string; value: string },
      use: ctx.machineUse,
      spawnedBy: spawnedByFor(ctx.principal),
      ownerUserId: ownership.owner as import('@podium/model').UserId,
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
    return ctx.sessions.answerAskUserQuestion({
      ...input,
      principal: inboxPrincipalFromCommand(ctx.principal),
    })
  },

  continue: (ctx: SessionCommandCtx, input: TargetInput) => {
    if (!ctx.target(input.sessionId, 'sessions.continue')) return { ok: false }
    return ctx.sessions.continueSession(input)
  },

  /**
   * Clean end, OPERATOR path (POD-382). The refusal is RETURNED, never thrown —
   * POD-379 pins that for tRPC — so an absent target answers with the service's own
   * `unknown session`, which is also what an invisible one must answer once
   * visibility is real. The relay arm keeps its self-stop resolution and its throw;
   * see the contract.
   */
  stop: (ctx: SessionCommandCtx, input: { sessionId: SessionId; force?: boolean }) => {
    if (!ctx.target(input.sessionId, 'sessions.stop')) {
      return Promise.resolve({ ok: false, reason: 'unknown session' })
    }
    // Thread the transport principal so free-worktree audit comments name the
    // caller rather than system:stop (POD-1344).
    return ctx.sessions.stopSession({ ...input, principal: ctx.principal })
  },

  /**
   * Bytes onto the session's machine, an absolute path back.
   *
   * NO EXISTENCE GATE, deliberately, and this is the one handler where that is a
   * preservation rather than an omission: POD-379 pins that an upload for an
   * unknown session is dispatched to the default machine anyway, and tags the
   * change as POD-1073's. Adding the gate here would silently take a pinned
   * behaviour from another issue.
   *
   * The MACHINE gate is applied, because it is this class's whole point: the bytes
   * land on the machine that runs the session (routing is a must-not-change
   * invariant), so putting them there is the `use` verb. With no owner column yet
   * an ownerless machine still allows — which is exactly POD-379's `willChange`
   * characterization for POD-1079, unchanged by this migration.
   */
  uploadImage: async (
    ctx: SessionCommandCtx,
    input: { sessionId: SessionId; filename: string; mimeType: string; dataBase64: string },
  ) => {
    const row = ctx.sessions.sessionById(input.sessionId)
    if (row?.machineId !== undefined) ctx.assertMachineUse(row.machineId)
    const result = await ctx.deps.rpc().uploadImage(input)
    if (result.error) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error })
    }
    if (!result.path) {
      throw new TRPCError({
        code: 'TIMEOUT',
        message: 'no daemon answered the image upload request',
      })
    }
    return result
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
  const name = `sessions.${key}`
  // IDEMPOTENCY, FRAMEWORK-OWNED AND APPLIED HERE FOR EVERY COMMAND (POD-382).
  //
  // AFTER the parse and INSIDE the handler's gates: the handler runs its machine
  // `use` and owner checks, so a replay whose grant was revoked is refused by
  // those gates on the way in rather than served out of the dedup cache (ADR 3 D8
  // / readiness §3.1.3 A1). The ledger is entered before the handler and the
  // handler is what re-authorizes, which is the same order the session-state envelope
  // states explicitly.
  //
  // A command whose input carries no `mutationId` passes through unchanged — the
  // ledger's own documented no-dedup case — so this is behaviour-identical for the
  // six lifecycle commands and identical-by-construction for the three that do.
  const mutationId = (input as { mutationId?: unknown }).mutationId
  return ctx.deps.mutations.once(
    typeof mutationId === 'string' ? mutationId : undefined,
    name,
    () => handler(ctx, input),
  ) as SessionCommandResult<K>
}

/** Is this proc one of the migrated command-plane commands? */
export function isCommandPlaneProc(proc: string): proc is SessionCommandKey {
  return Object.hasOwn(SESSION_COMMAND_HANDLERS, proc)
}
