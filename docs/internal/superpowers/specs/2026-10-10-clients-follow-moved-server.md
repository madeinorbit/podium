# Clients follow a moved server

| | |
|---|---|
| **Issue** | POD-5921 (child of POD-3274) |
| **Date** | 2026-10-10 |
| **Status** | Approved direction; build in the order of §12 |
| **Repos** | `podium` (this repo), `podium-cloud` (Connect worker, §8) |
| **Base** | dev/mw `b4ffb7e7a5` — facts below were read there |

## 1. Problem

A server's public origin can change while the old origin is simply gone:

- **Cloudflare quick tunnel:** every restart (reboot, dropped connection, `podium setup`) mints a new `https://<words>.trycloudflare.com`.
- **Server transfer:** the server moves to another machine.
- **Operator change:** someone changes the URL by hand.

Joined machines (daemons) already find the server again. The browser, the desktop app and the mobile app keep dialling the dead origin until a person types the new one.

**Goal:** every client gets back to the same server without anyone typing an address. When that is impossible, it behaves exactly as today.

## 2. What exists today (verified)

### Server side

- **Identity:** `<stateDir>/installation.json` holds `installationId` (`pdm_` + 43 chars) and an Ed25519 keypair (`packages/runtime/src/installation-identity.ts`).
  - Signing: `signMessage` (re-exported as `signWithInstallation`).
  - Existing domain-separation prefixes:
    - `CONNECT_REACHABILITY_PREFIX = 'podium-reachability-v1\n'`
    - `CONNECT_PROBE_PREFIX = 'podium-connect-probe-v1\n'`
  - Verifying: `verifyWithWireKey` (`packages/runtime/src/signing.ts:91`).
- **Publishing:** the server publishes its `publicUrl` to Connect with a signed `PUT /v1/installations/:id` (`apps/server/src/modules/connect/publisher.ts`).
  - It publishes on every change, at least every 5 min while the published address is behind, and daily otherwise.
  - The quick-tunnel supervisor (`native/podium-tunnel`) writes each new URL to the server.
- **Public `/version`** (`apps/server/src/server.ts:461-510`, wildcard CORS) returns `installationId` and `installationPublicKey`.
  - This is self-reported, so it proves nothing about who holds the key.
- **`/.well-known/podium`** (`apps/server/src/well-known-route.ts`) answers only cloud-signed Connect probes. **Leave it unchanged.**

### Connect (`podium-cloud/apps/connect/src/worker.ts`)

- `GET /v1/installations/:id` returns `{generation, issuedAt, expiresAt, endpoints:[{url, priority}]}`.
- The read is unsigned: the id is the capability.
- No CORS header. Rate-limited by `READ_BY_IP`.

### Daemon (`apps/daemon/src/connection-state.ts`)

- On a failed dial it calls `resolveServerUrl` (`packages/runtime/src/connect-locator.ts`). That does the Connect read, then checks the candidate's `/version` names the same id and key, then `applyServerUrl`.
- **Schedule** (constants at ~128): asks at 2/4/8 s, then every 15 s for 10 min, then every 5 min, each ±50% jitter. It is measured in scheduled backoff, not wall clock.
- The documented accepted gap: someone who controls Connect and serves any valid-HTTPS origin can claim the id and receive the daemon's credential.

### Auth (`apps/server/src/auth-route.ts`)

- **The token:** one opaque token, stored hashed and validated against the DB. It is never bound to an origin.
- **Browser and desktop webview:** get it as the `podium_session` cookie.
  - The cookie is host-only (no `Domain`), `httpOnly`, `SameSite=Lax`, 30 days.
  - **It stays host-only and httpOnly.**
- **Mobile native:** sends it as `Authorization: Bearer`, accepted only for the `mobile` label over HTTPS.
  - The bearer lives in SecureStore under `podium.mobile.profile.<profileId>.bearer.v1`.
  - `socket-login.ts:26-36` attaches it only when the socket host equals the profile's `httpOrigin`.

### CORS and the WebSocket Origin check (`apps/server/src/http-cors.ts:82`, `gateway/ws-server.ts:155`)

- Both accept a page whose Origin hostname equals the Host header.
- A page served by the new origin passes, provided cloudflared forwards the public Host. **Verify this in the lab (§11).**

### What the clients store

- None of them store the installation id or key.
- The mobile pairing envelope carries both (`packages/protocol/src/pairing.ts:57-74`; the server fills them at `mobile-pairing-route.ts:154`), but `client-core/src/accounts/pairing.ts` drops them.
- `ServerProfile` (`client-core/src/accounts/server-profiles.ts:14-31`) holds `httpOrigin` and `instanceId` (instanceId is `"default"`, not an identity).
- `reusableProfileAtOrigin` (~103-120) never joins credentials across origins.

### The `serverRelocation` frame (planned transfer)

- Sent only during a server transfer, over the LIVE socket, carrying a 10-min `server-transfer-claim` token (`apps/server/src/relay.ts:1306-1340`).
- **SocketHub:** calls `opts.onServerRelocation`, or else rewrites its socket URL (`socket-hub.ts:1950-1966`).
- **Web and mobile-web:** `browserServerRelocation` (`client-core/src/live-connection/relocation.ts`) does `location.replace` to `/auth/server-transfer-claim#token=…`.
- **Mobile native:** has no handler. It reconnects to the new origin unauthenticated. **This is a bug; fixed here.**

### Desktop (`apps/desktop/src-tauri`)

- **Window load:** in remote modes the window loads the remote origin directly (`main.rs:1945-1957`) and injects `__PODIUM_SERVER__` (`bootstrap.rs:940-955`).
- **Config:** `read_config()` runs once (`main.rs:1639`). `DesktopConfig` reads `mode`, `serverUrl`, `uiUrl`, `port`, `updateChannel` and `updateFeedEndpoint` (`bootstrap.rs:152-168`).
- **Cold start:** a dead remote origin at cold start shows the webview engine's error page.
  - The document watchdog that falls back to the BAKED dist (the bundled web app, tauri scheme) is local-mode only (`main.rs:490-535`).
- **Committed transfer helpers:**
  - `retarget_session_cookie` (`main.rs:444-480`)
  - `grant_transfer_remote_capabilities` (`main.rs:1511`)
  - per-origin capability patterns (`main.rs:1409`)

### Connect base URL

- `resolveConnectBaseUrl` (`packages/runtime/src/config.ts:2092`).
- Overridable via `PODIUM_CONNECT_URL` / `config.connect.baseUrl`.
- `PODIUM_CONNECT=off` disables publishing.

## 3. Rules (every client, daemon included)

1. **Identity.** A client stores the installation identity `{installationId, installationPublicKey}` next to the server address. It learns it:
   - from the pairing envelope, where one exists (mobile); and
   - after every AUTHENTICATED connection, by reading the current origin's `/version` and overwriting the stored identity.
   - Logging in to a server is the trust event; a server reinstalled at the same address therefore updates the identity on the next login.
   - No identity stored means following is off; the client behaves as today.
2. **Lookup.** Use the Connect record, unchanged.
3. **Proof before trust.** A candidate origin is adopted only after it signs a fresh client nonce with the installation key over its own configured `publicUrl` (§4), verified against the STORED key.
   - This replaces the `/version` self-report check everywhere and closes the documented daemon gap.
4. **Failure-triggered only, never a timer.** Locating runs while disconnected, on the shared schedule (§5.2). It also runs once at cold start when the first dial fails. A healthy connection never asks Connect.
5. **One way to move.** Every client has exactly one `adopt(move)`:
   - A Connect find and a transfer frame both go through it.
   - It persists the new origin, keeps the login where the platform allows (§7), reconnects, and shows one line: `Podium moved to <host>`.
6. **Never worse than today.** These all mean "keep retrying the old origin exactly as now":
   - no identity, Connect off/unreachable/unknown id
   - no candidate, a proof that fails or times out
   - an adopt that throws

## 4. The proof (wire contract)

### Route

`POST /.well-known/podium/locate` on the server. It is new; `/.well-known/podium` is untouched.

### Request

- Body: JSON `{"nonce":"<base64url, no padding, exactly 32 bytes>"}`, at most 1 KiB.
- Accept `content-type: text/plain` as well as `application/json`, so a cross-origin browser call is a simple request with no preflight.
- Also answer `OPTIONS` with:
  - `access-control-allow-origin: *`
  - `access-control-allow-methods: POST`
  - `access-control-allow-headers: content-type`

### Response 200

- `access-control-allow-origin: *` and `cache-control: no-store`. No cookies are read or set.
- Body:

```json
{ "installationId": "pdm_…", "publicUrl": "https://<origin>", "signature": "<base64url Ed25519, 64 bytes>" }
```

### Signed message

```
utf8("podium-locate-v1\n") || nonce (32 raw bytes) || utf8(publicUrl)
```

- `publicUrl` is the server's configured public origin, normalised to `URL.origin` with no trailing slash. It is the same value the publisher sends to Connect.
- It is NOT taken from the Host header: tunnels may rewrite Host, and the point is to bind the signature to the address the server claims.

### Errors

- 404 when the server has no installation identity or no `publicUrl`.
- 400 for a malformed body.
- 429 above 30 requests/min per client IP. The existing limiter style is fine; signing is cheap, but the route is public.

### Client verification

The candidate passes only when all of these hold:

1. HTTP 200 within the timeout (10 s).
2. `installationId` equals the stored id.
3. `URL(publicUrl).origin === URL(candidate).origin`.
4. The signature verifies under the STORED `installationPublicKey`.

**Why this is safe as a public route:**

- **Domain separation.** The message starts with its own prefix. A signature from it can never satisfy the reachability or probe contexts, and vice versa.
  - Add a test asserting the three prefixes are distinct and none is a prefix of another.
- **A relay gains nothing.** It can only obtain a signature over the real server's own `publicUrl`, which fails check 3 at any other origin.
- **Freshness.** The nonce makes each answer fresh; a recorded signature is useless.

## 5. Shared code

### 5.1 `packages/protocol/src/server-locate.ts` (pure, no I/O, RN-safe)

```ts
export interface ServerIdentity { installationId: string; installationPublicKey: string }
export const LOCATE_PROOF_PATH = '/.well-known/podium/locate'
export const LOCATE_PROOF_PREFIX = 'podium-locate-v1\n'
export function locateProofMessage(nonce: Uint8Array, publicUrl: string): Uint8Array
export function parseLocateProofRequest(body: unknown): { nonce: Uint8Array } | { error: string }
export function parseLocateProofResponse(body: unknown): LocateProofResponse | undefined
export function isServerIdentity(value: unknown): value is ServerIdentity
```

- **Shared test vectors:** `packages/protocol/src/server-locate.vectors.json`.
  - Produce them with a checked-in script from a FIXED test keypair.
  - Cases: valid; wrong key; wrong id; publicUrl ≠ candidate origin; altered nonce; trailing-slash publicUrl normalised.
  - Consumers: the server signer test, the runtime verifier test, and the Connect test (podium-cloud vendors `oss/podium`).

### 5.2 `packages/runtime/src/server-follow.ts` (RN-safe: `fetch`, `URL`, no `node:`)

This file grows out of `connect-locator.ts`:

- Move `resolveLocatorRecord` and its sanitising here.
- Delete `resolveServerUrl` and `probeVersionIdentity` once the daemon is switched (§6).
- Keep the `connect-locator` subpath as a re-export only if something outside this change imports it; otherwise remove it.

```ts
export type LocateMiss =
  | { kind: 'no-identity' }
  | { kind: 'no-record' }
  | { kind: 'no-new-address' }
  | { kind: 'rejected'; url: string; reason: string }

export async function proveServer(opts: {
  origin: string; identity: ServerIdentity; fetch?: typeof fetch; timeoutMs?: number
}): Promise<{ ok: true } | { ok: false; reason: string }>

export async function locateServer(opts: {
  identity: ServerIdentity | undefined; currentOrigin: string; connectBaseUrl: string
  fetch?: typeof fetch; timeoutMs?: number; report?: (miss: LocateMiss) => void
}): Promise<string | undefined>     // a PROVEN https origin, never the current one

export function locateDelayMs(asked: number, outageMs: number, random?: () => number): number

export type ServerMove =
  | { via: 'connect'; origin: string }
  | { via: 'transfer'; origin: string; transferId: string; claimToken?: string }

export class ServerFollower {
  constructor(opts: {
    identity: () => ServerIdentity | undefined
    currentOrigin: () => string
    connectBaseUrl: () => string
    adopt: (move: ServerMove) => Promise<void>
    locate?: typeof locateServer          // injectable for tests
    setTimeout?: …; clearTimeout?: …; random?: () => number
    log?: (event: FollowEvent) => void
  })
  disconnected(): void   // starts (or keeps) the schedule; idempotent
  connected(): void      // stops it and resets asked/outage
  pushed(move: ServerMove & { via: 'transfer' }): void  // adopt at once, no proof (§7.0)
  dispose(): void
}
```

**Details:**

- **Verifying signatures:**
  - `proveServer` verifies Ed25519 with `@noble/curves/ed25519`. That is one implementation for Bun, browsers, Hermes and Workers; Hermes has no WebCrypto Ed25519.
  - Import it with a dynamic `import()` inside `proveServer`, so it stays out of the web app's startup bundle. Keep `bun run build` in `apps/web` and its bundle budget green.
  - Nonces come from `crypto.getRandomValues`. Hermes has it via `expo-crypto`'s polyfill; check what `apps/mobile` already installs.
- **`locateServer`:**
  - Reads the record and walks the endpoints highest-priority first.
  - Skips the current origin and proves each remaining candidate.
  - Returns the first that passes. Never throws.
- **`locateDelayMs`:** is exactly today's daemon schedule (`LOCATOR_ASK_*`) and moves here verbatim, with its tests.
- **`ServerFollower`:**
  - One locate in flight at a time.
  - `connected()` cancels any pending timer and ignores the result of a locate still in flight.
  - After a successful adopt it waits for `connected()`. After an adopt that throws, it logs and continues the schedule.
  - It never adopts the current origin.
  - Log events carry the miss reasons, so a client can show "Looking for your server…" and a developer can read why.

### 5.3 `packages/client-core/src/live-connection/server-follow.ts`

```ts
export interface FollowPorts {
  loadIdentity(): ServerIdentity | undefined
  saveIdentity(identity: ServerIdentity): void
  adopt(move: ServerMove): Promise<void>
}
export function followHub(hub: SocketHub, ports: FollowPorts, opts: { connectBaseUrl: () => string; … }): () => void
```

**Hub signals:**

- The hub's connection becoming unusable → `follower.disconnected()`. Use the hub's existing connection health (`ConnectionHealthStatus 'down'`, `socket-hub.ts:~443`).
  - **First confirm** that `'down'` is reached on a FAILED INITIAL DIAL and on a closed socket, not only after a ping timeout. If it is not, add one explicit hub event for "dial failed / socket closed" rather than inferring it.
- An authenticated `'ok'` → `follower.connected()`.

**Identity capture:**

- On each authenticated `'ok'`, fetch the current origin's `/version`.
- If it names a valid identity, call `ports.saveIdentity`; overwriting is correct per rule 1.

**Transfer frame:**

- The hub's `onServerRelocation` becomes `follower.pushed({via:'transfer', …})`.
- `relocation.ts` (`browserServerRelocation`) moves into the browser adapter's `adopt`.
- The hub's built-in "rewrite my socket URL" fallback is removed; every client now has an adopt.

## 6. Daemon

- **Keep the daemon's reconnect loop.** Its backoff accounting is load-bearing. Replace only what it calls:
  - `locateDelayMs` instead of its local constants;
  - `locateServer` (with proof) instead of `resolveServerUrl`.
- **Its identity** is already in its config (installation id and key written at join). No change.
- **Transition, the one legacy path:**
  - Until the daemon has verified a proof from its server once, a candidate whose proof route answers 404 may still be accepted by today's `/version` identity check.
  - Record the first success as `connect.locateProofVerified: true` in config.json. Probe the CURRENT server's proof once after each successful connect until the flag is set.
  - After that, require the proof.
  - File a follow-up sub-issue to delete this fallback one release after this ships.

## 7. Per-client adapters

### 7.0 Trust of a pushed transfer

A `serverRelocation` frame arrives over the live, authenticated socket from the server the client already trusts, so it is adopted without the proof, exactly as today. Only a Connect find needs the proof.

### 7.1 Mobile native (`apps/mobile/src/client/MobileClientProvider.tsx`)

**Identity:**

- Add optional `installationId` and `installationPublicKey` to `ServerProfile` and its stored schema (`podium.mobile.server-profiles.v1`).
- Write them from the pairing envelope in `client-core/src/accounts/pairing.ts`, and via `saveIdentity`.
- A missing field reads as no identity (rule 1).

**`adopt`:** `moveServerProfile(profileId, newOrigin)` in `server-profiles.ts`:

- Set the SAME profile's `httpOrigin` (and derived socket URL) to the new origin. The profileId is unchanged, so the SecureStore bearer key is unchanged and `socket-login.ts` attaches it at the new origin.
- If another profile already exists at `newOrigin`:
  - **Same installation id:** delete that other profile and its credentials, then move.
  - **Different installation:** refuse (throw); the follower keeps retrying.
- Document this in `reusableProfileAtOrigin`'s comment as the one exception to "never join credentials across origins": same installation, proven by the key.
- Retarget the hub to the new socket URL, then show `Podium moved to <host>`.

**Transfer:** the same adopt with `via:'transfer'`.

- Confirm with the server-transfer tests' fixtures whether the bearer survives a transfer (the session table moves with the DB).
- If it does not, exchange the claim for a mobile bearer through a new label-preserving variant of `/auth/server-transfer-claim`. Do not add that unless the check shows it is needed.

### 7.2 Browser and mobile-web (`apps/web/src/app/AppShell.tsx`, the web branch of `MobileClientProvider`)

**Identity:** in memory only, read from `/version` after the authenticated connect. The page itself came from the server, so storing it buys nothing.

**`adopt`:**

- `via:'transfer'` with a claim: the existing `browserServerRelocation` behaviour.
- `via:'connect'`: `location.replace(origin + pathname + search + hash)`. The user logs in again at the new origin (rule: the cookie stays host-only and httpOnly).
  - Before replacing, show `Podium moved to <host>. You will need to log in there.` for ~1.5 s.

**Needs:** Connect GET with CORS (§8.1), and the proof route's CORS (§4).

**Not used** when `nativeDesktopBridge()` is present; the desktop adapter takes over.

### 7.3 Desktop window (`apps/web` desktop branch + `apps/desktop/src-tauri`)

The window runs the web app, so it uses the same `followHub`. There is **no resolver in Rust.**

**Identity:**

- Rust reads `installationId` and `installationPublicKey` from config.json (extend `DesktopConfig`, same key names the daemon join writes).
- It injects them next to `__PODIUM_SERVER__` as `__PODIUM_SERVER_IDENTITY__`.
- `saveIdentity` calls a new bridge command `save_server_identity` that writes them to config.json.

**`adopt`:** a new bridge command `move_server { origin, transferId?, claimToken? }`. It reuses the committed-transfer path in this order:

1. persist `serverUrl`/`uiUrl` in config.json
2. `retarget_session_cookie` (old origin → new)
3. `grant_transfer_remote_capabilities(new)`
4. navigate the main window to the new origin (the claim URL when a claim came with a transfer)

- Refuse a non-https origin.

**Cold start on a dead origin:**

- In remote modes, when the main window's load of the remote origin fails, load the BAKED dist with `__PODIUM_SERVER__` still set to the stored remote URL. The local document watchdog already has the mechanics; extend the rule "local windows only" to "and a remote window whose load failed".
  - A failed load is a navigation error, or a `/health` probe failing before navigation; pick the one Tauri reports reliably.
- The baked app's hub fails to dial, the follower locates, and `move_server` navigates.
- **Check first** what the baked app renders when `__PODIUM_SERVER__` points at an unreachable remote. It must show the "connecting to your server" state, not local onboarding; fix that if needed.

**With a local daemon (LocalDaemon mode):** the daemon and the window follow independently with the same core. Both write the same `serverUrl`, which is idempotent. Do not add a `connectivity.json` watcher.

### 7.4 CLI

- **`podium status`:** prints `Stable link: https://connect.podium.do/to/<installationId>` when the server has an identity and Connect publishing is on. Use `resolveConnectBaseUrl` for the host.
- **`apps/cli/src/cli-setup.ts` `startManagedTunnel` "About this address" note:** becomes these lines, one per line, no manual wrapping:
  - `The address changes whenever the tunnel restarts, for example after a reboot or a dropped connection.`
  - `Joined machines and the desktop and mobile apps follow it on their own.`
  - `In a browser, bookmark this link instead: https://connect.podium.do/to/<id>`
- **Web Settings:** where the server address is shown, show the same stable link under the same conditions, labelled "Stable link (bookmark this)".

## 8. Connect (`podium-cloud/apps/connect`)

### 8.1 CORS on the read

`handleRead` adds `access-control-allow-origin: *` to its 200 and 404 responses. A plain GET needs no preflight.

### 8.2 `GET /to/:installationId`

1. Rate-limit by `READ_BY_IP`. Parse the id with `parseInstallationId`; an invalid id gives the §8.3 page with status 404.
2. Load the row; no record gives the §8.3 page with status 404.
3. For each endpoint, highest priority first:
   - **Reuse a cached verdict:** if a verified verdict is cached for `(id, generation, url)` and is younger than 5 min, use it.
   - **Otherwise prove it:** run the §4 proof against the endpoint from the Worker. Verify with the REGISTERED public key using WebCrypto Ed25519, and the shared `locateProofMessage` from vendored `oss/podium`.
   - **Store the verdict** in D1 (new nullable columns `verified_url`, `verified_generation`, `verified_at`).
   - Use `redirect: 'manual'` and a 5 s timeout on the proof fetch.
4. **First verified endpoint:** `302 Location: <origin>/`, with:
   - `cache-control: no-store`
   - `referrer-policy: no-referrer`
   - `x-robots-tag: noindex`
5. **None verified:** the §8.3 page with status 503.

- No path passthrough in v1: the Location is always the bare origin.
- `robots.txt` already disallows everything.

### 8.3 The waiting page

A minimal HTML page with `cache-control: no-store` and `<meta http-equiv="refresh" content="10">`.

- **Text:** "Your Podium server is not reachable right now. This page checks again every 10 seconds."
- **Reflects no input:** no id, no URL.

### 8.4 Risk accepted

- **Anyone can register an installation.** The link can therefore lead to any server that runs Podium and holds its own key.
  - The proof stops a redirect to a host that does not.
- **Takedown** deletes the row.

### 8.5 Deploy

- Implement and test in podium-cloud on a branch.
- Deploying Connect to production is outward-facing: **ask the user before deploying.**
- Clients must tolerate the old Connect: no CORS just means the browser tab cannot follow; no `/to` means the link 404s.

## 9. Failure behaviour

| Situation | Result |
|---|---|
| No identity stored | today's behaviour |
| Connect off (`PODIUM_CONNECT=off`) or down | retry the old origin; ask again on the schedule |
| Record names only the current origin | `no-new-address`; ask again on the schedule |
| Candidate unreachable, slow (>10 s), 404 on the proof route, bad signature, wrong id, `publicUrl` ≠ candidate | rejected with that reason; next endpoint; else schedule |
| `adopt` throws (e.g. mobile profile clash with another installation) | logged; schedule continues |
| Transfer frame arrives | adopt at once (§7.0) |
| Daemon talking to a server without the proof route, never verified one | today's `/version` check (§6 transition) |

## 10. Security summary

- **Discovery is untrusted.** Connect only names candidates.
- **Adoption requires possession of the installation private key,** proven over a fresh nonce and bound to the candidate origin.
- **Credentials only ever travel to a proven origin,** or to an origin pushed by the already-authenticated server.
- **Browser cookies never move.** The browser user logs in again.
- **The remaining trust root** is the identity captured at pairing or first authenticated login (TOFU). That is the same root the session itself has.

## 11. Tests

Focused tests only, run on flatblock (procedure in the brief). Do not run the full suite.

- **protocol:** message bytes; parsers; prefix distinctness; the vectors file.
- **server:** the route signs the vectors; 404 without identity or `publicUrl`; 400 on a bad body; CORS and OPTIONS; no cookie touched.
- **runtime:**
  - `proveServer` against the vectors.
  - `locateServer` with fake fetch, covering every §9 row.
  - `locateDelayMs`: the moved daemon schedule tests.
  - `ServerFollower` with fake timers: idempotent `disconnected()`; `connected()` cancels; in-flight result ignored after `connected()`; adopt throws then continues; `pushed` adopts without locate.
- **client-core:** `followHub` with a fake hub; identity capture on authenticated `'ok'` only.
- **mobile:**
  - `moveServerProfile`: same profile id; bearer key unchanged; clash rules.
  - The pairing envelope stores the identity.
  - The transfer frame no longer loses auth.
- **web:** the adapter builds the right replace URL; it is not used under the desktop bridge.
- **desktop (Rust unit tests):**
  - `DesktopConfig` reads and writes the identity.
  - `move_server` refuses non-https.
  - Cold-start fallback decision for remote modes.
- **daemon:** existing connection-state tests keep passing on the moved schedule; proof required after the flag; legacy fallback before it.
- **Connect (podium-cloud):** CORS on the read; `/to` 302 on a verified endpoint, 503 page otherwise, 404 on an unknown id; verdict caching per generation; vectors.

### Lab drill (tools/vps-lab, vps1 server on a quick tunnel)

For each client (browser tab open, desktop client-only, mobile), run:

1. Client open → `systemctl --user restart podium-tunnel` on vps1 → the client lands on the new origin.
   - Browser: lands on the login page there.
   - Native: still logged in.
2. Client closed → restart the tunnel → cold-start the client → same result.
3. Connect blocked with iptables (see `tools/vps-lab/PLAYBOOK.md` 5b) → the client keeps retrying the old origin; after unblocking, it follows.
4. Bookmark `connect.podium.do/to/<id>` → lands on the current origin. While the tunnel is down, it shows the waiting page and then lands.

Also confirm in the lab that cloudflared forwards the public Host, so CORS and the WS Origin check pass at the new origin (§2).

## 12. Order of work

Each step is its own commit and keeps everything green.

1. protocol `server-locate` + vectors; the server route; runtime `proveServer`/`locateServer`/`locateDelayMs`/`ServerFollower`; daemon switched (§6).
2. podium-cloud: CORS on the read, `/to/:id`, the waiting page, D1 columns. Not deployed without the user.
3. client-core `followHub`; the transfer frame routed through it.
4. Mobile adapter + identity in profiles + the transfer fix.
5. Web adapter; stable link in `podium status`, the setup note and Settings.
6. Desktop: config identity, `save_server_identity`, `move_server`, cold-start baked fallback.
7. Delete `resolveServerUrl`, `probeVersionIdentity` and the hub's URL-rewrite fallback. File the daemon-fallback removal follow-up.

## 13. Not in scope

- Pushing location changes to clients.
- Installation key rotation.
- Carrying the browser login across origins.
- A Podium-hosted stable hostname.
- Changes to `/.well-known/podium` or Connect's reachability check.
