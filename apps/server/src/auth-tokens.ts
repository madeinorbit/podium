import { createHash } from 'node:crypto'

// A leaf: nothing here imports another apps/server module, so any module that needs to
// hash a bearer token can depend on it without depending on the auth route. `hashToken`
// used to live in `./auth-route`, which made every holder of a token hash — invites,
// pairing, the relay — an importer of the login surface. `./plugin-auth` is imported BY
// `./auth-route` and imports `./member-invites`, so the moment invites needed a token hash
// that was a runtime cycle (auth-route → plugin-auth → member-invites → auth-route).
// `scripts/server-composition-graph.ts` refuses such a cycle; keep this module a leaf.

/** The at-rest form of a bearer token: sessions, invites and pairing claims all store
 *  the hash and never the token, so a database read cannot recover a usable credential. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
