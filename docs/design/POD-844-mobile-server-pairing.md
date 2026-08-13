# Mobile server pairing

Status: recommended design for review, 2026-08-12. This is a design proposal, not an implementation plan already in progress.

## Recommendation

Ship a **server profile switcher with QR pairing as the primary path, manual URL entry as the fallback, and explicit approval on an already signed-in Podium screen before the phone receives a session**.

The server creates a two-minute, single-use **mobile join code** containing its URL and a narrow pairing secret. The QR is an HTTPS URL such as `https://podium.example/mobile#pair=<envelope>`: the fragment stays out of server request logs, an installed native app can scan it in-app, and a person without the app can scan it with the system camera and land in the already-working web-mobile client. The phone announces a locally generated device name and shows a three-word verification phrase. The signed-in browser that created the QR shows the same phrase and asks the person to approve that phone. Only then does the server issue a normal, individually identified human-client session. The QR never contains a durable session.

This should extend Podium's existing join-code vocabulary and short-lived in-memory code machinery, but it should **not** redeem through the existing daemon endpoint. Daemon pairing creates a machine identity able to host agents; phone pairing creates a human client session for the user who minted the code. Those are different principals and must remain different authorization paths.

For transport, trusted HTTPS is the full native path. Tailscale Serve is the recommended private setup and a conventional reverse proxy with a public CA is the recommended public setup. Release-native builds reject all cleartext HTTP, including direct LAN addresses; web-mobile served from an HTTP development origin remains bound to that page origin. A password or pairing credential must never be sent over HTTP. Self-signed HTTPS is accepted only after its CA has been installed and trusted by the OS; the app must not offer “ignore certificate errors.” Native sessions use an explicit bearer token stored in Keychain/Keystore, while web-mobile keeps the existing HttpOnly cookie path.

## The experience

### Native app versus web-mobile

`apps/mobile` has two products sharing one React Native tree, and onboarding must preserve that distinction:

- **Expo native (`Platform.OS !== 'web'`):** there is no page origin. It uses the persisted profile switcher described below. With no profile it shows scan/manual onboarding. Scanner code and `expo-camera` load only here.
- **Expo web-mobile (`Platform.OS === 'web'`):** Podium serves it at `/mobile`, so `window.location.origin` is already the correct server. Treat that origin as an implicit, non-removable, non-switchable profile; mount the current auth/client stack immediately. A normal browser opening `/mobile` therefore just works and never sees “scan a QR.” If the URL contains `#pair=…`, the web client consumes the fragment, immediately replaces the route to remove it from navigation history, and enters the same claim/approval ceremony.

Keep the existing `?server=` behavior as an explicit ephemeral development/test override. It is never persisted into the native profile list or shown as a normal saved server, and the UI displays a small “server override” banner while it is active. Redirects must continue preserving it for the existing harness.

### First launch

On native only, do not construct `AuthGate`, tRPC, the socket, or a replica until a server profile has been selected. With no profiles, replace the current unreachable-loopback launch with a real welcome screen:

> Connect to your Podium<br>
> Scan the code shown in Podium on your computer.

- Primary: **Scan QR code**
- Secondary: **Enter server address**
- Help: **Where is my code?** → “On your computer, open Settings → Connected devices → Pair a phone.”

Camera permission is requested only after the scan button is tapped. The scanner recognizes only a versioned Podium pairing URL, gives haptic feedback on a valid scan, and immediately closes the camera. The primary QR uses the server's HTTPS `/mobile#pair=…` URL so the stock camera also works without an installed app. The existing `podium` custom scheme remains a secondary “Open in app” bridge, not the credential's primary container, because custom schemes are not exclusively owned on either mobile platform. Any deep-link route must consume the payload and call router `replace()` immediately so the secret does not remain in navigation state.

After a valid scan, the phone shows the normalized origin before making a credential-bearing request:

> **Connect to Alice's Podium?**<br>
> `podium.alice.ts.net` · Private Tailscale connection

The phone proposes a friendly device name such as “Sam's iPhone,” editable before continuing. Once it claims the pairing request, both screens show the same three memorable words:

> **velvet · orbit · pine**<br>
> Confirm these words on your computer.

The computer shows “Sam's iPhone wants to connect,” the origin, the same phrase, **Approve**, and **Deny**. Approval signs the phone in as the same user who created the QR. Native transitions directly into the app and offers to rename the server profile; the hostname is a good default. Web-mobile simply opens the already-origin-bound app.

This extra confirmation is deliberate. It costs one click during a rare setup action and changes a photographed QR from “instant account access” into “a visible request the owner can reject.”

### Adding and switching servers

Native Settings gets a **Servers** section rather than a read-only server row:

- Each profile shows a friendly name, normalized host, current account, reachability, and transport grade.
- **Add server** returns to the same scan/manual sheet.
- Tapping a profile switches it. The app tears down the current socket/client/replica and remounts them for the selected profile.
- Rename, reconnect, remove, and log out are per profile.
- Removing a reachable profile first revokes that phone's session, then erases only that profile/account's local replica. If the server is unreachable, the app explains that local removal cannot revoke the server-side session and links to the server's Connected devices screen.

Persist non-secret profile metadata and the selected profile in AsyncStorage. Give every local profile a random immutable `profileId`, and namespace replica state by `profileId + userId`; `userId` alone is not sufficient because two unrelated Podium servers commonly use the same account ID. Store each native bearer token in `expo-secure-store` (iOS Keychain / Android Keystore), keyed by `profileId`, never in profile JSON or AsyncStorage. Removing one profile must call the existing principal-scoped erase paths (`store.erasePrincipal` plus namespace erase); it must never delete the shared `podium-replica.db` file, which contains other profiles too.

### Manual fallback

Manual entry accepts `https://`, `http://`, `wss://`, or `ws://`, uses the existing `parseServerOrigin()` normalization, then probes the open `/version` endpoint. The result distinguishes:

- not a Podium server;
- Podium version incompatible with this app;
- host unreachable;
- TLS certificate untrusted;
- cleartext connection disallowed;
- reachable, with login required or open mode.

A trusted HTTPS server continues through the existing password/login gate when it was not QR-paired. An open HTTPS server connects without inventing a credential. Native HTTP is rejected before contact. On native, the URL is saved only after the preflight succeeds or the user explicitly chooses “Save anyway” for a temporarily offline, otherwise valid HTTPS origin. Web-mobile already owns its page origin and does not persist a second server profile.

## Protocol design

### Reuse the join vocabulary, not the daemon identity

Podium already has the right conceptual primitive:

- [`JoinPayload`](../../packages/runtime/src/join.ts) is a versioned, base64url JSON envelope carrying `serverUrl + pairCode`.
- [`PairingManager`](../../apps/server/src/hub/pairing.ts) issues random, expiring, single-use, in-memory codes.
- [`buildJoinCommand()`](../../apps/server/src/hub/machines-join.ts) sources the advertised URL from server configuration.
- `podium setup --join`, `podium join-config`, and `podium set-server <url|join-code>` all share the same decode/apply vocabulary through [`applyJoin()`](../../packages/runtime/src/setup.ts).

Keep daemon payload v1 compatible and make the envelope an additive discriminated union:

```ts
type PairingEnvelope =
  | { v: 1; kind?: 'machine'; serverUrl: string; pairCode: string; /* existing fields */ }
  | {
      v: 2
      kind: 'mobile-client'
      mode: 'pair'
      serverUrl: string       // canonical http(s) origin, normally https
      pairCode: string        // >=128 random bits, two-minute TTL
      expiresAt: string       // UX only; server time remains authoritative
      instanceId: string      // preflight/collision signal, not a global identity
    }
  | {
      v: 2
      kind: 'mobile-client'
      mode: 'open'
      serverUrl: string       // URL configuration only; no credential exists
      instanceId: string
    }
```

Move the shared envelope schema and codec to an RN-safe package such as `@podium/protocol`; the current `packages/runtime/src/join.ts` codec uses Node `Buffer` and cannot be imported into the Expo native graph. Use a Buffer-free UTF-8/base64url implementation there and have `@podium/runtime` re-export it so existing CLI/daemon consumers keep one source of truth.

Encode the QR as `https://<server>/mobile#pair=<base64url-envelope>`. The code is still a bearer secret even though it is inside a friendly URI. Reject userinfo, non-HTTP(S) destinations after normalization, fragments supplied inside `serverUrl`, oversized payloads, unknown versions/kinds, and expired timestamps before contact. The outer URL origin and the envelope's normalized origin must match.

Generalize the in-memory pairing primitive to typed grants and typed redemption so a machine code cannot be redeemed at a client endpoint or vice versa. A wrong endpoint must not consume the code. Mobile pairing gets a short TTL because it has no package installation delay; the daemon's current one-hour TTL can remain unchanged.

Do **not** call `machines.pairingCode` or send a `pair` frame to `/daemon` from the phone. That endpoint deliberately mints a long-lived machine token, creates a machine row, and is admin-grade because it admits compute. Reusing it would make the phone appear as an agent host and would collapse the human-client and machine trust domains. Reuse its codec, URL source, redaction classification, and single-use store; add a typed client ceremony under the auth surface.

### Ceremony and endpoints

1. An authenticated human selects **Pair a phone**. `auth.mobilePairingStart` records an in-memory grant bound at mint time to that caller's `userId`, returns the mobile envelope, and never replicates or logs it. Its own claim throttling is independent from `/auth/login`, so pairing abuse cannot lock out password login.
2. The phone generates a random 256-bit `claimSecret`, submits `{ pairCode, claimHash: SHA-256(claimSecret), deviceName, platform }` to an unauthenticated `POST /auth/mobile-pair/claim`, and receives a random opaque `claimId`. The code becomes claimed and cannot be claimed twice. Invalid, expired, used, and wrong-kind codes return the same refusal.
3. Once the claim is atomically bound, both clients display three words selected from a fixed 2,048-word list using the first 33 bits of `HMAC-SHA-256(key=pairCode, data="podium-mobile-phrase\0" + claimId + "\0" + claimHash)`. The authenticated browser polls `auth.mobilePairingStatus` while its modal is open, then explicitly approves or denies the pending claim. Approval is allowed only by the user captured in the grant; it cannot redirect the session to another user.
4. The phone polls `POST /auth/mobile-pair/complete` with `claimId + claimSecret`. After approval, the server creates a normal 256-bit client session for the captured user. The native completion mode returns the plaintext token once in the HTTPS response body; the native app stores it in `expo-secure-store` and sends `Authorization: Bearer` on tRPC/file requests and the React Native WebSocket upgrade. The first-party web-mobile completion mode requests an `HttpOnly; Secure; SameSite=Lax` cookie and never stores a bearer. `clientAuthGuard`, principal resolution, and the `/client` upgrade gate accept either credential through one shared resolver.
5. Completion destroys the pending grant. Denial, cancellation, timeout, server restart, or too many failed claim attempts destroys it without creating a session.

The claim secret prevents a different process that merely learns the public `claimId` from collecting the approved session. The verification phrase binds the browser's approval to the phone actually in the user's hand. It need not be a second authentication factor; it is a human-readable channel-binding check.

Extend the existing client-session inventory rather than creating a second token table. Keep `label` as the credential class and use `label='mobile'`; add explicit `device_id`, `device_name`, `platform`, and `last_seen_at` metadata. Add the mobile class to the sliding-renewal predicate so active phones do not hard-expire after 30 days, while short-lived break-glass sessions remain non-renewing. The server UI and CLI should list mobile rows and remotely revoke one row by its token hash. Existing `/auth/logout` remains the phone's own self-revoke; remote per-device revoke is the new capability.

Open mode is intentionally simpler: because reachability already grants the effective open-mode principal, its QR contains only the URL and no `pairCode`; there is no claim, approval, or session issuance. The app saves the profile after the normal open-mode warning. Do not perform a ceremonial “approval” that authenticates nobody.

If the in-memory request disappears because the server restarts, both polling surfaces settle to “Pairing expired because the server restarted—create a new code,” rather than retrying forever.

## Threat model

The design assumes the Podium server and the already authenticated browser are trusted. A compromised server can already read and act on all data the phone would access; pairing cannot defend against it. The design does defend against opportunistic network observers on the supported secure path, accidental QR disclosure, a photographed QR, replay, custom-scheme invocation, cross-server data mixing, and loss of a paired phone.

| Threat | Design response |
| --- | --- |
| QR appears in a screenshot, stream, or photo | It contains only a two-minute, single-use pending grant. Redemption produces a visible approval request, not a session. |
| Attacker races the real phone | The first claim locks the request, but the browser must approve the device and matching phrase. The real phone's failed claim is an explicit “code already used” alarm. |
| QR/deep link is handed to another app | In-app scan is preferred; opening a custom scheme still lands on a confirmation screen showing the exact origin and cannot complete without browser approval. |
| Server logs, telemetry, sync, or error reporting capture the secret | Pairing payloads, codes, claim secrets, QR images, and completion responses are classified as secret, never replicated/enqueued, redacted at boundaries, and kept only in memory until completion/expiry. |
| Pairing request is replayed | Code is random, typed, expiring, single-claim, and single-completion. Uniform failures avoid useful state oracles; claim endpoints are rate-limited. |
| Long-lived credential leaks from QR | Impossible by construction: the durable session does not exist until approval. Native receives it once over HTTPS into Keychain/Keystore; web receives only an HttpOnly cookie. |
| Phone is lost | Connected devices lists the named mobile session with last activity and supports one-row remote revocation. Server-side revocation immediately invalidates HTTP and socket access. |
| Phone connects to two servers with the same `userId` | Local data is partitioned by local `profileId + userId`; switching remounts the entire client stack. No cache or outbox crosses profiles. |
| Malicious QR points at an attacker's Podium | The app prominently names the origin and treats each profile as a separate trust boundary. It never transfers existing profiles, cookies, cached data, or queued work to a newly paired server. |

Do not put a long-lived bearer token, password, API key, Tailscale auth key, or client-session cookie in the QR. Do not persist the QR payload for “retry later.” Do not include it in navigation history or analytics. A short TTL is mitigation, not permission to handle it casually.

## Transport and the iOS cliff

Pairing and reachability are separate problems. A perfect QR cannot make an address reachable, and it cannot make iOS trust a certificate.

Apple's [App Transport Security guidance](https://developer.apple.com/documentation/security/preventing-insecure-network-connections) requires HTTPS with a trusted certificate and modern TLS for normal `URLSession` traffic. A self-signed certificate is rejected unless its issuing CA is installed and trusted by the user or administrator. Apple's [`NSAllowsLocalNetworking`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking) is a narrow declaration for IP addresses, unqualified hosts, and `.local` names; it is not a runtime exception for arbitrary HTTP domains. iOS 17 also tightened the default behavior for IP addresses.

The app should make the outcome deterministic:

| Server address | Product behavior | Recovery shown in the app |
| --- | --- | --- |
| Public or private trusted `https://` | Full QR/manual pairing. | None. This is the happy path. |
| Tailscale `https://host.tailnet.ts.net` via Serve | Full QR/manual pairing, private to the tailnet. | If unreachable, ask the user to connect Tailscale; do not mislabel it as a Podium failure. |
| LAN IP, `.local`, or unqualified host over HTTP | Reject in release-native builds. Expo's global Android cleartext switch is too broad, and this implementation has no narrow per-origin native transport policy. Web development served from that page origin is a separate cookie-bound case. | Recommend Tailscale Serve, a valid certificate via split DNS, or installing the operator's private CA. Explain that Podium controls shells and agent credentials, not merely media. |
| Tailscale `http://100.x.y.z` address | Do not treat it as ordinary LAN: the CGNAT range is not covered by the narrow iOS local-network exception. Block credentialed use. | Configure Tailscale Serve and use its trusted `https://…ts.net` name. |
| Public/Tailscale FQDN over HTTP | Block credentialed connection. ATS exceptions cannot be safely added per scanned runtime host. | Show exact Tailscale Serve or reverse-proxy steps and retain the entered address for retry. |
| HTTPS with self-signed/untrusted certificate | Do not offer “trust once” or disable verification. If the CA is already installed and trusted by iOS, it works normally. | Explain how to install/trust the private CA, or switch to Tailscale Serve/Caddy/another publicly trusted certificate. Then provide **Try again**. |
| Certificate name mismatch/expired certificate | Block. | Name the certificate problem and provide **Try again** after the server is fixed. |

The release build declares local-network use for HTTPS/private-CA reachability and discovery-facing UX, but the JavaScript preflight rejects native HTTP before contact. Android leaves global cleartext disabled; direct LAN HTTP is intentionally unsupported until a genuinely narrow per-origin native transport policy exists.

The important promise is not “every URL connects.” It is “every URL produces a precise next step.” For an HTTP-only or self-signed server, leaving the user on a spinner is a product bug; silently weakening transport security is a security bug.

### Recommended operator copy

The server's pairing screen should grade its configured `publicUrl` before generating a QR. This is configuration guidance, not a claim that the server can predict the phone's certificate trust store:

- **HTTPS configured** — the phone will still verify the certificate and name.
- **Private and ready** — Tailscale Serve URL; phone must be on the tailnet.
- **Needs secure access** — HTTP or likely untrusted TLS. The QR can configure the address, but secure sign-in is unavailable until transport is fixed.

For this project, recommend in order:

1. `tailscale serve 18787` for a private personal/team server. It provides a stable tailnet DNS name and trusted HTTPS without exposing Podium publicly.
2. Caddy/nginx/another reverse proxy with a publicly trusted certificate for internet access.
3. A LAN-only HTTPS name with a private CA installed on the phone for operators who explicitly want local PKI.
4. Browser-only HTTP development when the web-mobile page itself was served from that origin; release-native builds stay HTTPS-only.

## Comparable products

| Product | Pattern | What Podium should copy | What Podium should not copy |
| --- | --- | --- | --- |
| [Home Assistant](https://companion.home-assistant.io/docs/getting_started/) | LAN discovery, manual URL fallback, multiple servers, then normal login. Its newer [connection security level](https://companion.home-assistant.io/docs/getting_started/connection-security-level/) makes HTTP an explicit choice. | Layered onboarding, clear fallback, editable multi-server profiles, and visible HTTP policy. | SSID/location-driven internal-vs-external URL switching in v1; Podium can begin with one canonical URL per profile. |
| [Syncthing](https://docs.syncthing.net/v1.26.0/intro/getting-started.html) | QR-friendly device IDs with mutual device authorization. Device IDs are public-key identifiers and explicitly not secret. | Make the scanned object versioned and self-describing; show device names and make trust/revocation visible. | Treating a screenshot as harmless. Podium's pairing code is a bearer secret, unlike a Syncthing device ID. |
| [Plex](https://support.plex.tv/articles/203395277-connect-app-to-your-plex-account/) | A short code links constrained clients through an already authenticated browser; server claiming and secure discovery depend on Plex's account/cloud. | The “approve elsewhere, device wakes up signed in” quality of the ceremony. | Any central rendezvous, global account, or cloud-issued certificate dependency. It contradicts Podium's OSS/self-hosted constraint. |
| [Jellyfin](https://jellyfin.org/docs/general/server/quick-connect/) | Quick Connect shows a temporary code on the new client and requires authorization from a signed-in client. Its server also exposes [opt-in UDP discovery](https://github.com/jellyfin/jellyfin-web/blob/master/src/strings/en-us.json). | The two-device approval ceremony and the separation between discovery and authorization. | Making a short human code the primary phone flow; QR can carry much more entropy without typing. UDP discovery can follow later. |
| [Immich](https://docs.immich.app/features/mobile-app/) | The mobile app begins with explicit server endpoint entry and login. | Honest manual URL entry that works without a vendor cloud and remains editable. | Stopping there. It is functional but makes every user understand addresses before receiving value. |
| [Tailscale](https://tailscale.com/docs/features/access-control/auth-keys) | One-off auth keys expire and revoke automatically after use; reusable keys are treated as dangerous. | One-off, scoped, expiring bootstrap credentials and separate revocation of the enrolled device/session. | Putting a reusable or durable auth key in a QR. Also, Tailscale is a supported transport option, not Podium's identity broker. |

The synthesized best practice is: **discover/configure an endpoint, authorize the new client through an existing trust anchor, exchange the bootstrap secret for a named revocable device session, and always retain a manual route.**

## Rejected alternatives

### QR contains URL only, then password login

Safer than embedding a session and simple to implement, but it misses the requested “automagic” experience and makes a person type a password on every new phone. Keep it as the manual/degraded path, not the primary design.

### QR contains a long-lived session or API token

Rejected. Photos, screen sharing, browser caches, issue attachments, and support logs turn it into account compromise. Revocation is also hard to explain if all phones share a generic token.

### One-step exchange of a short-lived QR code for a session

Rejected as the default. Short TTL and single use limit replay but do not stop someone who photographs the live QR and redeems first. Explicit browser approval plus phrase comparison closes that gap with modest UX cost.

### Custom-scheme-only QR

Rejected as the primary container. `podium://` is convenient when the app is installed but is not exclusively owned and gives someone without the native app nowhere useful to go. An HTTPS `/mobile#pair=…` QR works in the stock camera and web-mobile without an app, keeps the secret fragment out of HTTP request logs, and is still readable by the native in-app scanner. Keep the custom scheme only as a secondary bridge from the web page into an installed app.

### Reuse the exact daemon `machines.pairingCode` + `/daemon` handshake

Rejected. It provisions a machine principal and long-lived machine enrollment token, creates fleet inventory, and is admin-grade because the new machine can host compute. A phone is a human client and should receive a client session owned by the pairer's user. The shared envelope and one-shot manager are valuable; the endpoint and resulting authority are not reusable.

### Automatic LAN discovery as the primary path

Rejected for v1. It does not work across Tailscale subnets or the public internet, creates local-network permission/firewall/container complexity, and discovers an address without authorizing the phone. Bonjour can later be a convenience row like Home Assistant's discovery, but QR plus manual URL solves every required topology first.

### Central Podium link service or Plex-style cloud account

Rejected now because it violates the open-source/self-hosted requirement and introduces a highly sensitive availability/privacy dependency. The server itself is the rendezvous.

### Trust-on-first-use or certificate fingerprint in the QR

Rejected for the first design. It would require a custom native networking stack for HTTP, WebSocket, downloads, and every future transport; standard ATS-backed fetch cannot dynamically bless an arbitrary self-signed certificate. TOFU also cannot protect the first connection unless the fingerprint comparison is made an explicit ceremony. Tailscale Serve, a trusted CA, or an installed private CA solve the problem at the transport layer and work for the whole app.

### Broad iOS `NSAllowsArbitraryLoads` / Android cleartext enablement

Rejected. It turns one self-hosting exception into an app-wide downgrade and still does nothing for self-signed certificate trust. Use the narrow local-network declaration, visible insecure-mode policy, and actionable remediation.

### Native cookie-only authentication

Rejected as the protocol bet. The current cookie path is proven for browsers but not for React Native cookie persistence or WebSocket attachment, and an HttpOnly cookie gives native code no reliable way to distinguish expiry from an unreachable server. Use a SecureStore bearer on native and retain HttpOnly cookies on web; both resolve through the same server-side client-session lookup.

## Rough implementation outline

This is sequencing, not permission to begin implementation.

1. **Protocol/core:** move a Buffer-free codec into an RN-safe shared package, evolve the join envelope into a discriminated machine/mobile union, and add strict URI parsing, typed grants, secret redaction rules, expiry, claim-state transitions, and the exact phrase derivation. Preserve v1 daemon compatibility through a runtime re-export.
2. **Credential boundary spike:** before building the rest, prove one native bearer reaches both tRPC and the `/client` WebSocket on iOS and Android, survives an app restart in `expo-secure-store`, and is rejected immediately after server-side revocation. This validates the chosen explicit-header protocol; it is not permission to fall back to query-string tokens or broad cookie assumptions.
3. **Server auth:** add independently throttled start/claim/status/approve/deny/complete endpoints; bind grants to the minting `userId`; widen the client credential resolver to cookie-or-bearer; add `label='mobile'` session metadata, renewal, listing, and one-row remote revocation. Publish the canonical origin and existing `/version` identity in payload/preflight.
4. **Native profile bootstrap:** add a persisted server-profile repository and a launch boundary that must resolve a selected profile before `AuthGate` or `MobileClientProvider` mounts. Remove loopback as the native no-config fallback. Keep web-mobile's page-origin path unchanged and preserve `?server=` only as an ephemeral development/test override.
5. **Replica isolation:** use `profileId + userId` at the existing principal namespace seam. Switching profiles must fully dispose and remount auth, tRPC, socket hub, replica, and logging destinations. Profile removal uses row/namespace erasure and never deletes the shared database file.
6. **Pairing UI:** add the native scanner (`expo-camera`, camera permission descriptions, and no web import), a web QR renderer dependency, HTTPS fragment/custom-scheme consumption, manual URL preflight, claim/phrase/polling/approval states, server-restart expiry, and precise recovery/version-mismatch screens. Add Settings → Servers on native and Settings → Connected devices → Pair a phone on web.
7. **Transport policy:** configure iOS local-network usage and narrow ATS declaration, Android's corresponding network policy, and error classification for ATS, DNS/reachability, server mismatch, and version mismatch. Add server-side readiness grading and tailored Tailscale/reverse-proxy instructions.
8. **Verification:** hermetic tests cover token typing/expiry/single-use, approval binding, exact phrase vectors, uniform refusals, independent throttles, redaction, renewal, per-device revocation, open-mode URL-only QR, profile isolation, web page-origin behavior, `?server=` preservation, and transport classification. Per repository guidance, drive only the smallest real camera/deep-link and native bearer/WebSocket boundaries once on each affected platform.

## Success criteria

- One App Store/TestFlight build can hold and switch between two unrelated self-hosted servers.
- A fresh install never silently targets phone loopback and never hangs without a recovery action.
- A browser opening the server's `/mobile` route uses that page origin immediately; it never asks the user to scan its own server QR.
- The same HTTPS QR works in a native in-app scanner and in the stock camera/web-mobile path when no native app is installed.
- The primary happy path is scan → verify/approve → signed in, with no URL or password typing.
- A QR photograph alone cannot create a durable session.
- Every phone has an identified, individually revocable mobile session; no durable credential is present in the QR or profile metadata, and native tokens live only in Keychain/Keystore.
- Public HTTPS and Tailscale Serve connect natively; direct LAN HTTP fails closed with an intentional HTTPS/Tailscale recovery message.
- HTTP-only and self-signed iOS setups receive an immediate, accurate explanation and a concrete recovery path rather than a spinner.
- Data, queued writes, cookies, and connection state cannot bleed between server profiles.
