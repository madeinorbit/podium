# Claude stream-json vs. the session file (POD-6280)

Claude CLI 2.1.317, driven over stream-json the way `claude-sdk/protocol.ts` drives it, against a fake Anthropic Messages server (`rig/fake.ts`; no credentials). Run on the polaris agents VM on 2026-11-03. `rig/run.sh <rigdir> <port>` sets up a scratch config, starts the fake server and a 1 ms poller over the session files (`rig/watch.ts`), then runs `rig/drive.ts`.

## Identity

- The `stream_event` `message_start` carries `event.message.id`, which is the same id as the file record's `message.id`.
- The `stream_event` line's own `uuid` is a different value. Each stream line has its own.
- The stream's `assistant` and `user` lines carry the exact `uuid` of the file record they become.
- The stream's `assistant` lines have `stop_reason: null`. The file record has `end_turn` or `tool_use`, so a stream line mapped through the file parser would lose the answer mark.
- A message with a text block and a `tool_use` block becomes two file records with one `message.id` between them.

## Order

Each value is when the file record was first seen minus when the matching stream line arrived, in ms. A negative value means the file came first.

| What | Values |
|---|---|
| A turn's final record vs. the stream's `result` (10 turns) | -2, -7, -3, 0, 0, 1, -2, 0, 0, -1 |
| Every assistant record vs. its stream `assistant` line | 5–14; 111–121 for the text of a text-plus-tool message, which is written with the tool result |

So the final record can land just after the turn's `result`. The driver closes a turn only once the file tail has delivered the record named by the turn's last `assistant` line, or after `TURN_RECORD_WAIT_MS`.
