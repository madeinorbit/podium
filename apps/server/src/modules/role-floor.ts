/**
 * THE ROLE FLOOR, READ WHERE EVERY DERIVED FAMILY GOES THROUGH (PDM-294).
 *
 * `CommandPolicy.roleFloor` is ADR 3 Amendment 1 D15's account grade: which
 * commands a principal may ATTEMPT, as distinct from which ROWS they may touch.
 * Thirty-one shipped contracts declare the `admin` floor. Before this file
 * THIRTEEN of them were enforced — `modules/fleet/authz.ts` and
 * `modules/settings/authz.ts` read the floor off the contract for their own
 * families, `InstanceService.requireAdmin()` covers `setup.activate`, and two
 * hand-written sites (`workflows`' `assertProfileWrite`,
 * `operations`' `assertActionAuthorized`) hard-code `role === 'admin'` without
 * consulting a contract at all.
 *
 * (PDM-299 has since made those two hand-written sites read {@link
 * adminFloorRefusal} below, so all five agree about WHO may satisfy an admin
 * floor. They still hard-code the FLOOR VALUE rather than reading a contract —
 * `operations` joins no contract table, which is `PDM-297`.)
 *
 * The other EIGHTEEN were documentation, and the most exposed of them is
 * `accounts.connect`, whose own rationale says *"whoever writes this decides
 * which account every agent on this instance bills and acts as"*. Any
 * authenticated member could overwrite or delete it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A FOURTEENTH `authz.ts`
 * ---------------------------------------------------------------------------
 *
 * The hole was never that `modules/accounts` lacked a file. It was that
 * `derivedFamilyProcedures` — the ONE builder thirteen family surfaces are
 * derived through — read `contract.exposure` and `contract.input` and never
 * `contract.policy`. A family with no gate of its own was ungoverned however its
 * contracts read, and a FOURTEENTH family would have inherited the same hole on
 * the day it was added, silently, because nothing anywhere asks the question.
 *
 * So the floor is read once, here, and applied by the builder to every command
 * it serves. Adding a family cannot now forget it, because there is nothing left
 * to remember.
 *
 * This does NOT contradict `derived-family.ts`'s rule that a handler built
 * through that file "cannot make an authorization decision even by accident".
 * The handler still cannot: `FamilyState` still carries no capability, no scope
 * and no registry, and nothing below is reachable from a handler. It is the
 * TRANSPORT that enforces the contract's own declaration, before the service is
 * ever selected — the same division `fleet/trpc.ts` and `settings/trpc.ts` made.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * 1. IT DOES NOT GATE THE `member` FLOOR, and the reason is a measurement rather
 *    than a preference. `roleSatisfiesFloor` in both shipped gates treats an
 *    ABSENT role as satisfying no floor — correctly, because "no readable,
 *    enabled account" is not a grade. Applying that to the `member` floor here
 *    would newly refuse every principal with no account row across the 149
 *    member-floor contracts, which includes an open-mode instance before anyone
 *    has been adopted. Widening a gate by 149 contracts is not a side effect of
 *    closing a hole in 17, so the two floors are separated BY NAME below and a
 *    third value would be a compile error rather than a silent pass.
 *
 * 2. IT DOES NOT GATE READS. A `DerivedQuery` carries no policy — a visibility
 *    class describes what a command WRITES — so nothing here can reach one.
 *    That is load-bearing product behaviour and not an omission: `accounts.list`
 *    is a query, `apps/web`'s `SettingsView.tsx` fetches it unconditionally and
 *    swallows the error, and an admin throw on that path would silently blank
 *    the Accounts hub for every member (PDM-271, re-confirmed by PDM-294).
 *    Whether reads gain a floor is a product decision with a UI half.
 *
 * 3. IT DOES NOT REACH `operations` AS A BUILDER. That family hand-writes its
 *    procedures and joins them to no contract table at all, so nothing derived
 *    governs it — `PDM-297` owns the join. What PDM-299 changed is narrower and
 *    does not need the join: `assertActionAuthorized` now calls {@link
 *    adminFloorRefusal} directly, so the family is outside the BUILDER and
 *    inside the RULE.
 *
 * ---------------------------------------------------------------------------
 * THE REFUSAL MUST NOT BECOME AN EXISTENCE ORACLE
 * ---------------------------------------------------------------------------
 *
 * `docs/multi-user-readiness.md` §3.1.5: an unauthorized read must fail
 * IDENTICALLY to a nonexistent one. `settings.secretPresence` is the case that
 * matters — the fact being withheld IS an existence fact — and
 * `settings/authz.ts` answers it with `NOT_FOUND` and `SECRET_SURFACE_ABSENT`
 * rather than `FORBIDDEN`.
 *
 * No contract served through the derived builder is a READ behind a `secret`
 * floor today, so writing that branch here would be a guard nothing witnesses —
 * the shape `PDM-134` was pulled up for. Instead {@link assertNoSecretReadFloor}
 * makes the case a BUILD failure: the day such a contract is added, the server
 * refuses to assemble and names the rule it must follow, which is the same
 * "state it or fail" discipline `assertSurfaceMatchesDeclarations` uses one file
 * over.
 */

import type { AnyCommandContract } from '@podium/commands'
import { spawnedByParentSessionId, type UserRole } from '@podium/model'
import { TRPCError } from '@trpc/server'
import {
  type AdminFloorRefusal,
  adminFloorMessage,
  adminFloorRefusal,
  type CommandPrincipal,
  onBehalfOfUser,
  resolvePrincipalAsync,
} from '../command-principal'

/**
 * THE ADMIN-FLOOR RULE, RE-EXPORTED FROM ITS HOME (PDM-299).
 *
 * PDM-107's ruling was "one exported decision in `role-floor.ts`", and this is
 * that decision — but the FUNCTION lives in `command-principal.ts`, beside the
 * `CommandPrincipal` union whose `kind` it switches on, and it is re-exported
 * here so this file stays the place a reader looks for "what decides a floor".
 *
 * THE PLACEMENT IS NOT COSMETIC and the repository measured it. This module
 * takes a tRPC `Context`, so it is transport-layer; `WorkflowAccess` — one of
 * the five consumers — is a HANDLER, and importing this file from there pulled
 * `../trpc` into the workflow service's module graph. `scripts/server-test-
 * shards.ts` assigns shards by what a test actually CONSUMES, so the first
 * version of this change silently moved three workflow suites from the `store`
 * shard to `services`: same files, different config, which is exactly the
 * "green from the wrong config" the false-green catalogue lists as entry 11.
 * `command-principal.ts` has no transport dependency, every one of the five
 * sites already imports it, and the shard manifest is unchanged.
 */
export { type AdminFloorRefusal, adminFloorMessage, adminFloorRefusal }
import { type Context, mods } from '../trpc'

/** Who is asking, and what grade their account carries. */
export interface RoleFloorDeps {
  readonly principal: CommandPrincipal
  /** `undefined` is NOT a role: it means there is no readable, enabled account
   *  behind this principal, and it satisfies no floor. */
  readonly role: UserRole | undefined
}

/**
 * The refusal for one command, or `undefined` to proceed.
 *
 * RETURNED RATHER THAN THROWN, like both shipped gates, so the decision is
 * testable without a tRPC request and exactly one place turns it into a status.
 *
 * `qualifiedName` is `family.command` — a refusal that cannot say WHICH command
 * it refused costs the next reader the grep this whole seam exists to avoid.
 */
export function roleFloorFailure(
  qualifiedName: string,
  contract: AnyCommandContract,
  deps: RoleFloorDeps,
): TRPCError | undefined {
  const floor = contract.policy.roleFloor
  switch (floor) {
    case 'member':
      // See the header, point 1. Written as a case rather than reached by
      // falling out of an `if`, so "we decided" and "we forgot" do not look
      // alike, and so a third floor value cannot be added without deciding.
      return undefined
    case 'admin': {
      // THE ONE DECISION (PDM-299) — see {@link adminFloorRefusal}. This file
      // used to spell the rule inline, which is how it came to disagree with
      // `operations` and `workflows` about an agent.
      const refusal = adminFloorRefusal(deps.principal.kind, deps.role)
      if (refusal === undefined) return undefined
      return new TRPCError({
        code: 'FORBIDDEN',
        message: adminFloorMessage(`${qualifiedName} requires an admin account`, refusal),
      })
    }
    default: {
      const unreachable: never = floor
      throw new Error(`unhandled role floor: ${String(unreachable)}`)
    }
  }
}

/**
 * Build the gate's dependencies from a tRPC context.
 *
 * The principal is resolved from the CAPABILITY, never from the input (ADR 3
 * D7), and `parentSessionOf` walks live `spawnedBy` rows so a sub-agent's
 * delegation chain roots at exactly one human (D16.2) — the identical
 * construction `fleetAuthzDeps` and `settingsAuthzDeps` use. A second answer to
 * "who is calling" is what D7 exists to prevent.
 *
 * The role is read LIVE on every call and never cached onto anything (ADR 9 D5
 * A1): there is no serialized effective-capability snapshot, because there is
 * nothing here to serialize.
 */
export async function roleFloorDeps(ctx: Context): Promise<RoleFloorDeps> {
  const sessions = mods(ctx).sessions
  const principal = await resolvePrincipalAsync(ctx.capability, {
    parentSessionOf: async (sessionId) =>
      spawnedByParentSessionId(await sessions.sessionSpawnedBy(sessionId)),
  })
  const user = onBehalfOfUser(principal)
  return {
    principal,
    role: user === null ? undefined : await ctx.registry.sessionStore.users.roleOf(user),
  }
}

/**
 * Does this contract need the floor consulted at all?
 *
 * Exported so the builder can skip the store read for the 149 member-floor
 * contracts rather than paying a user lookup on every derived mutation — and so
 * the skip is one named predicate both the builder and its tests agree on,
 * instead of an inline comparison that could drift from {@link roleFloorFailure}.
 */
export const roleFloorIsGated = (contract: AnyCommandContract): boolean =>
  contract.policy.roleFloor === 'admin'

/**
 * REFUSE TO ASSEMBLE rather than ship an existence oracle — see the header.
 *
 * A read behind a `secret` floor must refuse the way `settings/authz.ts`
 * refuses: `NOT_FOUND` carrying the same string an instance with no secret
 * surface produces. This gate answers `FORBIDDEN`, which for such a contract
 * would announce that there is something there to be forbidden from. So the
 * builder throws at MODULE LOAD, where a procedure that refuses everything at
 * call time would look identical to a procedure nobody happened to call.
 */
export function assertNoSecretReadFloor(qualifiedName: string, contract: AnyCommandContract): void {
  const { policy } = contract
  if (policy.roleFloor === 'admin' && policy.action === 'read' && policy.resource === 'secret') {
    throw new Error(
      `${qualifiedName}: a READ behind an admin floor on a secret resource must refuse as ABSENT, ` +
        'not as FORBIDDEN, or the refusal is an existence oracle ' +
        '(docs/multi-user-readiness.md §3.1.5). Serve it through a gate that answers NOT_FOUND ' +
        'with the same string an instance without the surface produces, as modules/settings/authz.ts does.',
    )
  }
}
