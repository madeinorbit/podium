/**
 * `sessions.rename` ON THE TARGET PATH — POD-351's L3 half.
 *
 * This is the composition root's join for the walking skeleton: the L1 contract
 * (`@podium/commands`' `sessionRenameContract`) meets an L3 handler here, because
 * a handler needs services and co-locating one with its contract would make an L1
 * package depend on L3 (POD-311's finding 1).
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS THE "TARGET" PATH AND THE PRESENCE REGISTRY THE "LEGACY" ONE
 * ---------------------------------------------------------------------------
 *
 * The hand-written `sessions.rename` procedure with its own `withMutation`
 * wrapper is GONE — POD-380 deleted it along with ten siblings. So the honest
 * pairing for this issue's shadow comparison is not "new versus the original
 * procedure" but:
 *
 *   LEGACY  `PresenceRegistry.execute('sessions.rename', …)` — POD-380's
 *           envelope, driven by `@podium/protocol`'s presence `CommandDef`, with
 *           a `PresencePrincipal`, returning `undefined` on success.
 *   TARGET  this module — driven by `@podium/commands`' full ADR 3 contract, with
 *           the real `CommandPrincipal` (delegation chain resolved live),
 *           returning the contract's `SessionRenameOutcome` union.
 *
 * They are genuinely different code over the same services, which is what makes
 * `rename-shadow.test.ts` a comparison rather than a tautology.
 *
 * ---------------------------------------------------------------------------
 * THE ENVELOPE ORDER IS POD-380'S, AND IT IS NOT REDECIDED HERE
 * ---------------------------------------------------------------------------
 *
 * exposure → parse → AUTHORIZE → idempotency → handler.
 *
 * Authorization precedes idempotency deliberately: a replay of a write whose
 * grant has since been revoked must be REJECTED, not served from the dedup cache
 * (ADR 3 D8). The reverse order would let the cache launder a write the principal
 * may no longer make — and the offline drain is exactly where a replay meets a
 * changed world, so this is the order the skeleton's offline case depends on.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PATH ADDS THAT THE LEGACY ONE CANNOT EXPRESS
 * ---------------------------------------------------------------------------
 *
 * 1. THE DELEGATION CHAIN, resolved LIVE (readiness §3.1.3 A1, ADR 3 D16). An
 *    agent's effective rights are its own scope INTERSECTED with its delegating
 *    human's CURRENT rights. The legacy `PresencePrincipal` carries a `userId`
 *    and cannot express the intersection at all, so "revoke the human and the
 *    agent loses it" is not a question it can be asked.
 * 2. THE OUTCOME. Legacy rename returns `undefined` for both "renamed" and
 *    "refused because a human named it" — the refusal is reachable only through
 *    `setAgentName`'s separate return, which the tRPC procedure discards. The
 *    contract's union carries accept-versus-reject-with-reason to the caller and
 *    into the outbox's dead-letter surface.
 *
 * NO CAPABILITY IS EVER STORED. Rights are resolved from the principal at each
 * call; there is nowhere in this module to put a snapshot, which is ADR 3 D16
 * held structurally rather than remembered.
 */

import {
  RENAME_REJECTIONS,
  type SessionRenameInput,
  type SessionRenameOutcome,
  sessionRenameContract,
} from '@podium/commands'
import { SOLE_USER_ID, authorize, type AuthTarget, type SessionId, type UserId } from '@podium/model'
import type { CommandPrincipal } from '../../command-principal'
import { INSTANCE_OWNER, onBehalfOfUser } from '../../command-principal'
import type { MutationLedgerPort } from '@podium/sync'
import type { SessionsService } from './service'

/** The transports this command may arrive on. Checked against the CONTRACT's
 *  declared exposure, never against a local allowlist that could drift from it. */
export type RenameTransport = 'trpc' | 'outbox' | 'cli' | 'mcp' | 'relay' | 'peer'

/**
 * The service slice the handler needs. A `Pick` of the real service rather than a
 * restated signature, which would be a second declaration that typechecks while
 * drifting.
 */
export type RenameServices = Pick<
  SessionsService,
  'renameSession' | 'setAgentName' | 'sessionOwner'
>

export interface RenameTargetDeps {
  sessions: RenameServices
  /**
   * THE composition root's mutation ledger (POD-382), not a second dedup table.
   *
   * This path originally reached `store.sync.getAppliedMutation` /
   * `recordAppliedMutation` directly. Integration landed one `MutationLedger`
   * owning idempotency for every family, so reaching past it would have been a
   * second implementation of the one thing framework idempotency exists to make
   * unforgettable — and the two could disagree about whether a replay had been
   * seen. The ORDER is unchanged and is what matters here: authorization runs
   * BEFORE this is consulted.
   */
  mutations: MutationLedgerPort
}

/**
 * The envelope's verdict. `denied` carries NO reason and NO detail, and that is
 * the §3.1.5 consistent-error rule rather than laziness: an invisible target and
 * a nonexistent id must be indistinguishable, or the command becomes an existence
 * oracle a caller could use to enumerate other people's session ids.
 *
 * Note the asymmetry with `applied`+`{ok:false}`: a REJECTION is a policy outcome
 * about a session the principal was already authorized to write (SP-eb60's
 * arbitration), so it may carry a reason. A DENIAL is an authorization outcome and
 * may not. Collapsing the two would leak exactly what the rule protects.
 */
export type RenameDispatch =
  | { readonly outcome: 'applied'; readonly result: SessionRenameOutcome }
  | { readonly outcome: 'replayed'; readonly result: SessionRenameOutcome }
  | { readonly outcome: 'denied' }
  | { readonly outcome: 'not-exposed' }
  | { readonly outcome: 'invalid-input' }

/** The one silent refusal, built once so denial and not-found cannot diverge. */
const DENIED: RenameDispatch = { outcome: 'denied' }

/**
 * Resolve the authorization target from the STORE — owner and grants, read live,
 * never from payload (ADR 3 D7) and never cached (ADR 3 D8).
 *
 * An unknown session returns `undefined`, which the caller treats EXACTLY as a
 * denial. That equivalence is one code path rather than two branches a later edit
 * could pull apart, and it is what makes today's not-found behaviour and
 * tomorrow's invisible-session behaviour the same observable answer.
 */
function ownedTarget(deps: RenameTargetDeps, sessionId: SessionId): AuthTarget | undefined {
  const owner = deps.sessions.sessionOwner(sessionId)
  if (owner === undefined) return undefined
  return { kind: 'owned', id: sessionId, owner: owner.owner, grants: owner.grants }
}

/**
 * THE LIVE DELEGATION-CHAIN INTERSECTION (readiness §3.1.3 A1, ADR 3 D16.2).
 *
 * An agent's effective rights are its own scope INTERSECTED with its delegating
 * human's CURRENT rights. Both halves are evaluated HERE, at apply time, against
 * the target's current owner and grants:
 *
 *   - the AGENT's own capability must permit the write, and
 *   - the HUMAN at the root of the chain must still hold the session.
 *
 * Why the second check cannot be skipped: without it, revoking a person leaves
 * their unattended agents writing with rights that person no longer holds — a
 * privilege leak with no cleanup trigger, in a system where agents run for hours
 * unsupervised. With it, "revoke the human" transitively disables their agents
 * and there is no reaper to forget to write.
 *
 * Why this is not a snapshot: nothing here is stored. The chain is walked at
 * resolution (`resolvePrincipal`) and the rights are read at THIS call, so there
 * is nothing to invalidate because there is nothing cached. That is what makes
 * the offline case work — a drain hours later re-runs exactly this function
 * against the world as it is then.
 */
function mayWrite(principal: CommandPrincipal, target: AuthTarget): boolean {
  // A system principal (steward, expiry, boot reconcile) may act across owners but
  // never AS a person (§3.1.6 S5). It has no human, so there is no intersection to
  // evaluate — and no rename command routes to one today.
  if (principal.kind === 'system') return false

  if (authorize(principal.capability, 'write', target) !== 'allow') return false
  if (principal.kind === 'user') return true

  // The agent half: the CEILING. The human at the root of the chain must still be
  // able to reach this row, evaluated against the row's CURRENT owner and grants.
  const human = onBehalfOfUser(principal)
  if (human === null) return false
  return holdsTarget(human, target)
}

/**
 * TWO CONSTANTS NAME THE ONE HUMAN, AND THIS IS THE FIRST CODE TO COMPARE THEM.
 *
 * `SOLE_USER_ID` (`'user:sole'`, `@podium/model`, POD-380) is what
 * `SessionsService.sessionOwner` stamps as every session's owner.
 * `INSTANCE_OWNER` (`'instance-owner'`, `../../command-principal`, POD-381) is
 * what `resolvePrincipal` mints as every human's `UserId`. Both mean "the
 * instance's one pre-accounts account", both are replaced by POD-1075's real
 * accounts, and until now nothing ever put one beside the other — POD-380 reads
 * owners with a `PresencePrincipal` built from `SOLE_USER_ID`, POD-381 builds
 * principals nobody had yet checked against an owner column.
 *
 * The delegation ceiling below is the first check that needs BOTH, and with the
 * two spellings unreconciled it denies every agent write. It fails CLOSED, so
 * this is a liveness defect and not a leak — but it is a real one, and it would
 * have surfaced as "agents inexplicably cannot rename" the day accounts landed.
 *
 * REPORTED, NOT PAPERED OVER: filed as a discovered issue against POD-1075's
 * account work, because reconciling the two constants means editing two other
 * issues' files and the fix belongs with the aggregate that replaces both. This
 * function is the bridge in the meantime, and it is deliberately ONE named place
 * rather than an inline `||` — when the constants become one, this collapses to
 * an equality and `rename-shadow.test.ts` says so.
 */
const SAME_SOLE_HUMAN: readonly string[] = [INSTANCE_OWNER, SOLE_USER_ID]

export function samePrincipal(a: string, b: string): boolean {
  if (a === b) return true
  return SAME_SOLE_HUMAN.includes(a) && SAME_SOLE_HUMAN.includes(b)
}

/** Does this human currently own, or hold a grant on, the target? Read live. */
function holdsTarget(human: UserId, target: AuthTarget): boolean {
  if (target.kind !== 'owned') return false
  // An UNOWNED entity is not ambient: absent ownership fails toward refusal
  // (§3.1.1 default-closed, §3.1.4 M4's all-in-one case).
  if (target.owner === null) return false
  const owner = target.owner
  return samePrincipal(owner, human) || (target.grants ?? []).some((g) => samePrincipal(g, human))
}

/**
 * Run `sessions.rename` through the target path.
 *
 * `transport` is checked against the CONTRACT's exposure, so "which transports
 * serve this command" stays a contract fact. `outbox` is the offline drain, and
 * it reaches this same function — which is the point: a queued write is
 * re-authorized by the identical code that authorized the online one, rather than
 * by a replay path with its own weaker checks.
 */
export function renameOnTargetPath(
  deps: RenameTargetDeps,
  rawInput: unknown,
  principal: CommandPrincipal,
  transport: RenameTransport = 'trpc',
): RenameDispatch {
  // 1. EXPOSURE, before anything reads the input (ADR 3 D3, default-closed).
  if (!sessionRenameContract.exposure.includes(transport as never)) {
    return { outcome: 'not-exposed' }
  }

  // 2. INPUT — the contract's schema is the one validation source. Identity keys
  //    a caller may have put on the wire are stripped here and are inert.
  const parsed = sessionRenameContract.input.safeParse(rawInput)
  if (!parsed.success) return { outcome: 'invalid-input' }
  const input = parsed.data as SessionRenameInput & { mutationId?: string }

  // 3. AUTHORIZATION — LIVE, over the delegation chain, BEFORE idempotency.
  const target = ownedTarget(deps, input.sessionId)
  if (target === undefined) return DENIED
  if (!mayWrite(principal, target)) return DENIED

  // 4. IDEMPOTENCY + 5. THE HANDLER — through the shared ledger, which dedupes and
  //    records in one call. Reached only AFTER authorization, so a replay whose
  //    grant was revoked is refused above rather than served from the cache
  //    (ADR 3 D8). That ordering is the property `rename-offline.test.ts` pins and
  //    a mutant reversing it kills.
  const applied = deps.mutations.apply(input.mutationId, sessionRenameContract.name, () =>
    applyRename(deps, input, principal),
  )
  return applied.outcome === 'replayed'
    ? { outcome: 'replayed', result: applied.value }
    : { outcome: 'applied', result: applied.value }
}

/**
 * The write itself, and the WRITER-ARBITRATION branch [spec:SP-eb60].
 *
 * `nameSource` is decided from the ON-BEHALF-OF structure of the principal, not
 * from which transport was used and never from payload: an agent acting for a
 * human still writes an agent-sourced name, because SP-eb60's precedence rule
 * protects the HUMAN's choice and an agent's pick is not the human's just because
 * it was delegated.
 *
 * It delegates to the SAME two service methods the legacy path calls, on purpose.
 * The skeleton is proving the PATH — contract, principal, envelope, outcome — not
 * reimplementing the write; a second copy of the rename write would be the
 * intermediate state this whole programme exists to stop creating, and the shadow
 * comparison would be comparing two implementations of the same bug.
 */
function applyRename(
  deps: RenameTargetDeps,
  input: SessionRenameInput,
  principal: CommandPrincipal,
): SessionRenameOutcome {
  if (principal.kind === 'user') {
    deps.sessions.renameSession({ sessionId: input.sessionId, name: input.name })
    return { ok: true, name: input.name.trim(), nameSource: 'user' }
  }

  // Non-human actor: the agent-naming path, which enforces the precedence rule and
  // REFUSES a user-set name instead of overwriting it.
  const result = deps.sessions.setAgentName({ sessionId: input.sessionId, name: input.name })
  if (result.ok && result.name !== undefined) {
    return { ok: true, name: result.name, nameSource: 'agent' }
  }
  return {
    ok: false,
    reason: result.reason ?? RENAME_REJECTIONS.empty,
    ...(result.name === undefined ? {} : { name: result.name }),
  }
}
