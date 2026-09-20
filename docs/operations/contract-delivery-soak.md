# Contract delivery rollout — REMOVED (POD-4427)

This runbook used to soak the hot delivery config switch (the `features.*`
flag that fenced legacy PTY-typing delivery against daemon-headed delivery),
which is deleted along with everything it fenced.

- There is one delivery for agent sessions: the durable FIFO drains through
  `SessionRuntimeGateway` into the daemon's driver (`when-ready` /
  `interrupt` / `answer`). The server never types at, polls, or retries a
  harness. Readiness and retry live in the daemon's per-driver delivery queue.
- Plain-terminal shells keep the raw transport only (byte relay + resize).
- The delivery key is gone from the config schema. Unknown keys
  in an existing `~/.podium/config.json` are ignored, so no migration is
  needed — a stale key in the file is inert, not an error.
- Queued rows left by the previous release drain once through the gateway; a
  row's old `attempts` count marks a possible prior write (recovery), never a
  retry schedule.

There is nothing to soak, flip, or roll back. Do not reintroduce a gated second
path: POD-4414 measures "done" by subtraction. POD-3744 (the old removal gate)
is superseded by POD-4427.
