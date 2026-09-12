/**
 * WHICH MACHINES THIS CALLER MAY SEE A NATIVE LOGIN ON.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ACCOUNTS FAMILY NEEDS THIS AT ALL
 * ---------------------------------------------------------------------------
 *
 * `accounts.list` returns two kinds of row. The MANAGED rows are the instance's
 * stored provider credentials. The NATIVE rows are observed: a harness login
 * identity, the machine NAMES it was seen on, and the online machines that
 * harness is installed on. A native row is therefore a statement about where a
 * particular person works, which is the owned-compute boundary (execution
 * charter: exactly one human may execute on a machine) rather than anything
 * about the accounts table.
 *
 * ---------------------------------------------------------------------------
 * `use`, NOT `see`, AND THE VERB IS THE DECISION
 * ---------------------------------------------------------------------------
 *
 * `see` answers "may you know this machine exists". That is not the question a
 * native account row asks. The row exists so the Accounts hub can say which
 * provider login an agent spawned HERE would authenticate as, and `accounts.login`
 * — the write that changes it — is already `machineVerb: 'use'`. A row built from
 * a machine the caller may see but may not execute on would describe somebody
 * else's provider account and offer a login target the server would refuse, which
 * is readiness §3.1.4 M5's "the spawn surface must not OFFER a machine the
 * principal lacks `use` on" from the reading side.
 *
 * ---------------------------------------------------------------------------
 * THE ROLE ARGUMENT IS NOT CONSULTED ON THIS PATH, AND THAT IS CHECKED
 * ---------------------------------------------------------------------------
 *
 * {@link userCommandPrincipal} needs a `UserRole`, and this module has only a
 * `UserId` — the accounts family's state carries identity and deliberately no
 * capability. The role is passed as `'member'` rather than looked up because
 * `machineVerbsFor` cannot reach a different answer for `use` with a different
 * role: its only role-sensitive arm is an UNOWNED machine (`row.owner === null`),
 * where an admin gains `see` so it can assign an owner and NOBODY gains `use`.
 * Every other arm is ownership and grant edges, neither of which mentions a role.
 *
 * That is an argument rather than a fact, so `list-scope.test.ts` measures it
 * instead: the same caller against the same fleet is refused `use` on the same
 * machines as a member and as an admin. (The role does move the refusal WORD on
 * an owner-less machine, and the test pins that too, so the claim above is exact
 * rather than approximately true.) If a change makes the role matter to the
 * verdict, that test goes red and this comment stops being load-bearing.
 *
 * NO SECOND SPELLING OF THE RULE. `checkMachineUse` and
 * `ownershipSnapshotFromMachines` are `machine-access.ts`'s, imported and not
 * restated; this module chooses the verb and nothing else. Both the ownership
 * rows and the grant edges are read LIVE per call (ADR 9 D2 rule 4), so a
 * revoked grant stops the NEXT read with no invalidation step.
 */

import type { MachineId, UserId } from '@podium/model'
import { userCommandPrincipal } from '../../command-principal'
import {
  type AsyncMachineRowSource,
  checkMachineUse,
  ownershipSnapshotFromMachines,
} from '../../machine-access'

/**
 * The machine ids `caller` may execute on.
 *
 * A SET OF IDS rather than a filtered listing, because the two projections this
 * feeds are different types — `accountViews` takes stored `MachineRecord`s and
 * the login-target list takes the service's wire listings — and filtering each
 * against one resolved answer is what keeps them from disagreeing. Resolving the
 * question twice is exactly how one arm of a read ends up gated and the other
 * not.
 */
export async function machineIdsUsableBy(
  machines: AsyncMachineRowSource,
  caller: UserId,
): Promise<ReadonlySet<MachineId>> {
  const ownership = await ownershipSnapshotFromMachines(machines)
  const principal = userCommandPrincipal(caller, 'member')
  const rows = await machines.ownershipRows()
  return new Set(
    rows
      .filter((row) => checkMachineUse(principal, row.id, ownership) === undefined)
      .map((row) => row.id),
  )
}
