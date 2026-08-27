# Daemon binary terminal output

Status: implementation specification for `POD-2955` (2026-08-27)

## 1. Outcome

PTY output remains bytes from the process read through daemon scheduling, all-in-one delivery, remote
daemon transport, server replay, and client fan-out. A mutually capable remote daemon/server pair
uses binary WebSocket messages; either mixed-version direction falls back to the existing JSON/base64
daemon messages. JSON control and RPC traffic remain text.

This issue depends on the shared envelope and byte-native server replay delivered by client binary
output. It must consume those contracts rather than introducing a second codec.

## 2. Byte-native daemon path

1. `@podium/pty` exposes `AgentFrame.data` as `Uint8Array` without base64 encoding.
2. `OutputScheduler` stores byte frames, counts `byteLength`, preserves its priority tiers, immediate
   flushes, 75 ms coalescing, and 64 KiB coalescing threshold.
3. A flush concatenates the scheduled byte stream at most once. PTY frame boundaries carry no
   terminal semantics; `sourceFrames` preserves activity accounting.
4. Composer/session observers that inspect output receive bytes directly.
5. The all-in-one `LocalDaemonLink` passes typed metadata and `Uint8Array` by reference on its existing
   asynchronous microtask boundary. It does not serialize the network envelope merely for parity.

Byte arrays are immutable after delivery by contract. Code that retains mutable ownership copies
explicitly.

## 3. Remote negotiation and framing

The daemon offers `terminal.output.binary.v1` in `PeerHello`. The server daemon acceptor includes the
same token in its supported capability set. The daemon must retain the accepted capability set from
`PeerHelloOk`; the current connection state discards it and must be corrected.

The daemon sends binary output only when the accepted set contains the token. Therefore:

- new daemon -> old server: the old server does not acknowledge the token, so daemon output remains
  JSON/base64;
- old daemon -> new server: no token was offered, so the new server accepts JSON/base64 and decodes it
  once;
- new daemon -> new server: output uses the shared binary envelope;
- all-in-one: identical code in one process uses direct typed bytes without network negotiation.

Daemon-to-server metadata is:

```ts
{
  v: 1,
  type: 'ptyOutput',
  sessionId: SessionId,
  sourceFrames: number, // positive integer
}
```

The payload is the concatenated scheduled bytes. Daemon-local frame sequence numbers do not become
server replay sequence numbers; the server continues assigning `seq` and `epoch`.

## 4. Server receive boundary

The native `/daemon` WebSocket continues receiving text or `Buffer`. Before capability negotiation,
binary is a protocol violation. After negotiation, text is decoded through the existing daemon JSON
schema and binary through the shared envelope plus daemon-output metadata schema. Both converge on one
`SessionTerminal.acceptFrames(bytes, sourceFrames)`-style byte API.

Preserve authentication, principal routing, machine binding, message classification, replay reset
detection, activity counters, and lossy client fan-out. Binary framing never carries authorization
claims.

## 5. Compression, backpressure, and errors

Remote output retains the existing permessage-deflate thresholds and daemon/server socket
backpressure behavior. Size calculations use raw byte length. Malformed, oversized, unnegotiated, or
unsupported binary closes the daemon connection and lets the existing reconnect state machine recover;
it never falls back mid-connection after a protocol error.

Record low-cardinality counts for negotiated capability, encoding choice, payload bytes, and protocol
failures. Do not emit per-frame logs.

## 6. Acceptance

- PTY bytes do not become base64 anywhere on the capable all-in-one or capable remote output path.
- All three remote mixed-version combinations select the expected encoding without deployment-order
  assumptions.
- Scheduler timing, source-frame activity counts, screen-reset behavior, replay sequence assignment,
  composer observation, and client fan-out remain unchanged.
- The local link delivers direct bytes asynchronously and the remote link exercises a real binary
  WebSocket boundary.
- Split UTF-8 and escape sequences remain byte-identical end to end.
- Backpressure and malformed-frame behavior are proven at their existing choke points.

## 7. Non-goals

This issue does not add binary input, remove legacy message schemas, create a dedicated socket, change
scheduler timing, or tune compression.
