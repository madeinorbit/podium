# Codex reconnect needs thread rejoin

Measured on flatblock on 2026-09-30 with the real **codex-cli 0.159.0** and
**Bun 1.4.2**. Both clients connected over WebSocket to one surviving app-server.
Its HOME and CODEX_HOME were newly created scratch directories. The environment
contained only scratch paths, PATH, LANG and a dummy FAKE_KEY; model requests went
to the existing loopback fake Responses server. No real credentials or inference
were used. The fake was stopped by its dedicated port after the probe.

| Engine/thread state | New client before rejoin | After `thread/resume` |
| --- | --- | --- |
| Engine alive, thread unloaded | `turn/start` fails with `-32600 thread not found` | Same thread ID and rollout path; a new turn is accepted and completes |
| Engine alive, turn streaming | Client B is `notSubscribed` | Same running turn completes on B after A disconnects; the next turn is accepted and completes |

Disconnecting A does **not** immediately unload the thread on 0.159.0: it remains
in `thread/loaded/list` during a grace period. To reach the unloaded state without
waiting for expiry, the probe used stock `thread/archive` and `thread/unarchive`
RPCs on its scratch thread. It checked that the restored rollout path was exactly
the original path and that `thread/loaded/list` was empty before the failing send.
This measures recovery from unloading; it does not measure the grace duration.
The [official app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes subscription removal and idle eviction after a grace period.

The generated 0.159.0 `ThreadResumeParams` schema states that resume rejoins an
already running thread, with a non-empty path checked against its active rollout.
For an unloaded thread, path takes precedence over thread ID. The driver must
therefore send the journalled ID and available path, and reject a reply naming a
different conversation before publishing the binding.

The unloaded thread was `01a0f2e3-7510-7cf1-9511-fecee13e1955`:

```text
A: thread/start -> thread ID and rollout path
A: turn/start -> completed (fake model)
A: disconnect
B: initialize -> success
B: thread/loaded/list -> [thread ID] (grace period)
B: thread/archive; thread/unarchive -> same rollout path
B: thread/loaded/list -> []
B: turn/start -> -32600 thread not found: 01a0f2e3-7510-7cf1-9511-fecee13e1955
B: thread/resume {threadId, path} -> same thread ID
B: turn/start -> accepted, then completed
app-server still alive throughout
```

The running thread was `01a0f2e3-76b7-7220-bd3c-3f346af0988b`; its original turn,
`01a0f2e3-76f4-79d3-aa1d-49fad5cc5c16`, completed on B about ten seconds after
starting. Resume did not replace the engine or the running turn.

Reproduce from the single isolated test checkout with the installed 0.159.0
executable copied into `.toolchain/codex`:

```sh
.toolchain/bun docs/measurements/pod-4985-thread-rejoin/probe.ts \
  "$PWD/.toolchain/codex" "$PWD/.artifacts/cli-proof"
```

The probe writes timestamped RPC frames, model request records and a compact
`results.json` into that output directory. Generated output stays in the scratch
directory; this measurement summary is the review evidence attached to the issue.

At the tests-only checkpoint `fa2a265e5`, the focused adoption group executed seven
tests: **six failed, one passed**. Failures proved that the old runtime omitted
resume, could not send after unloading, published a handle before resume, and
accepted adoption despite a resume refusal or an incorrect conversation response.
The existing dead-engine fallback passed. The production fix had not been applied
at that checkpoint.
