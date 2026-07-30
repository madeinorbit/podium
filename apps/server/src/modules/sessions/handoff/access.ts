/**
 * THE `use`-VERB CHECK POINT for handoff — POD-642, readiness §3.1.4 / ADR 3
 * Amendment 1 D18.
 *
 * ===========================================================================
 * THIS FILE IS A SEAM WITH A KNOWN SUCCESSOR, AND THAT IS THE POINT
 * ===========================================================================
 *
 * Machine ownership (`owner` + a per-machine grant list) is POD-1079's
 * deliverable and the `machines` table has neither yet; the shared resolver is
 * POD-381's `apps/server/src/machine-access.ts`
 * (`checkMachineUse(principal, machineId, ownership)` →
 * `'absent' | 'unauthorized' | undefined`), which is not on this branch at the
 * time of writing. So this module defines WHERE the decision is taken and hands
 * the coordinator an {@link AssertMachineUse}; what it is backed BY is one
 * function call, replaced by POD-381's `ctx.assertMachineUse` and POD-1079's
 * grant table without moving the check point. That ordering is deliberate — the
 * brief asks for the check point now so that enabling real grants is a POLICY
 * change and not a second migration through the handoff path.
 *
 * ===========================================================================
 * WHY THE TWO FAILURES ARE SPELLED THE WAY THEY ARE
 * ===========================================================================
 *
 * `absent` covers a machine that does not exist AND a machine the principal
 * cannot `see`, with ONE message. That is §3.1.5's consistent-error rule applied
 * to machines: if an invisible machine answered differently from a nonexistent
 * one, the handoff path would be a fleet-enumeration oracle — probe ids, read the
 * errors, learn a colleague's machine list. The general question of which
 * existence facts may leak is left open by §3.1.2 and is NOT settled here; what
 * is settled is the default-closed reading for this one surface, taken from the
 * shared helper rather than decided per handler.
 *
 * `unauthorized` is reachable only for a machine the principal CAN see. That is
 * what makes "denied" distinguishable from "offline" (§3.1.4 M5): a machine you
 * can see but may not use says so, and never gets silently retargeted to
 * somewhere you can use. Both halves of M5 fail in the same direction — closed.
 */

import type { Capability } from '@podium/model'
import { machineUseAllowed, type ResolvedMachine, type UserId } from '@podium/protocol'
import type { AssertMachineUse } from './ports'

export type MachineUseFailure = 'absent' | 'unauthorized'

/**
 * The rendered refusal. Replaced by POD-381's `machineAccessMessage` at the
 * merge; kept identical in SHAPE (failure + machine id) so the swap is a call
 * change and not a message change.
 */
export const machineUseMessage = (failure: MachineUseFailure, machineId: string): string =>
  failure === 'absent'
    ? `unknown machine '${machineId}'`
    : `not authorized to use machine '${machineId}'`

export class MachineUseDenied extends Error {
  constructor(
    readonly failure: MachineUseFailure,
    readonly machineId: string,
  ) {
    super(machineUseMessage(failure, machineId))
    this.name = 'MachineUseDenied'
  }
}

/**
 * TODAY'S BACKING for the check point, and a deliberately narrow one.
 *
 * Until POD-1079 lands `owner` + grants there is nothing to resolve a per-machine
 * grant FROM, so the only holder of `use` is an admin-scoped capability — which
 * is exactly what every shipped call site is (`sessions.handoff` is exposed on
 * `trpc` only, and "every HTTP caller is the OPERATOR today" per the router
 * context). So this preserves current behaviour for every real caller while
 * refusing a constrained principal rather than guessing a grant for it.
 *
 * A NON-ADMIN PRINCIPAL IS TOLD `absent`, NOT `unauthorized`. It holds no `see`
 * on any machine either — there is no grant list to hold one in — and
 * `unauthorized` is defined as reachable only inside the see set. Answering
 * `absent` is therefore both the fail-closed direction and the non-leaking one.
 *
 * IT DOES NOT ANSWER WHETHER THE MACHINE EXISTS, and that is a correction rather
 * than an omission: a first draft refused an id that was not in the machine list,
 * which looked like defence in depth and was a regression. Existence and
 * reachability are the choreography's own answers ('target machine is offline'),
 * and folding them into the rights gate refused a handoff FROM the local machine
 * on any install whose `local` row is written lazily — `oracle-errors.test.ts`
 * has exactly that fixture. The invisible-equals-nonexistent property belongs to
 * the grant backing below, where visibility is a concept at all; under an
 * admin-only backing there is no invisible machine to conflate with a missing one.
 */
export const legacyAdminMachineUse =
  (deps: { capability: Capability }): AssertMachineUse =>
  (machineId: string) => {
    const admin = deps.capability.role === 'admin' && deps.capability.scope.kind === 'all'
    if (!admin) throw new MachineUseDenied('absent', machineId)
  }

/**
 * THE SHAPE POD-1079's GRANT TABLE PLUGS INTO — built here so the denial paths
 * this issue must prove are testable before the table exists, and so landing the
 * table is a swap at the composition root rather than new logic in the handler.
 *
 * `use` resolution itself is NOT re-derived: it is `machineUseAllowed` from
 * `@podium/protocol` (the all-in-one guard — an owner-less machine grants `use`
 * to NOBODY), read through the ownership record this resolver is given. `see` is
 * owner, any grant holder, or an admin (§3.1.4 M1's default holders).
 */
export const grantedMachineUse =
  (deps: {
    /** The subject rights resolve for: the on-behalf-of human (ADR 9 D5 A1).
     *  A function, not a value — rights are re-resolved on every call, which is
     *  what makes the apply-time checkpoints in the coordinator mean anything. */
    subject: () => UserId | null
    admin: () => boolean
    ownershipOf: (machineId: string) => ResolvedMachine | undefined
  }): AssertMachineUse =>
  (machineId: string) => {
    const ownership = deps.ownershipOf(machineId)
    const subject = deps.subject()
    // `see` has no shared helper (the verb table is POD-1079's), so it is
    // resolved here: owner, any grant holder, or an admin — §3.1.4 M1's default
    // holders. Not visible ⇒ answer exactly as for a machine that does not exist.
    const canSee =
      ownership !== undefined &&
      (deps.admin() ||
        (subject !== null &&
          (ownership.owner === subject ||
            ownership.grants.some((grant) => grant.subject === subject))))
    if (ownership === undefined || !canSee) throw new MachineUseDenied('absent', machineId)
    // `use` IS the shared helper. Not re-derived here on purpose: it is the
    // all-in-one guard (an owner-less machine grants `use` to NOBODY), and a
    // second copy of that rule is how one of them ends up fail-open.
    if (!machineUseAllowed(ownership, subject)) throw new MachineUseDenied('unauthorized', machineId)
  }
