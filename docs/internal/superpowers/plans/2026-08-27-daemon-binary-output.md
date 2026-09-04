# Daemon binary output implementation plan

Issue: `POD-2955`
Spec: `docs/internal/superpowers/specs/2026-08-27-daemon-binary-output-design.md`
Depends on: `POD-2954`

## Ownership

This worker owns the byte-native PTY/daemon/server-output ingestion slice:

- `packages/pty/src/session.ts` and focused tests;
- `apps/daemon/src/output-scheduler.ts`, session control/output observation, connection state, daemon
  socket composition, and focused tests;
- daemon-output metadata schema/capability use in `packages/protocol`;
- `packages/protocol/src/messages/local-link.ts` only as needed for typed byte delivery;
- server daemon acceptor/socket receive plumbing and `SessionTerminal` raw ingestion;
- daemon/server integration tests for local, remote, and mixed-version output.

Do not change client output framing, client input, binary-envelope layout, scheduler timing constants,
or measurement harness files. Consume the codec and server replay APIs already integrated from
POD-2954.

## Tasks

1. Change PTY `AgentFrame.data` and daemon scheduler queues to immutable bytes. Preserve sequence,
   priority tiers, immediate scheduling, 75 ms delay, and 64 KiB byte threshold.
2. Make composer/session observers consume bytes directly and remove output base64 conversions from the
   capable internal path.
3. Add daemon output capability offer/support, retain the accepted daemon handshake capability set,
   and select binary only on mutual acknowledgement.
4. Encode remote daemon output as v1 metadata plus one concatenated payload and source-frame count.
   Extend daemon send/receive abstractions without changing JSON control/RPC handling.
5. Pass local all-in-one output as typed metadata plus bytes on the existing microtask boundary, with no
   envelope serialization.
6. Accept daemon text fallback or negotiated binary at the server boundary and converge both on raw
   `SessionTerminal` ingestion. Keep server sequence/epoch authority.
7. Add instrumentation at daemon/server output boundaries and tests for new/new, new/old, old/new,
   local link, scheduler batching, reset/composer behavior, malformed binary, and backpressure.
8. Regenerate server shard manifests if test-file membership changes.

## Validation and handoff

After implementation is complete, run sequentially:

1. `bun run test`
2. `bun run test:integration`

Commit with trailer `Podium-Issue: POD-2955`. Do not merge or deploy. Update the child issue and mail
the parent issue with the commit SHA, exact gate output, and any compatibility or ownership concern.
