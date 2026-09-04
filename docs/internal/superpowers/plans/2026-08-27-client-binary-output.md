# Client binary output implementation plan

Issue: `POD-2954`
Spec: `docs/internal/superpowers/specs/2026-08-27-client-binary-output-design.md`
Depends on: `POD-2953`

## Ownership

This worker owns the shared envelope primitive and server-to-client output slice:

- new binary-envelope module/tests and exports under `packages/protocol`;
- client output capability and client-output metadata schemas;
- `apps/server/src/gateway/ws-server.ts`, `ws-send.ts`, client socket/registry output plumbing and
  focused tests;
- `apps/server/src/modules/sessions/terminal.ts` canonical replay/fan-out and focused tests;
- `packages/client-core/src/socket-transport/socket-hub.ts` binary receive path and focused tests.

Do not edit daemon scheduling, PTY reads, daemon handshake/send paths, client input, or measurement
harness files. This issue begins only after POD-2953 is integrated into the parent branch.

## Tasks

1. Add the shared `[u32be metadata length][JSON metadata][payload]` codec with 16 KiB metadata and
   existing 64 MiB total bounds. Add conformance tests for round trips, additive fields, empty payload,
   truncation, impossible lengths, invalid JSON, unknown type, and unsupported version.
2. Add `terminal.output.binary.v1` to the client capability offer and the server's per-connection
   selection. Do not gate on application or wire version.
3. Extend WebSocket abstractions with explicit binary send/receive while retaining text control,
   compression thresholds, exception containment, and lossy stream backpressure.
4. Convert `SessionTerminal` replay to `{seq, bytes}` with a 256 KiB raw budget, byte reset scanning,
   and per-recipient binary/base64 serving. Preserve one oversized replay entry intact.
5. Encode server-to-client v1 output metadata, route binary by session in client-core, and normalize
   legacy and binary output to the byte callback from POD-2953. Set browser `binaryType` to
   `arraybuffer`; preserve native fallback behavior.
6. Add low-cardinality capability, encoding, payload-byte, and parse-failure instrumentation at the
   boundaries already responsible for transport metrics.
7. Prove mixed clients on one session, live/replay/resume/reset behavior, malformed fail-closed,
   compression/backpressure, and the native Bun WebSocket binary boundary. Regenerate server shard
   manifests if a server test file is added or moved.

## Validation and handoff

After all edits and one final commit candidate, run sequentially:

1. `bun run test`
2. `bun run test:integration`

Commit with trailer `Podium-Issue: POD-2954`. Do not merge or deploy. Update the child issue with exact
results and mail the parent issue with the commit SHA, framing/API deviations, and unresolved risks.
