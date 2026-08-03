/**
 * THE SETTINGS AUTHORIZATION GATE (POD-421, 3.7d) — the runtime that finally
 * READS the settings family's `roleFloor`.
 *
 * POD-420 declared the floor on every settings contract and said so in as many
 * words at the `settings.setSecret` rationale: *"Nothing enforces the floor
 * today; POD-1079 owns it."* POD-1079 then shipped `modules/fleet/authz.ts` and
 * enforced the FLEET's floors — the settings family's stayed declarative. Six
 * contracts (now seven) carrying an admin/member split that nothing compared
 * anything against.
 *
 * That is this run's dominant defect class in the form the existing instruments
 * structurally cannot see. A totality test proves every field is classified and
 * proves nothing about whether anything reads the classification, so
 * `contracts.test.ts` was green throughout: **a declaration with no consumer is
 * indistinguishable from an enforced one from every angle except grepping for
 * the consumer.** This file is the consumer.
 *
 * ---------------------------------------------------------------------------
 * DERIVED, NOT PER-HANDLER
 * ---------------------------------------------------------------------------
 *
 * `trpc.ts` routes every settings procedure through {@link settingsAuthzFailure},
 * so an eighth settings command is gated by whatever its contract declares
 * without anyone remembering to add a check. The alternative — a check inside
 * each handler — is seven places to forget, and the forgetting is invisible.
 *
 * The shape is `modules/fleet/authz.ts`'s deliberately, minus the `machineVerb`
 * stage: no settings contract places work on owned compute (none declares a
 * verb), so the floor is the whole gate here. Stated rather than silently
 * omitted, because "this family has no second stage" and "somebody forgot the
 * second stage" look identical otherwise.
 *
 * ---------------------------------------------------------------------------
 * THE REFUSAL MUST NOT BE AN EXISTENCE ORACLE
 * ---------------------------------------------------------------------------
 *
 * `docs/multi-user-readiness.md` §3.1.5: an unauthorized read must fail
 * IDENTICALLY to a nonexistent one, *"otherwise the difference … is a probe"*.
 * For `settings.secretPresence` that is not a theoretical nicety — the fact
 * being withheld IS an existence fact ("does this instance have a key
 * configured"), so a refusal a member can distinguish from an empty instance has
 * leaked exactly what the floor is protecting.
 *
 * So the refusal for the presence read is `NOT_FOUND` carrying
 * {@link SECRET_SURFACE_ABSENT}, the SAME code and the SAME string an instance
 * without the surface would produce — and never `FORBIDDEN`, which would
 * announce that there is something there to be forbidden from. The WRITES refuse
 * with `FORBIDDEN` and say why, and that asymmetry is deliberate: a member who
 * attempts a write already knows the surface exists (they were shown a disabled
 * control naming the reason), so nothing is leaked by an honest message, and an
 * unexplained failure would be worse product for no security gain.
 */

import { type AnyCommandContract, SETTINGS_CONTRACTS } from '@podium/commands'
import { isAdminGrade, type UserRole } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { type CommandPrincipal, onBehalfOfUser, resolvePrincipal } from '../../command-principal'
import { spawnedByParentSessionId } from '@podium/model'
import { type Context, mods } from '../../trpc'
import { isSettingsCommand, type SettingsCommandName } from './registry'

/**
 * WHAT A PRINCIPAL BELOW THE FLOOR IS TOLD ABOUT THE SECRET SURFACE, and it is
 * one exported constant because the whole property is that there is exactly ONE
 * string.
 *
 * Two call sites must produce it identically — the refusal, and the "this
 * instance has no secret surface" answer — and two string literals that happen
 * to match today are one edit away from being an oracle. The web renders this
 * case through its ordinary empty path for the same reason.
 */
export const SECRET_SURFACE_ABSENT = 'No secret surface is available.'

/**
 * Does this account grade satisfy the contract's floor?
 *
 * `undefined` is NOT a role: it means the principal has no readable, enabled
 * account, and it satisfies NO floor. Lifted from `fleet/authz.ts`'s
 * `roleSatisfiesFloor` in BEHAVIOUR but re-stated here rather than imported
 * across the module boundary — `check-boundaries.ts` forbids the cross-feature
 * import, and the shared home for it is the model, where POD-1079 already put
 * `isAdminGrade`. The two therefore agree on the only thing that decides.
 */
export function settingsRoleSatisfiesFloor(
  role: UserRole | undefined,
  floor: 'admin' | 'member',
): boolean {
  if (role === undefined) return false
  return floor === 'admin' ? isAdminGrade(role) : true
}

export interface SettingsAuthzDeps {
  readonly principal: CommandPrincipal
  readonly role: UserRole | undefined
}

const contractFor = (name: SettingsCommandName): AnyCommandContract =>
  SETTINGS_CONTRACTS[name] as AnyCommandContract

/**
 * The refusal for one settings command, or `undefined` to proceed.
 *
 * RETURNED RATHER THAN THROWN, so the decision is testable without a tRPC
 * request and so exactly one place converts a decision into an HTTP status.
 *
 * Takes the NAME and resolves the contract here. An unknown name refuses — it
 * cannot reach this function through the derived router (the table is the
 * router's own key set), and if it ever did, "I could not find the rule" must
 * not be spelled the same way as "the rule permitted it".
 */
export function settingsAuthzFailure(
  name: string,
  deps: SettingsAuthzDeps,
): TRPCError | undefined {
  if (!isSettingsCommand(name)) {
    return new TRPCError({
      code: 'FORBIDDEN',
      message: `${name} is not a settings command`,
    })
  }
  const contract = contractFor(name)
  const { policy } = contract

  // A SYSTEM principal is in-process only and unreachable from every transport
  // (ADR 3 Amendment 1 D21.2). It has no account, so it satisfies no floor by
  // `settingsRoleSatisfiesFloor` — the carve-out is here rather than by
  // inventing a role for it, because "the steward is an admin" is exactly the
  // service account ADR 9 D8 S5 rejects.
  if (deps.principal.kind === 'system') return undefined

  if (settingsRoleSatisfiesFloor(deps.role, policy.roleFloor)) return undefined

  // THE SECRET SURFACE REFUSES AS ABSENT. See the header: for a read whose
  // subject IS an existence fact, a distinguishable refusal leaks the fact.
  if (policy.action === 'read' && policy.resource === 'secret') {
    return new TRPCError({ code: 'NOT_FOUND', message: SECRET_SURFACE_ABSENT })
  }

  return new TRPCError({
    code: 'FORBIDDEN',
    message: `${name} requires an ${policy.roleFloor} account`,
  })
}

/**
 * Build the gate's dependencies from a tRPC context.
 *
 * The principal is resolved HERE, at the transport seam, from the capability —
 * never from the input (ADR 3 D7). `parentSessionOf` walks live `spawnedBy` rows
 * so a sub-agent's delegation chain roots at exactly one human (D16.2), the same
 * construction `fleetAuthzDeps` and `sessionCommandCtx` use; a second answer to
 * "who is calling" is what D7 exists to prevent.
 *
 * The role is read LIVE at every call and never cached onto anything. That is
 * ADR 9 D5 A1 and POD-352's exit item verbatim: there is no serialized
 * effective-capability snapshot, because there is nothing here to serialize.
 */
export function settingsAuthzDeps(ctx: Context): SettingsAuthzDeps {
  const sessions = mods(ctx).sessions
  const principal = resolvePrincipal(ctx.capability, {
    parentSessionOf: (sessionId) =>
      spawnedByParentSessionId(
        sessions.listSessions().find((s) => s.sessionId === sessionId)?.spawnedBy,
      ),
  })
  const user = onBehalfOfUser(principal)
  return {
    principal,
    role: user === null ? undefined : ctx.registry.sessionStore.users.roleOf(user),
  }
}

/**
 * MAY THIS PRINCIPAL ATTEMPT THIS COMMAND — the same question the gate asks,
 * exposed for the surface that has to render a control as disabled.
 *
 * The brief's rule is that an admin-grade control must be *"disabled with a
 * stated reason rather than editable-then-refused"*, and that requires the
 * client to know the answer BEFORE the attempt. This is the one function both
 * sides go through, so the disabled state and the refusal cannot disagree —
 * a UI computing its own answer from a second rule is how a control ends up
 * enabled for a write the server refuses.
 *
 * IT IS NOT A CAPABILITY SNAPSHOT and must not become one. It is recomputed per
 * request from the live role, it is never stored, never enqueued and never put
 * on a contract or an outbox entry, and the server re-runs the identical gate at
 * apply time regardless of what the client believed (ADR 3 D8). The client's
 * copy is a RENDERING HINT with no authority — which is the distinction POD-352's
 * exit item is about.
 */
export function settingsCommandsPermitted(deps: SettingsAuthzDeps): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const name of Object.keys(SETTINGS_CONTRACTS)) {
    out[name] = settingsAuthzFailure(name, deps) === undefined
  }
  return out
}
