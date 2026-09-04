# Binary terminal input implementation plan

Issue: `POD-2956`
Spec: `docs/internal/superpowers/specs/2026-08-27-binary-terminal-input-design.md`
Depends on: `POD-2955`

## Ownership

This worker owns input framing from terminal/client through server to daemon/PTY:

- input capability and metadata schemas in `packages/protocol`;
- client-core terminal input encode/send and focused tests;
- server client binary receive, terminal/controller authorization, byte routing, daemon serving, and
  focused identity/attribution tests;
- daemon binary input receive, observer origin accounting, PTY bridge write boundary, and focused tests;
- mixed-version and real PTY input integration tests.

Do not alter the envelope layout, output batching/replay, high-level mail/controller composition
semantics, or measurement harness files. Start from the parent branch after POD-2955 is integrated.

## Tasks

1. Add and negotiate `terminal.input.binary.v1` independently on client and daemon connections.
2. Encode browser keyboard/paste strings to bytes once. Use client binary input only when the server
   capability is present; otherwise preserve the current base64 JSON message.
3. Parse client binary input at the authenticated server boundary and feed bytes through the existing
   controller/session authorization path. Ignore any additive payload identity; stamp human origin and
   attribution from the transport principal.
4. Convert higher-level server-generated text to bytes at the terminal boundary. Inspect CR/LF and
   activity on bytes, preserving intentionally separate paste and delayed-submit writes.
5. Serve server-to-daemon input as negotiated binary metadata/payload or legacy JSON/base64. Preserve
   origin and authenticated attribution.
6. Make daemon input handling record metadata and write raw bytes without decode/re-encode on the
   capable path. Preserve fallback adapters for old peers.
7. Add low-cardinality input transport instrumentation and tests for the full compatibility matrix,
   single key, Unicode, control bytes, bracketed/large paste, ordering, forged attribution, unknown
   session, malformed binary, and PTY delivery.
8. Regenerate server shard manifests if server test-file membership changes.

## Validation and handoff

After all implementation and tests are written, run sequentially:

1. `bun run test`
2. `bun run test:integration`

Commit with trailer `Podium-Issue: POD-2956`. Do not merge or deploy. Update the child issue and mail
the parent issue with the commit SHA, exact gate output, and any security/compatibility concern.
