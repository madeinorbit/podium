# Binary terminal input

Status: implementation specification for `POD-2956` (2026-08-27)

## 1. Outcome

Mutually capable client/server and server/daemon connections carry PTY input as raw bytes in the
shared binary envelope. Peers negotiate input separately from output, so binary output may be active
while input still uses JSON/base64. Older clients, servers, and daemons remain interoperable in every
supported rolling-version combination.

Binary input is included for a coherent byte-stream contract and large-paste efficiency; it is not
conditioned on demonstrating a large ordinary-keystroke benchmark win.

## 2. Negotiation

Add `terminal.input.binary.v1` to the client hello and daemon `PeerHello`. A sender uses binary input
only when its receiver explicitly acknowledged/offered the input token on that connection. Output and
input capabilities are independent.

Fallback remains the existing base64 `InputMessage`. Capability presence, not application version,
wire version alone, deployment batch, or output capability, selects the encoding.

## 3. Byte semantics

Binary input payload is an arbitrary PTY byte sequence. Browser keyboard and paste data begin as
JavaScript strings and are UTF-8 encoded once. The protocol and server do not decode those bytes back
to text before forwarding them. Escape and control bytes are valid input.

Higher-level server features such as mail/controller text composition may remain string-oriented until
the terminal boundary, where they become bytes once. CR/LF command-submission detection and input
activity inspection operate on bytes.

## 4. Metadata and authority

Client-to-server metadata:

```ts
{ v: 1, type: 'ptyInput', sessionId: SessionId }
```

Server-to-daemon metadata:

```ts
{
  v: 1,
  type: 'ptyInput',
  sessionId: SessionId,
  inputOrigin: ObservationInputOrigin,
  attribution?: Attribution,
}
```

Client binary metadata carries no attribution or claimed input origin. The server authenticates the
connection, enforces controller authorization, stamps `inputOrigin: 'human'`, and derives attribution
from the transport principal exactly as on the JSON path. Payload identity is inert and must never be
trusted if future additive fields appear.

Server-generated controller/mail/automation input retains its existing origin and authenticated
attribution in server-to-daemon metadata. The daemon records that metadata before writing the payload
to the PTY.

## 5. Routing and compatibility

Both client text and binary input converge before controller and session authorization. Both daemon
text and binary input converge before observer accounting and PTY write. Preserve ordering between
paste blocks and delayed submit keys; do not combine messages that are intentionally separate PTY
writes.

Required mixed-version cases:

- old client -> new server: JSON/base64;
- new client -> old server: JSON/base64 because no capability was acknowledged;
- new client -> new server: binary on the client hop;
- old server -> new daemon and new server -> old daemon: JSON/base64 on the daemon hop;
- new server -> new daemon: binary on the daemon hop.

A connection may therefore use binary on one hop and base64 on the other; the server canonicalizes to
bytes at its terminal boundary and converts only at a legacy serving edge.

## 6. Errors, limits, and backpressure

Use the shared envelope limits and existing WebSocket 64 MiB message limit so the binary path does not
silently narrow current large-paste behavior. Empty input is a no-op. Malformed or unnegotiated binary
closes the affected connection. Existing controller authorization failures and unknown-session
outcomes remain session errors rather than protocol errors.

Retain socket buffered-amount policy and input ordering. Do not add lossy dropping to input: accepted
input either follows the current reliable path or the connection fails.

## 7. Acceptance

- All client/server/daemon version combinations above select a compatible encoding.
- Single keys, control sequences, Unicode, bracketed paste, large paste, and delayed carriage return
  reach the PTY byte-identically and in order.
- Forged attribution/origin metadata cannot affect authorization or recorded attribution.
- Input activity, shell-command detection, observer origin, controller ownership, and audit behavior
  remain unchanged.
- No intermediate base64 or UTF-8 decode exists on a fully capable path.

## 8. Non-goals

No input batching redesign, terminal semantic parsing, native-bridge performance claim, fallback
removal, or whole-protocol binary conversion belongs here.
