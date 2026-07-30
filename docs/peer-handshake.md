# The peer handshake — common framing, role-specific authentication

Implementation of **ADR 5** D3 (common framing), D4 (reserved inert node surface) and
D5 (role-specific auth strategies), with the principal model of **ADR 3 Amendment 1**
(D14–D21) and **ADR 9**. Landed by POD-388 under POD-317; the daemon side of the same
contract is POD-327's.

The one-line rule: **framing is common across roles; authentication is where roles
legitimately differ.** If role-specific logic appears in the framing, the boundary has
been drawn in the wrong place.

```
packages/protocol/src/handshake/
  envelope.ts            the hello envelope, credential union, closed reject reasons
  negotiation.ts         version + capability negotiation (role-blind by construction)
  acceptor.ts            GATEWAY end   — pure state machine, order-enforcing
  dialer.ts              DAEMON end    — pure state machine, order-enforcing
  conformance.ts         the shared order-regression suite, run against BOTH ends
  delegation-chain.ts    delegation as a reference, resolved live; never snapshotted
  legacy-daemon-frames.ts  the ONE adapter for today's pair/hello frames (POD-308)
  strategies/            one module per ADR 5 D5 row + the ADR 3 D14 non-peer ingresses
apps/server/src/gateway/
  peer-handshake.ts      the /daemon composition root
  machine-directory.ts   MachinesService → MachineDirectory port
  principal-capability.ts  transport principal → command-layer Capability (D17's pair)
```

## Roles: what authenticates it, what it may address, what it is refused

Default-closed throughout. Every refusal is `auth-failed` on the wire regardless of which
check failed (the consistent-error rule, ADR 3 Am.1 D18.5/D20) — the reason is logged
server-side and never sent.

| Role / ingress | Authenticated by | May then address | Refused |
|---|---|---|---|
| **console** (`/client`, cookie-bearing tRPC) | the `podium_session` cookie **on the HTTP upgrade**, resolved through `ClientSessionDirectory` to a **per-user** client session. The credential carries no material in the frame, so a forged hello cannot present one. Origin/CSWSH guards run before this and authenticate nobody. | whatever its `(user, device, capability)` principal is authorized for, re-resolved at every apply | no cookie, unknown/expired cookie, disabled or revoked account. **No fallback to an ambient operator.** |
| **machine (local)** (`/daemon`) | the shared host secret from `readOrCreateDaemonSecret`, presented on the **same hello path as remote** — not a pairing ceremony, not a bootstrap special case | what its machine principal is authorized for; a machine is not a person, so its on-behalf-of is `null` | anything without the secret. Being loopback, in-process, or "the server host" is **not** proof; an authenticated human does **not** inherit `use` on the host machine (readiness M4 / D18.6) |
| **machine (remote, first contact)** (`/daemon`) | a one-shot **pair code** from the join token (`serverUrl` + `pairCode`), redeemed through `PairingManager` — single-use, short TTL, memory-held | as above; the pairer is recorded as **owner** and a new machine is private to its pairer | unknown, expired or already-redeemed code; pairing disabled. This is the one branch allowed a peer-visible message ("invalid or expired code") because it discloses no identity |
| **machine (remote, reconnect)** (`/daemon`) | the long-lived **machine token** minted by the pairing branch | as above, with the owner and grants the directory returns | unknown, rotated or revoked token, with no peer-visible detail. A token with no machine hint fails closed rather than scanning |
| **agent relay** (not a peer role — ADR 3 Am.1 D14) | a **server-minted delegation reference**, resolved live through `DelegationDirectory`. Never a free-string identity | its own scope **intersected with its human's current rights**, resolved at every apply (D16) — nothing is copied into the connection | unknown, revoked or unresolvable chain; no human at the root; more than one human; a widening sub-agent; a root human who is disabled or revoked |
| **operator channel** (`cli`, in-process `mcp`) | an **in-process binding** supplied by the composition root (`inProcess` is a fact the gateway asserts, never something a peer sends), **or** the local operator's client session token through the same per-user directory | what that human is authorized for — the channel has no identity of its own | neither binding nor session. **There is no ambient operator**: a CLI on the box with no session gets nothing (readiness §3.1.6 S4) |
| **node** | nothing. Reserved credential class, **no acceptor** ([spec:SP-0371]) | — | every connection: `role-not-implemented`, without crashing (D4.4) |
| **system** (steward, expiry, boot reconcile, derived fields) | **in-process construction only** (D21.2) — there is no credential to steal | reads may cross owners; every write is attributed `system` and lands in the scope of what it acted on | every transport. It has **no** on-behalf-of and must never be assigned one |

## Two rules the strategies exist to enforce

**Payload identity is inert.** Every identity-shaped field a peer can write lives in one
`claims` bag that no strategy reads when resolving a principal. A hello asserting a
different user, machine, agent or delegator changes nothing. Where a field must narrow a
lookup (`machineHint`), the resolved identity is the record the directory **verified**, not
the hint — a stolen token presented under another machine's id resolves to the token's own
machine, or is refused.

**A client session is a device, not a person.** The principal is `(user, device,
capability)`; one user may hold many devices. The `ClientSessionDirectory` port is shaped
that way already, which is why it has **no production binding yet**: per-user
`client_sessions` land with POD-1075, and wiring the strategy to today's single instance
password would resolve every cookie to one ambient operator — the exact hole this work
removes. Until then the registry holds an explicit refusal for the console role rather
than a gap, and `/client` keeps its existing cookie gate.

## Order is part of the contract

The handshake-order regression class is one scenario list (`conformance.ts`) run against
the gateway end **and** the daemon end:

1. the first frame must be a hello — application traffic and junk never reach the planes,
   and no principal exists;
2. **version is negotiated before any credential is examined** (proven by a spy strategy
   that must not be called, not by observing a refusal);
3. a handshake frame on a live connection is refused — re-auth on an open socket would be
   a principal-swap primitive (ADR 3 D7's TOCTOU shape);
4. nothing is delivered before a principal exists, and everything after carries one;
5. a refused end stays refused.

The daemon end's version of rule 1 is the wedge `wsServer.ts` documents: application
traffic arriving ahead of `helloOk` used to make the daemon refuse and loop forever. It is
now a named outcome — `traffic-before-ack` — that a dialer reports instead of retrying.

Both ends are pure state machines with no sockets, which is what lets POD-391 drive a
reattach storm through them without a network.

## Reserved for a future node peer (inert)

`peerRole: 'node'`, `feedId`, and the capability tokens `peerRole:node`, `upstream.sync`,
`upstream.push`, `viaHub`, `upstreamStale`, `pendingSync` and the `feed.*` family are
present and **ignored**: never emitted by an H1 peer, never accepted, never routed, and
never an elevation. Capability negotiation returns an **intersection** — never the offer
echoed back — so a peer cannot grant itself a capability by naming one, and a reserved
token is refused even if a build lists it as supported.

## What is deliberately not here

- **`owner` and `grants` values.** The types carry both; the `machines` table has neither
  (POD-1079 / POD-318). Every resolution reports `owner: null` today, and
  `machineUseAllowed` therefore grants `use` to **nobody** — the fail-closed direction.
- **The console strategy's production binding** (POD-1075), and the human half of
  attribution having a value to carry (POD-1075 + POD-323 for delegation lifecycle).
- **A node acceptor**, and any hub behaviour ([spec:SP-0371], POD-353).
