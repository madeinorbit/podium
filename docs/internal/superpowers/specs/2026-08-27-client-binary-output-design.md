# Client binary terminal output

Status: implementation specification for `POD-2954` (2026-08-27)

## 1. Outcome

A mutually capable server and browser exchange PTY output as one binary WebSocket message containing
small JSON metadata followed by raw output bytes. JSON control/feed traffic remains text. Older
clients continue receiving the existing JSON/base64 `outputFrame`, and one server may serve binary
and legacy clients attached to the same session at the same time.

This issue also owns the shared v1 binary-envelope codec and makes server replay byte-native. Later
daemon-output and input issues reuse that codec rather than defining new framing.

## 2. Negotiation

Add the open capability token `terminal.output.binary.v1` to the client hello. The server sends
binary terminal output to a connection only when that connection advertised the token. Missing or
unknown capability data means legacy behavior. Capability selection is per connection, never global
to a session, server, browser bundle, or application version.

The rollout supports every independently rolling client/server/daemon combination inside
`SUPPORTED_WIRE_VERSIONS`. No sender infers support from `appVersion`, `WIRE_VERSION`, deployment
order, or the fact that another connection negotiated the capability.

## 3. Shared envelope

One WebSocket binary message has this layout:

```text
0..3                      unsigned 32-bit big-endian metadata byte length N
4..(4 + N - 1)            N bytes of UTF-8 JSON metadata
(4 + N)..end              raw payload bytes
```

The shared protocol codec:

- caps metadata at 16 KiB before allocating or parsing it;
- remains under the existing 64 MiB WebSocket message limit;
- infers payload length from the WebSocket message and does not duplicate it in metadata;
- allows empty payloads at the codec level;
- tolerates unknown additive metadata fields within a supported type/version;
- rejects truncated headers, impossible lengths, invalid UTF-8/JSON, unknown message types, and
  unsupported metadata versions.

Malformed or unnegotiated binary is a classified protocol violation and closes only the affected
connection. A well-formed message naming a missing or detached session continues through existing
session-level handling and is not a framing error.

The codec lives in `@podium/protocol` with module-level durable documentation and conformance tests.
It is a framing primitive with plane-specific metadata schemas, not a conversion of the whole JSON
protocol to binary.

## 4. Server-to-client metadata

```ts
{
  v: 1,
  type: 'ptyOutput',
  sessionId: SessionId,
  seq: number,
  epoch: number,
}
```

The payload is the exact PTY byte sequence represented by today's `outputFrame.data`. The server
remains authoritative for `seq` and `epoch`. Binary framing must not change resume cursors, epoch
resets, screen-reset detection, attach outcomes, or lossy live-stream backpressure.

## 5. Canonical replay and fan-out

`SessionTerminal` stores one canonical replay log of raw bytes. The budget is 256 KiB of raw payload
per session; this intentionally retains roughly one-third more terminal history than the current
256 KiB base64-character accounting while keeping the canonical stored representation at the same
nominal budget. Preserve the current behavior that at least one oversized frame remains intact.

For each attached client:

- capable client: envelope metadata plus the raw replay/live payload;
- legacy client: transiently base64-encode the same payload into the existing JSON message.

Do not retain parallel binary and base64 replay caches. Screen-reset scanning operates directly on
bytes. Replay entries remain `{seq, bytes}` and are converted only at the serving edge.

## 6. Browser boundary

The browser WebSocket selects `binaryType = "arraybuffer"`. The socket hub accepts text messages for
the existing protocol and binary messages for negotiated terminal output, validates the envelope,
routes by session id, preserves sequence/resume semantics, and invokes the byte-native callback from
the correctness issue. Legacy base64 output normalizes to the same callback.

The React Native/native bridge is not required to avoid internal base64. Its client-core surface must
remain compatible and may use the legacy fallback until separately measured.

## 7. Backpressure and compression

Extend the server WebSocket abstraction with an explicit binary send rather than overloading
`sendText`. Apply the existing buffered-amount limits, lossy terminal stream behavior, exception
containment, and permessage-deflate thresholds. Compression decisions use byte length for binary
payloads. No threshold is tuned in this issue.

## 8. Observability

Record low-cardinality counts for negotiated output capability, binary versus base64 frame and
payload bytes, and classified parse/protocol failures. Do not log every frame or attach session ids,
application versions, or other high-cardinality labels.

## 9. Acceptance

- Capable client/new server uses binary output; legacy client/new server uses JSON/base64.
- Two differently capable clients attached to one session receive byte-identical output and resume
  from the same sequence history.
- New server with an old daemon decodes daemon base64 once into canonical replay bytes.
- Replay, reconnect, screen reset, epoch change, compression, and backpressure preserve behavior.
- Binary frames exercise the native Bun server and browser `ArrayBuffer` boundary once in integration.
- Malformed or unnegotiated binary fails closed without affecting other clients.

## 10. Non-goals

No daemon binary output, binary input, dedicated terminal socket, CBOR/Protobuf, packed metadata ABI,
fallback removal, or batching/compression redesign belongs here.
