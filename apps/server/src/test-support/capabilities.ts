import type { Capability, WorkspaceId } from '@podium/model'
import { firstAdminMemberId } from '@podium/model'
import {
  type AsyncDelegationIndex,
  type CommandPrincipal,
  type DelegationIndex,
  resolvePrincipal,
  resolvePrincipalAsync,
} from '../command-principal'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'

/**
 * THE UNCONSTRAINED ADMIN CAPABILITY — a TEST FIXTURE, and only that.
 *
 * This constant used to be `OPERATOR`, exported from `packages/model`'s public
 * authz surface and documented as "the human operator (and, for now, the trusted
 * in-process MCP): unconstrained". POD-333 moved it here because that
 * description had stopped being true of anything the product does.
 *
 * Under a single shared password there was exactly one human, and `OPERATOR` was
 * the answer to "who is calling?" — `resolvePrincipal` minted it, and
 * `authorize()` short-circuited on its `scope: 'all'`. Once principals became
 * `(user, device, capability)` (POD-1075/POD-1079, ADR 9 D1), every production
 * caller resolves a real one from the authenticated transport, and a repo-wide
 * search found **no production reader of this constant at all** — only tests,
 * the server's oracle support, and a comment. A model-level export that nothing
 * in the model's own layer constructs is a shim by the plain meaning of the
 * word: a name kept so that import sites need not change.
 *
 * Keeping it in `packages/model` was worse than untidy. `authorize()` treats
 * `scope: 'all'` as a short circuit, so a test written against this capability
 * exercises the short circuit rather than the policy — POD-351 lost real
 * revocation coverage that way, and `packages/sync`'s conformance suite still
 * carries the note explaining why ("every revocation test ran as OPERATOR, which
 * short-circuits"). A fixture that makes a whole class of test vacuous belongs
 * where a reader can see it is a fixture.
 *
 * So: use it where the caller genuinely is "the instance admin, unconstrained".
 * Do NOT reach for it to make an authorization test compile — that is the
 * short-circuit trap, and the constrained capabilities the same tests build by
 * hand are what actually exercise `authorize()`.
 *
 * ADR 9 D1.5 keeps the identity half of this alive under its own name:
 * `firstAdminMemberId()` "survives only as a migration artefact: the first
 * account of an upgraded instance". That is a real, migrated USER. This is a
 * capability shape for tests, which is a different thing, and separating them is
 * the point of the move.
 *
 * AMBIENT PRINCIPAL, DELIBERATE (POD-1669). The two `firstAdminMemberId()` uses
 * below are counted by the ambient-principal census — this file is not named
 * `*.test.ts`, so the census's path filter cannot see that it is a fixture, and
 * that is the honest outcome: a fixture is still a place the identity is
 * assumed. NO CALLER EXISTS TO RESOLVE: a constant has no request behind it. They
 * are held at the baseline rather than excluded by path, because widening the
 * census's blind spot to `test-support/` would let a real production site hide
 * there later. See `scripts/audit-ambient-principals.ts` BASELINE.
 */
export const OPERATOR: Capability = {
  // The workspace a fixture's store opens by default: a test of another
  // workspace stamps its own (POD-7558).
  workspaceId: SELF_HOSTED_WORKSPACE_ID,
  role: 'admin',
  // A person carries the member scope, admins included (design §4.1,
  // POD-6288): this fixture is the first admin as production mints it.
  scope: { kind: 'owned', userId: firstAdminMemberId() },
  actorUser: firstAdminMemberId(),
  onBehalfOf: firstAdminMemberId(),
}

/**
 * A PERMISSIVE FIXTURE PRINCIPAL (POD-7558), named so at every call site.
 * Production resolves a capability in a store, against that store's member
 * rows and session owners (`SessionAuthz.principalFor`). A test that builds a
 * context by hand has no such rows to ask, so this answers the way such a
 * fixture means it, and that is weaker than production on purpose:
 *  - every person is a member (no membership check);
 *  - an agent acts for the human its capability names: the on-behalf-of
 *    fallback production removed, kept here only for fixtures with no
 *    session rows;
 *  - a session has no parent.
 * So a test that uses it proves nothing about delegation or membership. Those
 * rules are tested through the served resolver (`capability-workspace.test.ts`,
 * `capability-principal.test.ts`) and the resolver itself
 * (`command-principal.test.ts`). A test that needs real answers passes its own
 * index members, which replace these.
 *
 * The workspace check is NOT relaxed: a capability of another workspace is
 * refused here exactly as in production.
 */
export function permissiveFixturePrincipal(
  workspaceId: WorkspaceId,
  capability: Capability,
  delegations: Partial<DelegationIndex> = {},
): CommandPrincipal {
  return resolvePrincipal(workspaceId, capability, {
    parentSessionOf: () => undefined,
    onBehalfOfFor: () => capability.onBehalfOf,
    isMember: () => true,
    ...delegations,
  })
}

/** {@link permissiveFixturePrincipal} over an index whose members answer asynchronously. */
export async function permissiveFixturePrincipalAsync(
  workspaceId: WorkspaceId,
  capability: Capability,
  delegations: Partial<AsyncDelegationIndex> = {},
): Promise<CommandPrincipal> {
  return await resolvePrincipalAsync(workspaceId, capability, {
    parentSessionOf: () => undefined,
    onBehalfOfFor: () => capability.onBehalfOf,
    isMember: () => true,
    ...delegations,
  })
}
