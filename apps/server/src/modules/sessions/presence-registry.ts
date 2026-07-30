/**
 * PRESENCE-CLASS HANDLERS + THE FRAMEWORK ENVELOPE (POD-380, under POD-312).
 *
 * The L3 half of the split: contracts live in `@podium/protocol`
 * (`session-commands.ts`) and carry policy / exposure / offline / redaction; this
 * file registers a HANDLER per contract and wraps every one in the same envelope.
 *
 * ## What the envelope owns, and why that is the point of the migration
 *
 * Each hand-written router procedure used to wrap itself in
 * `sessionsSvc.withMutation(input.mutationId, 'sessions.rename', …)`. Eleven
 * procedures, eleven chances to forget — POD-379's idempotency oracle exists
 * because omitting the wrapper on ONE route is a real, silent regression class.
 * {@link PresenceRegistry.execute} does it ONCE, for every contract, ahead of the
 * handler, using the same durable mechanism (`store.sync.getAppliedMutation` /
 * `recordAppliedMutation`). A new presence command cannot opt out: there is no
 * per-handler seam to omit it from.
 *
 * The envelope also owns, in this order:
 *
 *   1. EXPOSURE — the transport must be declared on the contract
 *      (default-closed). A command reached through a transport it does not declare
 *      is refused before its input is parsed.
 *   2. INPUT VALIDATION — the contract's schema is the one validation source.
 *   3. AUTHORIZATION — resolved LIVE from the principal and the CURRENT stored
 *      owner/grants, at every apply including an outbox drain (ADR 3 D8, §3.1.3
 *      A1). This is the step that makes an offline-queued write safe.
 *   4. IDEMPOTENCY — mutationId dedup.
 *   5. the handler.
 *
 * Authorization precedes idempotency deliberately. A replay of a write whose
 * grant has since been revoked must be REJECTED, not served from the dedup cache;
 * the reverse order would let the cache launder a write the principal may no
 * longer make.
 *
 * ## Consistent errors (§3.1.5)
 *
 * Writing to a session the principal cannot see must fail IDENTICALLY to writing
 * to a session that does not exist. POD-379 pins today's not-found shape for the
 * presence writes: a SILENT NO-OP (no throw, no row, no reason). So a denial here
 * is the same silent no-op — see {@link DENIED}. That is what keeps the command
 * surface from being an existence oracle, and it is why these handlers do not
 * throw a "forbidden" error the way an issue command does.
 */

import { type CommandDef, isExposedOn, presenceCommand } from '@podium/protocol'
import {
  type AuthTarget,
  authorize,
  type Capability,
  capabilityAttribution,
  SOLE_USER_ID,
} from '@podium/model'
import type { MutationLedgerPort } from '@podium/sync'
import type { SessionStore } from '../../store'
import type { SessionsService } from './service'

/**
 * The transport a call arrived on. Checked against the contract's declared
 * exposure, so "which transports serve this command" is a contract fact rather
 * than a per-transport allowlist that can drift from it.
 */
export type PresenceTransport = 'trpc' | 'relay' | 'cli' | 'mcp' | 'ws'

/**
 * WHO is calling — the transport principal (ADR 3 D7: never read from payload).
 *
 * `userId` is the identity per-user rows are keyed by and owner/grant checks are
 * resolved against. For an agent it is its DELEGATING HUMAN, because §3.1.3 A1
 * resolves an agent's rights as its own scope intersected with its human's
 * CURRENT rights — so the identity a grant matches is always the human at the root
 * of the delegation chain, evaluated now and not at spawn.
 *
 * The attribution PAIR (§3.1.3 A3) is carried separately and is never collapsed
 * into `userId`: "which agent did this" and "which human was it for" are two
 * questions, and `nameSource` is the shipped feature that depends on the answer.
 */
export interface PresencePrincipal {
  userId: string
  capability: Capability
  /** The acting agent session, when an agent is acting. Absent for a human. */
  actorSessionId?: string
  /** The human this call is made FOR. Equals `userId` for a human caller. */
  onBehalfOf?: string
  /** True when the human is acting directly — decides `nameSource` (see below). */
  humanDirect: boolean
  /**
   * The DEVICE half of §3.2's `(user, device, capability)` principal: the attached
   * client this call arrived on, when there is one.
   *
   * Load-bearing for the composer draft, not bookkeeping: a draft edit fans out to
   * every OTHER attached client and deliberately does NOT echo to its author
   * (POD-379 pins both). Without the author's client id the handler cannot suppress
   * that echo, and the author's own composer would fight its own keystrokes.
   */
  clientId?: string
}

/**
 * The sole principal until POD-1075 mints real accounts: the cookie-authed human,
 * unconstrained (`OPERATOR`), acting as {@link SOLE_USER_ID}.
 *
 * A FUNCTION, not a constant, so a caller cannot mutate the shared object — and
 * so every call site that will need a real principal is one grep away.
 */
export function soleHumanPrincipal(capability: Capability): PresencePrincipal {
  return {
    userId: SOLE_USER_ID,
    capability,
    onBehalfOf: SOLE_USER_ID,
    humanDirect: capabilityAttribution(capability).actor === null,
  }
}

/**
 * The principal for a WebSocket client message. Same sole human as the tRPC seam
 * (both are the one shared password today) but carrying the attached client's id,
 * which the draft handler needs.
 */
export function soleHumanWsPrincipal(
  capability: Capability,
  clientId: string,
): PresencePrincipal {
  return { ...soleHumanPrincipal(capability), clientId }
}

/** What a refused presence write returns: nothing. See the §3.1.5 note above. */
const DENIED = Symbol('presence-write-denied')

/** Outcome of the envelope's checks, for the tests and for the audit trail. */
export type PresenceOutcome = 'applied' | 'replayed' | 'denied' | 'not-exposed' | 'invalid-input'

export interface PresenceResult {
  outcome: PresenceOutcome
  /** The handler's return value; undefined for every refusal (§3.1.5). */
  value?: unknown
}

export interface PresenceDeps {
  sessions: SessionsService
  store: SessionStore
  now: () => number
  /**
   * FRAMEWORK IDEMPOTENCY (POD-382) — `@podium/sync`'s `MutationLedger`, the ONE
   * implementation, injected rather than re-implemented here.
   *
   * This envelope used to hold its own copy of check-run-record over
   * `store.sync`. Two copies over one durable table is how a replay applies
   * twice, and the copy here was the second of three; the third was
   * `SessionsService.withMutation`, which this issue deleted.
   */
  mutations: MutationLedgerPort
}

/**
 * One handler: the L3 body of a contract. It receives PARSED input and a
 * principal that has ALREADY been authorized — a handler never re-checks policy,
 * because a second check is a second place for the two to disagree.
 */
type PresenceHandler = (
  input: Record<string, unknown>,
  principal: PresencePrincipal,
  deps: PresenceDeps,
) => unknown

/**
 * How a command names its authorization target. Returning `undefined` means "the
 * target does not exist", which the envelope treats EXACTLY as a denial — that
 * equivalence is §3.1.5's consistent-error rule expressed as one code path rather
 * than as two branches a later edit could pull apart.
 */
type TargetResolver = (
  input: Record<string, unknown>,
  principal: PresencePrincipal,
  deps: PresenceDeps,
) => AuthTarget | undefined

interface Registration {
  handler: PresenceHandler
  target: TargetResolver
}

// ---------------------------------------------------------------------------
// Target resolvers
// ---------------------------------------------------------------------------

/**
 * A session as an OWNED entity. Owner and grants are read from the STORE, never
 * from the payload (ADR 3 D7), and re-read on every apply so a revoked grant bites
 * on an outbox drain (ADR 3 D8).
 *
 * Until POD-1075 there is no `owner` column, so today every existing session is
 * owned by {@link SOLE_USER_ID}. That is a TRANSITIONAL read, not a fallback: an
 * unknown session resolves to `undefined` (⇒ denied ⇒ silent no-op), which is what
 * makes today's not-found behaviour and tomorrow's invisible-session behaviour the
 * same code path.
 */
const ownedSession: TargetResolver = (input, _principal, deps) => {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
  if (!sessionId) return undefined
  const owner = deps.sessions.sessionOwner(sessionId)
  if (owner === undefined) return undefined
  return { kind: 'owned', id: sessionId, owner: owner.owner, grants: owner.grants }
}

/** A per-user row: always the CALLER's own. The payload cannot name a user, so
 *  "set another user's readAt" is not expressible on the wire at all — the
 *  self-scoping check below is the second line of defence, not the only one. */
const ownPerUserRow: TargetResolver = (_input, principal) => ({
  kind: 'per-user-row',
  userId: principal.userId,
})

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const REGISTRATIONS: Record<string, Registration> = {
  'sessions.rename': {
    target: ownedSession,
    handler: (input, principal, deps) => {
      const name = str(input.name)
      // §3.1.3 A3: "a human set this name" is decided from the ON-BEHALF-OF human
      // of the transport principal, not from which transport was used. An agent
      // acting for a human still writes an agent-sourced name — [spec:SP-eb60]'s
      // precedence rule protects the HUMAN's choice, and an agent's pick is not
      // the human's just because it was delegated.
      if (principal.humanDirect) {
        deps.sessions.renameSession({ sessionId: str(input.sessionId), name })
        return undefined
      }
      // Non-human actor: route through the agent-naming path, which enforces the
      // precedence rule and REFUSES a user-set name instead of overwriting it.
      return deps.sessions.setAgentName({ sessionId: str(input.sessionId), name })
    },
  },
  'sessions.setArchived': {
    target: ownedSession,
    handler: (input, _principal, deps) => {
      deps.sessions.setArchived({
        sessionId: str(input.sessionId),
        archived: input.archived === true,
      })
    },
  },
  'sessions.setWorkState': {
    target: ownedSession,
    handler: (input, _principal, deps) => {
      deps.sessions.setWorkState({
        sessionId: str(input.sessionId),
        // Parsed by the contract, so this is a narrowing not a validation.
        workState: (input.workState ?? null) as never,
      })
    },
  },
  'sessions.setIssueId': {
    target: ownedSession,
    handler: (input, _principal, deps) => {
      deps.sessions.setSessionIssueId(
        str(input.sessionId),
        typeof input.issueId === 'string' ? input.issueId : null,
      )
    },
  },
  'sessions.markRead': {
    // PER-USER state by contract. The row it writes is still the session's
    // `read_at` column until POD-1076 moves it (see
    // packages/model/src/user-state/session-state.ts for why that move waits on
    // POD-1077's scoped feed) — but the POLICY is already self-scoped, so the
    // move is storage-only and needs no contract or wire change.
    target: ownPerUserRow,
    handler: (input, _principal, deps) => {
      deps.sessions.markSessionRead(str(input.sessionId))
    },
  },
  'sessions.markUnread': {
    target: ownPerUserRow,
    handler: (input, _principal, deps) => {
      deps.sessions.markSessionUnread(str(input.sessionId))
    },
  },
  'snoozes.set': {
    target: ownPerUserRow,
    handler: (input, principal, deps) => {
      deps.sessions.setSnooze({
        userId: principal.userId,
        sessionId: str(input.sessionId),
        until: typeof input.until === 'string' ? input.until : null,
      })
      return deps.store.sessions.listSnoozes(principal.userId)
    },
  },
  'snoozes.clear': {
    target: ownPerUserRow,
    handler: (input, principal, deps) => {
      deps.sessions.clearSnooze(principal.userId, str(input.sessionId))
      return deps.store.sessions.listSnoozes(principal.userId)
    },
  },
  'pins.set': {
    target: ownPerUserRow,
    handler: (input, principal, deps) => {
      deps.store.sessions.setPin(
        principal.userId,
        input.kind as never,
        str(input.id),
        input.pinned === true,
      )
      return deps.store.sessions.listPins(principal.userId)
    },
  },
  'tabs.setOrder': {
    target: ownPerUserRow,
    handler: (input, principal, deps) => {
      deps.store.sessions.setTabOrder(
        principal.userId,
        str(input.worktree),
        (input.sessionIds ?? []) as string[],
      )
      return deps.store.sessions.listTabOrders(principal.userId)
    },
  },
  'sessions.setDraft': {
    target: ownedSession,
    handler: (input, principal, deps) => {
      const edit = input.edit as { kind: 'replace'; text: string }
      // The op-stream RESERVATION's one enforced rule (see the contract): a stale
      // baseRevision is REJECTED rather than applied, so a second writer's text is
      // never silently overwritten. Absent baseRevision = today's unconditional
      // write, byte-for-byte.
      const baseRevision = typeof input.baseRevision === 'number' ? input.baseRevision : undefined
      if (baseRevision !== undefined) {
        const current = deps.sessions.draftRevision(str(input.sessionId))
        if (current !== undefined && current !== baseRevision) {
          return { ok: false, reason: 'stale-revision', revision: current }
        }
      }
      // `clientId` is what suppresses the echo to the author (see PresencePrincipal).
      deps.sessions.setSessionDraft(
        { sessionId: str(input.sessionId), text: edit.text },
        principal.clientId,
      )
      return undefined
    },
  },
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

export class PresenceRegistry {
  constructor(private readonly deps: PresenceDeps) {}

  /** Every migrated command name — what a cutover audit reads. */
  static names(): string[] {
    return Object.keys(REGISTRATIONS)
  }

  /**
   * Run one presence command through the whole envelope. Never throws for a
   * refusal: see the §3.1.5 note in the file header — a denial and a not-found are
   * the same silent no-op, so a caller cannot tell them apart.
   */
  execute(
    name: string,
    rawInput: unknown,
    principal: PresencePrincipal,
    transport: PresenceTransport = 'trpc',
  ): PresenceResult {
    const contract = presenceCommand(name)
    const registration = REGISTRATIONS[name]
    // Own-prototype lookup only: `REGISTRATIONS['toString']` must not resolve.
    if (!contract || !Object.hasOwn(REGISTRATIONS, name) || !registration) {
      return { outcome: 'not-exposed' }
    }

    // 1. EXPOSURE, before anything reads the input.
    if (!isExposedOn(contract, transport)) return { outcome: 'not-exposed' }

    // 2. INPUT — the contract's schema is the one validation source.
    const parsed = contract.input.safeParse(rawInput)
    if (!parsed.success) return { outcome: 'invalid-input' }
    const input = parsed.data as Record<string, unknown>

    // 3. AUTHORIZATION, live, BEFORE idempotency (see the header: a replay whose
    //    grant was revoked must be rejected, not served from the dedup cache).
    if (this.authorizeOrDeny(contract, registration, input, principal) === DENIED) {
      return { outcome: 'denied' }
    }

    // 4. IDEMPOTENCY + 5. THE HANDLER — the framework's ledger runs the handler at
    //    most once per mutationId and reports which happened. One implementation,
    //    shared with the command plane and the issue registry, and no per-handler
    //    seam to omit it from.
    const mutationId = typeof input.mutationId === 'string' ? input.mutationId : undefined
    const applied = this.deps.mutations.apply(mutationId, name, () =>
      registration.handler(input, principal, this.deps),
    )
    return { outcome: applied.outcome, value: applied.value }
  }

  private authorizeOrDeny(
    contract: CommandDef,
    registration: Registration,
    input: Record<string, unknown>,
    principal: PresencePrincipal,
  ): typeof DENIED | 'allow' {
    const policy = contract.policy
    // A contract with no declared policy is refused, not waved through: the
    // default-closed rule applies to policy exactly as it does to exposure.
    if (!policy) return DENIED
    const target = registration.target(input, principal, this.deps)
    // Target absent = does not exist. Same answer as denied, one code path.
    if (!target) return DENIED
    // The self-scoping check, stated positively rather than relying on the target
    // resolver having built the row from the principal: a resolver that ever reads
    // a userId out of the payload would be caught here.
    if (policy.scope === 'self' && (target.kind !== 'per-user-row' || target.userId !== principal.userId)) {
      return DENIED
    }
    return authorize(principal.capability, policy.action, target) === 'allow' ? 'allow' : DENIED
  }
}
