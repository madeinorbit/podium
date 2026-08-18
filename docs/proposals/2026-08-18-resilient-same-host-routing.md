# Resilient same-host routing

Status: proposed  
Issue: POD-2340  
Date: 2026-08-18

## Outcome

`publicUrl` is an address Podium advertises to other devices. It must never silently become the
address a component on the server host uses to reach that server. A reachable-URL flow proves that
the candidate URL reaches the current Podium before it saves anything, and an authentication
transition can never leave the current UI looking like a broken server connection.

The design deliberately does not make a browser guess which physical machine it is on. Native
shells and local processes receive trusted runtime context; ordinary browsers stay on the origin
that served them.

## What happened

The reported incident combined two independent failures:

1. The reachable URL was accepted after syntax validation only. Podium never requested it. A
   foreground `tailscale funnel 18787` exists only while that command remains running, so a stopped
   command, a Funnel policy problem, or an address that cannot hairpin back from the Mac can all
   leave a syntactically valid but dead `publicUrl` in config.
2. The Network step set the first password and immediately made its own previously-open client
   unauthenticated. The next protected tRPC call received the auth guard's non-tRPC 401 body and
   surfaced as `Unable to transform response from server`, even though the URL write had already
   succeeded. On a later launch, the one-shot login gate and transport recovery could make the same
   auth/network ambiguity look like `The server is briefly unavailable.`

The password self-lockout was fixed by commit `b882c9028` on 2026-08-17 and is included in
`v0.1.0-edge.4`: the Network step stores the password exactly as typed and obtains a login cookie
before continuing. That fix removes the immediate reproduction, but it does not prove a candidate
URL and it does not give already-mounted clients a general re-authentication path.

## Current routing behavior

| Runtime shape | UI to server | Daemon to server | Does `publicUrl` retarget it? |
| --- | --- | --- | --- |
| macOS desktop, `all-in-one` | Injected `ws://127.0.0.1:<picked-port>` from the Tauri shell | Direct in-process `LocalDaemonLink` | No |
| macOS desktop, `server` | Injected loopback URL | No daemon | No |
| Linux/CLI, foreground `all-in-one` | Browser origin chosen by the user | Direct in-process `LocalDaemonLink` | No |
| Linux/CLI, managed split `all-in-one` | Browser origin chosen by the user | Local WebSocket from the split daemon to the configured local server port | No |
| Desktop/CLI `client` or joined `daemon` | Configured `serverUrl` | Configured `serverUrl` | Not directly; the join command derives `serverUrl` from the server's `publicUrl` |
| Ordinary browser | The page's own origin | N/A | Only if the user opened that origin |

The important answer is therefore: supported all-in-one and server-only deployments already keep
same-instance traffic local, including the macOS case in the incident. A separately joined daemon
uses its configured remote URL even if it happens to run on the same physical host. Podium has no
safe general physical-host detection or endpoint failover for that exceptional topology.

There are four related identities today, and they are not interchangeable:

- `PODIUM_INSTANCE` / `instanceId`: a local deployment partition and state-directory selector;
  values such as `default` are not globally unique.
- `machineId`: the durable identity of a daemon/agent host as known to the server.
- feed identity `(feedId, epoch)`: the durable identity of the replicated authority timeline.
- client runtime: browser, desktop webview, mobile, CLI, daemon, or server process.

The desktop bridge already exposes its runtime and `machineId`; the server and daemon already know
their local `instanceId`; `/version` exposes `instanceId`; and the sync protocol exposes feed
identity. What is missing is a small, explicit connection-context contract. Adding more hostname
heuristics would conflate the identities above and fail with containers, SSH forwarding, multiple
Podium instances, split DNS, and VPNs.

## Principles

1. **Advertisement is not routing.** `publicUrl` describes how another device may enter this
   authority. `serverUrl` describes the authority a remote client or joined daemon follows. A local
   dial target is runtime state, not advertised configuration.
2. **Local is scoped to an authority, not a physical host.** A loopback endpoint is eligible only
   when it proves it serves the authority the component intended to reach. “Same hostname” is not
   proof, and `instanceId=default` is not proof.
3. **The embedder states the runtime.** Tauri and Node processes may inject trusted facts. Browser
   JavaScript remains `runtime: browser` and uses its serving origin; it does not scan localhost or
   inspect hostnames.
4. **Validate before commit.** A bad URL must leave config, credentials, the active transport, and
   the currently displayed settings untouched.
5. **Classify failures at the boundary.** Authentication required, candidate URL unreachable,
   candidate points to another Podium, incompatible Podium, and active server unavailable are
   separate states with separate recovery actions.
6. **Do not claim global reachability from a local observation.** Without an external probe service,
   Podium can truthfully prove only “this device can reach this URL and it reaches this server.”

## What advertisement-only means

`publicUrl` remains in the hosting authority's configuration, but only these consumers may read it:

- the reachable-URL verifier;
- join/mobile link generation;
- Settings display and copy;
- a signed authority-locator update sent to already-authenticated remote clients.

The server launcher, desktop shell, local daemon, janitor, CLI default, tRPC client, and WebSocket
client do not consult it to choose their own route. A join operation may copy the same URL bytes
into the joining device's authority binding, where they become a remote endpoint owned by that
client—not a live reference back to the host's `publicUrl` field.

Keep three representations instead of one overloaded URL:

```ts
interface HostingAdvertisement {
  publicUrl?: CanonicalHttpOrigin
}

interface AuthorityBinding {
  authorityId: string
  authorityPublicKey: string
  remoteEndpoints: CanonicalHttpOrigin[]
}

interface ActiveTransport {
  endpoint: Endpoint
  kind: 'in-process' | 'local' | 'remote' | 'page-origin'
  verifiedAuthorityId: string
}
```

Changing `publicUrl` therefore changes future join links and, after verification, may publish a
signed locator update. It does not move the current desktop, server-side components, or local
daemon. A remote client tests a signed replacement before adopting it and retains the previous
endpoint as rollback; an unreachable old endpoint still requires an explicit new join locator or
`set-server`, because the authority cannot push through a dead route.

## Proposed connection contract

### Identity is three facts, not one `sameInstance` flag

Podium must keep these identities separate:

1. **Authority identity** — which Podium data authority the client follows. Add a persistent
   Ed25519 authority keypair to server-owned state and define `authorityId` as the fingerprint of
   its public key. The key moves with a server transfer. The existing `feedId` remains the stable
   identity of the authority's replicated log and `epoch` remains its current continuity
   generation; neither is a proof of key possession.
2. **Server-host machine identity** — the existing `hostMachineId` from
   `<stateDir>/machine.id`. This is the row to label “Hosts this Podium” in Machines. It may change
   when the authority is transferred to another machine while `authorityId` remains stable.
3. **Client-device identity** — where the current surface runs. Native/process surfaces may have
   a verified `machineId`; a browser may have only an unprivileged `clientDeviceId`. A browser can
   learn the server-host machine from the server, but cannot prove which physical machine the
   browser itself runs on.

Accordingly, code asks the exact question it means:

```ts
const sameAuthority = candidate.authorityId === connected.authorityId
const clientRunsOnServerHost =
  client.machineIdAssurance === 'verified' &&
  client.machineId === connected.serverHostMachineId
const sameLocalInstallation =
  sameAuthority && clientRunsOnServerHost && client.localInstanceId === candidate.localInstanceId
```

`instanceId` remains a local installation/state-directory name. It is useful only after the
native/process layer has already established host locality; `default === default` across a network
means nothing.

### Trust levels by surface

| Surface | Runtime fact | Client device fact | Server-host fact |
| --- | --- | --- | --- |
| Browser | Derived from the browser entry point | Random browser `clientDeviceId`, UX only; no `machineId` claim | Authenticated server context supplies `serverHostMachineId` |
| Desktop | Injected by the signed Tauri shell | Shell reads the selected state dir's machine identity; server treats it as verified only after a machine-token/local-secret proof | Authenticated server context supplies `serverHostMachineId` |
| CLI | Fixed by the executable | Reads `machine.id` from the selected `PODIUM_INSTANCE`; verified operations bind it through the local-machine or enrolled-machine credential | Server response supplies `serverHostMachineId` |
| Daemon | Fixed by the executable | Its authenticated handshake resolves `machineId` from the token/local secret, never from its claim | Server handshake supplies authority/server-host context |
| Server | Fixed by the executable | `hostMachineId` from its selected state dir | It is the source of this fact |

The web bundle may use this context for presentation, but it never grants authority. Server-side
authorization continues to use authenticated principals and machine enrollment. A remote page
cannot gain local privileges by overwriting a JavaScript global or claiming a machine id.

Introduce a `ConnectionContext` at composition boundaries, not as ambient browser inference:

```ts
type ClientRuntime = 'browser' | 'desktop' | 'mobile' | 'cli' | 'daemon' | 'server'

interface AuthorityIdentity {
  authorityId: string
  feedId: string
  epoch: string
}

interface ConnectionContext {
  runtime: ClientRuntime
  clientDeviceId: string
  localInstanceId?: string
  localMachineId?: MachineId
  machineIdAssurance: 'none' | 'claimed' | 'verified'
  authority: AuthorityIdentity
  serverHostMachineId: MachineId
  activeEndpoint: Endpoint
  advertisedEndpoint?: Endpoint
  localCandidate?: Endpoint
}
```

`activeEndpoint` is what this component is using now. `advertisedEndpoint` is `publicUrl` in a
canonical HTTP(S)-origin form. `localCandidate` is supplied only by a trusted native/process
embedder. Before it may replace `activeEndpoint`, the candidate must answer with the expected
authority identity. The authority key proves that comparison; `feedId` describes data lineage and
`instanceId` is only a local namespace.

For the desktop this is a native-owned structure injected before the page loads. For CLI, daemon,
and server it is an ordinary constructor argument assembled from the selected state directory and
the authenticated handshake. For browsers it is assembled from the browser runtime plus the
authenticated server response, with no local machine id.

Endpoint selection is deterministic:

1. An in-process link for the expected authority wins.
2. A trusted local candidate that proves possession of the expected authority key wins.
3. The configured remote endpoint wins for desktop client mode, joined daemons, mobile, and CLI
   remote operation.
4. The serving origin wins for an ordinary browser.
5. No layer rewrites the selected endpoint merely because `publicUrl` changed.

This formalizes existing good behavior before extending it. The first implementation need not scan
for other Podium instances on the host. The managed all-in-one launcher and desktop shell already
know their local endpoint and can populate the contract without discovery. Cross-instance,
same-physical-host optimization should be added only with an explicit local registry keyed by
authority identity; it is not required to fix this incident.

### Secure local endpoint proof

Desktop-supervised all-in-one needs no discovery: the native parent owns the child process and the
chosen port. Foreground all-in-one already has an in-process link. Managed split Linux processes
share one state directory and should publish an owner-only runtime descriptor containing the local
port, `localInstanceId`, `hostMachineId`, process id, and boot nonce.

A client that already has a pinned `authorityId` sends a fresh nonce to the local candidate. The
candidate signs the nonce, its boot nonce, endpoint, `authorityId`, `feedId`, and
`serverHostMachineId`. The client verifies that signature with the pinned authority public key
before sending a cookie, bearer token, pair code, or machine token to the endpoint. This prevents a
different local Podium—or an unrelated process that merely copied a public id—from attracting
credentials. Owner-only runtime files and process ownership narrow discovery; the signature is the
authority proof.

The authority public key is pinned on the first authenticated connection. Join codes should carry
its fingerprint so a new daemon can verify the endpoint before redeeming its one-shot pair code.
Password-only client setup may use the TLS-authenticated remote endpoint for the first connection
and pin the returned key; it does not attempt a local substitution before that pin exists.

## Reachable-URL proof

Both Settings → Network and the embedded Settings → Machines flow use one state machine and one
probe implementation:

```text
editing → validating → probing → verified → committing → saved
                         └→ failed (nothing changed)
```

### Canonical validation

Accept one canonical HTTP(S) origin only:

- `http:` or `https:`;
- no username/password;
- no path other than `/`, query, or fragment;
- normalize case, default ports, and the trailing slash once;
- require HTTPS for a non-loopback advertised address unless an explicit development override is
  active.

The current `validatePublicUrl` accepts paths, queries, fragments, credentials, and public HTTP.
That is broader than the pairing protocol, which already expects a canonical origin.

### Identity proof

The authenticated active connection supplies the authority public key, `authorityId`,
`feedId`, and a per-server-boot random `bootId`. The client sends a fresh nonce to a public,
read-only probe endpoint through the candidate URL, with a short timeout and `cache: no-store`.
The response signs the nonce, candidate origin, `authorityId`, `feedId`, `bootId`, and wire version.

The probe succeeds only when:

- DNS/TLS/HTTP completes;
- the response has Podium's probe content type and supported schema;
- the signature verifies with the active connection's authority public key;
- `authorityId` and `feedId` match the active authority;
- `bootId` matches the active server (proof that both URLs reached the same live process, rather
  than a restored clone holding the same authority key);
- the signed candidate origin equals the origin the client requested;
- the wire version is compatible.

The client-side request is intentional: it tests the route the current device will actually use
and avoids turning the server into an arbitrary-URL fetch/SSRF primitive. It catches the reported
dead Funnel from the desktop webview. The same pure verifier is used by CLI setup with injected
`fetch` and timeouts. If an installation later needs proof from the public internet rather than
from the current device, that is a separate opt-in external probe service and must be labeled as
such.

For browsers already served from the candidate origin, the proof still runs but is same-origin.
For a Tauri page, the existing Podium CORS policy must allow the public probe route from the Tauri
origin without credentials. No dynamic Tauri command capability is needed for an ordinary web
request.

### Failure copy

- Network/TLS failure: “Podium could not reach this URL from this device. Keep the tunnel running
  and check the URL, then try again.”
- Non-Podium response: “This URL does not serve Podium.”
- Different identity: “This URL reaches a different Podium instance.”
- Version mismatch: “This URL reaches Podium, but its version is incompatible with this app.”

The entered value stays in the form. The previous saved URL and active connection remain intact.
An explicit “Save without verification” escape hatch should not ship initially: an advertised URL
is consumed by generated join commands, so persisting a known-unverified value creates damage on
other machines.

## Authentication and recovery

The Network step should not own a bespoke “mutate, then log in” sequence forever. Make the setup
completion response establish or return a credential transition as one protocol operation. The
preferred HTTP behavior is to set the login cookie on the successful setup response. If the tRPC
adapter cannot set it reliably across the Tauri origin, return a single-use exchange token and do
not report the operation complete until the exchange succeeds.

Independently, the web transport must classify HTTP 401 before asking tRPC to deserialize the body:

- emit an application-level `authentication-required` signal;
- let `LoginGate` re-enter its login phase even after initial mount;
- preserve the replica and rendered shell behind the login layer;
- replay queries after successful login;
- never automatically replay a mutation whose commit status is unknown.

Network failures continue through restart recovery. A 401 is never rewritten to “server briefly
unavailable,” and an invalid tRPC envelope is never exposed as “Unable to transform response.”

## Delivery slices

1. **Verified advertised URL.** Canonical-origin validation, public identity probe, shared probe
   state machine in Network and Machines, CLI parity, and no-write-on-failure tests.
2. **Live re-authentication.** Transport-level 401 classification, a re-enterable `LoginGate`, and
   an atomic credential transition for setup completion.
3. **Explicit connection context.** Name the existing desktop, browser, in-process, and split-local
   choices behind `ConnectionContext`; remove call-site endpoint inference.
4. **Optional local authority discovery.** Only if real deployments need separate Podium instances
   on one physical host to optimize through loopback. Use a local registry and authority proof;
   never hostname matching. This slice is not needed for incident prevention.

Slices 1 and 2 fix the user-visible failure. Slice 3 prevents future code from coupling an
advertised address to a local route. Slice 4 can close untouched if no concrete topology needs it.

## Acceptance

- With the desktop in all-in-one mode, changing `publicUrl` never changes the injected loopback
  endpoint or the daemon's in-process link, before or after restart.
- A stopped `tailscale funnel` causes verification to fail and leaves config/password/auth state
  unchanged.
- A live Funnel to the current server verifies and produces a join command using the canonical
  public origin.
- A URL serving HTML, a different Podium, or an incompatible Podium is rejected with the specific
  reason and no writes.
- Setting the first password leaves the initiating desktop authenticated. A forced 401 at any later
  time opens the login gate; it does not empty Settings or show a transport-transform error.
- An ordinary browser continues to use its page origin and receives no machine-local endpoint.
- Foreground all-in-one retains the in-process daemon link; managed split all-in-one retains a local
  socket; a joined remote daemon retains its configured server URL.
- Mutation recovery never blindly replays a request after a cut response.

## Non-goals

- Keeping Tailscale Funnel alive or installing it as a service. Podium verifies and explains the
  dependency; Tailscale owns its lifecycle.
- Proving reachability from every network without an external observer.
- Treating `instanceId`, hostname, IP address, or `machineId` alone as an authority identity.
- Making browser JavaScript discover or connect to arbitrary localhost Podium instances.
