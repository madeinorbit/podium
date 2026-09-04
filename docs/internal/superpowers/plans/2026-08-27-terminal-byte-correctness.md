# Terminal byte correctness implementation plan

Issue: `POD-2953`
Spec: `docs/internal/superpowers/specs/2026-08-27-terminal-byte-correctness-design.md`
Base: `issue/2931-pty-stream-wire-format`, itself based on `dev/mw`

## Ownership

This worker owns the terminal output callback boundary only:

- `packages/client-core/src/socket-transport/socket-hub.ts` and focused socket-hub tests;
- `packages/terminal-client/src/session-mount.ts`, `terminal-view.ts`, and focused tests.

Do not edit server, daemon, PTY, WebSocket framing, protocol capability, or benchmark files. POD-2957
may work concurrently but owns only new measurement harness/report files.

## Tasks

1. Replace `fromBase64Utf8` with a base64-to-`Uint8Array` helper that performs no text decoding.
2. Change `SessionCallbacks.onFrame` and session delivery state to bytes while preserving the exact
   point at which `lastOutputSeq` advances.
3. Pass bytes through `SessionMount` and widen `TerminalView.write` to `string | Uint8Array`.
4. Update existing test fixtures/helpers that inject terminal frames to use bytes without broad
   mechanical rewrites outside the owned boundary.
5. Add the counterexample regression: split one multi-byte code point across two output frames and
   prove the terminal receives the two original byte chunks in order. Cover reconnect/first-frame
   bookkeeping where the type change touches it.
6. Review for accidental `TextDecoder` use on terminal output; clipboard/OSC decoding is unrelated and
   stays text-oriented.

## Validation and handoff

After all edits, run once, sequentially:

1. `bun run test`
2. `bun run test:related -- packages/client-core/src/socket-transport/socket-hub.ts packages/terminal-client/src/session-mount.ts packages/terminal-client/src/terminal-view.ts`

Commit with trailer `Podium-Issue: POD-2953`. Do not merge or deploy. Update the child issue with the
exact command results and mail the parent issue with the commit SHA and any unresolved concern.
