import type { Capability } from '@podium/model'
import { FIRST_ADMIN_USER_ID } from '@podium/model'

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
 * `FIRST_ADMIN_USER_ID` "survives only as a migration artefact: the first
 * account of an upgraded instance". That is a real, migrated USER. This is a
 * capability shape for tests, which is a different thing, and separating them is
 * the point of the move.
 */
export const OPERATOR: Capability = {
  role: 'admin',
  scope: { kind: 'all' },
  actorUser: FIRST_ADMIN_USER_ID,
  onBehalfOf: FIRST_ADMIN_USER_ID,
}
