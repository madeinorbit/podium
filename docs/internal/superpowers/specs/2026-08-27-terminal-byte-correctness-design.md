# Terminal byte correctness

Status: implementation specification for `POD-2953` (2026-08-27)

## 1. Outcome

Terminal output reaches xterm as a byte stream. A UTF-8 code point split across two PTY or
transport frames renders once and correctly instead of becoming replacement characters. This
change deliberately keeps the existing JSON/base64 wire format so it can land independently
before binary WebSocket framing.

## 2. Current defect

`packages/client-core/src/socket-transport/socket-hub.ts` decodes each `outputFrame.data` with a
fresh `TextDecoder`, producing a JavaScript string before invoking `SessionCallbacks.onFrame`.
PTY reads, daemon scheduler flushes, and replay frames do not promise UTF-8 code-point boundaries.
Resetting decoding state for every frame therefore corrupts a character whose bytes straddle two
frames. xterm already accepts `Uint8Array` and owns a streaming UTF-8 decoder, so decoding before
that boundary is both redundant and incorrect.

## 3. Contract

1. Legacy base64 output is decoded to `Uint8Array`, not text, exactly once in client-core.
2. `SessionCallbacks.onFrame` is byte-native: `(bytes: Uint8Array) => void`.
3. `SessionMount` passes those bytes to `TerminalView` without decoding or concatenating them.
4. `TerminalView.write` accepts `string | Uint8Array`. Existing direct string callers remain
   source-compatible, while the normal socket path uses bytes.
5. Frame ordering, sequence advancement, epoch/reset behavior, reconnect resume cursors, first-
   frame visibility, and paint-latency hooks remain unchanged.
6. Byte arrays handed to callbacks are immutable by convention. A consumer that must retain and
   mutate data copies it; the transport does not copy merely for defensive ownership.

Do not replace the per-frame decoder with a persistent client-owned `TextDecoder`. That would
create decoder reset rules around detach, reconnect, epoch changes, replay gaps, and multi-session
routing that xterm already implements correctly.

## 4. Compatibility

The wire schema and capability set do not change. Old and new servers and daemons continue sending
the same base64 `outputFrame` JSON. Browser/PWA delivery is the required byte path. Native clients
may continue through their current transport and receive the normalized `Uint8Array` callback;
this issue does not claim that a native WebSocket bridge avoids base64 internally.

## 5. Acceptance

- Two output frames containing the two halves of one multi-byte UTF-8 character are delivered as
  two byte arrays and render as the original character through xterm's streaming decoder.
- ASCII, escape sequences, empty frames, replayed frames, and frames after reconnect preserve their
  existing order and callback count.
- `lastOutputSeq` advances only after the callback accepts the same frame it advances for today.
- `TerminalView.write("text")` remains valid for existing package consumers and tests.
- No new capability, WebSocket binary message, server change, daemon change, or wire-version bump is
  introduced.

## 6. Non-goals

This issue does not implement binary WebSocket output, change replay storage, alter xterm itself,
or tune rendering and batching. Those belong to the dependent output and measurement issues.
