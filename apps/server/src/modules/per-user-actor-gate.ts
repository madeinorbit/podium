/**
 * THE PER-USER WRITE GATE AS A PORT (PDM-308) — the live account check that
 * `layout` and `read-position` already performed in their own `trpc.ts`, and the
 * actor it resolves, pre-bound to ONE caller so a derived handler can ask for
 * the user its row is keyed by without ever being handed an authority object.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SURVIVED THE MOVE TO THE BUILDER INSTEAD OF FOLDING INTO THE FLOOR
 * ---------------------------------------------------------------------------
 *
 * `PDM-297` folded `operations`' hard-coded `admin` comparison into the floor
 * the contracts already declared, because `derivedFamilyProcedures` enforces
 * `contract.policy.roleFloor` since `PDM-294`. The obvious move here was the
 * same one, and it is WRONG, which is worth writing down because the shape of
 * the two families looks identical from outside.
 *
 * `layout.set`, `layout.clear` and `readPosition.advance` all declare
 * `roleFloor: 'member'`, and `roleFloorFailure` returns `undefined` for the
 * `member` floor BY DECISION — `role-floor.ts`'s header, point 1: treating an
 * ABSENT role as satisfying no floor is correct, but applying it to `member`
 * would newly refuse every principal with no account row across 149 contracts,
 * including an open-mode instance before anyone has been adopted.
 *
 * These two families already apply exactly that stricter rule to their own
 * member floor, and have since POD-402 review gap 1: a disabled principal that
 * still resolves to a human is refused before the store is reached. Two tests
 * pin it by name — `layout/authz.test.ts` and `read-position/authz.test.ts`,
 * "refuses when the live role is missing (disabled / no account)". Deleting the
 * per-family gate in favour of the builder's floor would therefore have REOPENED
 * the gap the gate was written to close, while every instrument stayed green,
 * which is the failure this whole epic is about.
 *
 * So the floor stays where it is and the gate becomes a PORT. The family asks;
 * it cannot read a role out of what comes back, cannot see a capability, cannot
 * mint a principal, and cannot phrase a different question. That is the THIRD
 * position in `derived-family.ts`'s "THE DECISIONS THIS FILE DOES TAKE", argued
 * once there and not re-argued here.
 *
 * ---------------------------------------------------------------------------
 * ONE PORT, TWO FAMILIES
 * ---------------------------------------------------------------------------
 *
 * `layout/authz.ts` and `read-position/authz.ts` are the same file twice — same
 * `ROLE_RANK`, same `roleSatisfiesFloor`, same deps/failure/actor triple — and
 * the `authorizeWrite` wrappers their routers wrapped them in were identical
 * down to the refusal string. This file is that wrapper, written ONCE and
 * parameterised by the triple, so a third per-user family cannot arrive with a
 * fourth copy of a refusal message. The two `authz.ts` modules keep their own
 * decisions and their own tests; what is shared here is only the sequencing.
 */

import type { UserId } from '@podium/model'
import { TRPCError } from '@trpc/server'

/**
 * WHO THIS WRITE BELONGS TO — the ANSWER, not the authority to decide it.
 *
 * `requireActor` either returns the enabled human whose row is about to be
 * written, or throws the refusal the family's own gate produced. There is no
 * arm that returns "refused" as data for a handler to inspect and proceed past.
 */
export interface PerUserActorGate {
  requireActor(name: string): Promise<UserId>
}

/**
 * Bind one family's gate to one caller.
 *
 * The order is the one both routers used and is load-bearing: resolve the live
 * deps, refuse on the floor, THEN resolve the actor — so a principal below the
 * floor is refused without the actor lookup, and a principal with no
 * on-behalf-of human is refused rather than writing a row keyed by nobody.
 */
export function perUserActorGate<D>(
  resolveDeps: () => Promise<D>,
  failureFor: (name: string, deps: D) => TRPCError | undefined,
  actorOf: (deps: D) => UserId | null,
): PerUserActorGate {
  return {
    async requireActor(name: string): Promise<UserId> {
      const deps = await resolveDeps()
      const refusal = failureFor(name, deps)
      if (refusal) throw refusal
      const actor = actorOf(deps)
      if (actor === null) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `${name} writes on behalf of a user, and this principal has none`,
        })
      }
      return actor
    },
  }
}
