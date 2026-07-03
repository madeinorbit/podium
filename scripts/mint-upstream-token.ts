/**
 * Mint an upstream sync token ON THE HUB (docs/spec/node-hub-sync.md §2.1).
 *
 * Inserts a long-lived client_sessions row into the hub's podium.db and prints the
 * plaintext token ONCE (only its sha-256 is stored). Put the value into the NODE's
 * `~/.podium/config.json`:
 *
 *   { "upstream": { "url": "https://hub.example:18787", "token": "<printed token>" } }
 *
 * Usage (run on the hub machine; PODIUM_STATE_DIR selects a non-default state dir):
 *
 *   bun scripts/mint-upstream-token.ts
 *
 * Revoke by deleting the row (the token is an ordinary revocable client session):
 * the registry equivalent is `store.deleteClientSession(sha256(token))`, or "sign
 * out everywhere" in the UI (deleteAllClientSessions) which also cuts nodes off.
 *
 * Safe against a RUNNING hub server: the insert is a single WAL-mode write to a
 * table only touched at login/logout.
 */
import { mintUpstreamTokenInto } from '../apps/server/src/relay'
import { SessionStore } from '../apps/server/src/store'

const store = new SessionStore()
try {
  console.log(mintUpstreamTokenInto(store))
} finally {
  store.close()
}
