# OpenCode command provenance after restart

OpenCode 1.18.33 cannot reliably identify custom command expansions from
`command.executed`. The event arrives after the assistant reply finishes, is not
stored by OpenCode, and does not replay. A crash during the reply leaves the
expansion in history without ever emitting the marker. The adapter therefore
retains the display residual documented in [spec §7](../../plans/pod-4819-harness-receipt-proof.md#7-per-program-measured-facts-and-proposed-decisions).

Measured on 2026-09-30 for POD-4906, following POD-4893's
[TUI capture](../pod-4834-receipt-proof/opencode-1.18.33/tui/timeline.jsonl).
The original capture establishes that the TUI's `/probe` command uses a plain
user text row. This probe exercises the native v1 command endpoint with the same
command template, a new scratch HOME/XDG tree, and a loopback fake OpenAI model.
Only the fake provider is enabled; no real credentials or operator state are
inherited. The scratch server is killed and restarted against its own database.

| Case | Live capture | Reconnect / restart | Durable history |
|---|---|---|---|
| Completed `/probe completed` | One `command.executed`, after the assistant's completed message | No replay on a new `/event` connection | User text expansion and assistant reply; no command marker |
| `/probe missed` with the external event subscribers disconnected | The independent measurement plugin receives one event | No replay after subscribers return | Same plain user/assistant records |
| `/probe SLOWTEXT crash-before-event`, killed during the fake reply | Both user and assistant rows exist; neither SSE nor the plugin receives `command.executed` | No command marker after process restart | The unchanged user expansion survives, including its text part |
| Fresh `/probe after-restart` | The restarted v1 stream receives one fresh event | Positive control: the restarted subscriber works | Another plain user expansion |
| Ordinary HTTP prompt with exactly the completed expansion's text | Normal prompt records | Not a custom command | User metadata and text-part payload match the expansion's, apart from time and identity |

The completed event names assistant `msg_0f078d8b8001odwmPB2bblAIyJ`; its native
`parentID` is expansion `msg_0f078d88d001EVv36YWLtXutf1`. The assistant's completed
time is `1790740847828`; the event is received at `1790740847856`, after the native
completed-message frame. Its parent has only user metadata and a text part:

```json
{"type":"text","text":"S9 CMD TEMPLATE expanded with: completed"}
```

In the crash case, expansion `msg_0f078ee2b001wZPKV8Nr7NRx5D` and assistant
`msg_0f078ee3f0014og5wLSzkDWCpl` are stored before SIGKILL. The assistant has a
`parentID` but no completed time. The expansion and part survive unchanged;
there is no command event naming that assistant, either before or after restart.
Persisting events in a Podium plugin would retain events it saw, but cannot
recover an event OpenCode never emitted.

## Persistence and replay scope

The probe dumps all 20 user tables, not just `event`. The final `event` table has
60 rows: `session.created.1`, `session.updated.1`, `message.updated.1`, and
`message.part.updated.1`; none records `command.executed` or command provenance.
The `session_message` table is empty for these v1 commands. The native file census
covers 157 regular files under the scratch HOME and work directory, including
configuration, state, cache metadata, and native logs. It finds no
`command.executed` marker. Dependencies, snapshot repositories, binary database
files, and large/binary payloads are excluded from text scanning; database
contents are inspected separately through SQLite. The measurement plugin's
added capture log lives outside those native roots and is never counted as
OpenCode persistence.

Each v1 reconnect uses `after=0` and `Last-Event-ID: 0`, receives HTTP 200 and
`server.connected`, and gets no historical commands. `/api/event` also connects
and provides live native updates but no historical commands. The v2 session
stream `after=0` produces no frames for these v1 commands; its response headers
remain unflushed. The v2 message list returns HTTP 200 with an empty `data` list,
while the v1 history returns the stored messages. These v2 observations are
limited to v1 command records, not a claim about replay of v2 prompt admissions.
The restart stream remains open through the fresh command's successful reply;
only that fresh command's event appears.

The fake model slows replies whenever `SLOWTEXT` is in the retained user
conversation. Consequently the fresh command after restart also takes about
27 seconds, extending the observed restart window. This affects timing, not
the native provenance fields. The final ordinary prompt is sampled after its
user text is stored, while its fake reply is still running.

## Reader decision and receipt safety

Keep the stored expansion visible with its existing user role. Classifying it
as a program entry would require evidence that survives subscriber gaps and
crashes; neither the message/part payload nor replay supplies that evidence.
Do not infer origin from id shape, text, time proximity, or a command-before
hook paired with a later prompt. An ordinary prompt can have identical text
and metadata.

This remains a display residual. Order-plus-text (§5.3) still requires the
recorded text to agree with the submitted words: `/probe completed` cannot
match `S9 CMD TEMPLATE expanded with: completed`. A command expansion supplies
no additional delivery proof.

## Evidence and reproduction

Run from the repository root with OpenCode **1.18.33** and pinned Bun:

```sh
bun docs/measurements/pod-4906-opencode-command-events/measure.ts
```

The runner allocates free loopback ports, creates a scratch HOME, captures the
native command route and events, and removes its scratch tree in `finally`.
An optional first argument selects the output directory; `OC_BIN` selects the
OpenCode executable. Scratch paths in committed evidence are replaced with
`$SCRATCH`.

- [Timeline](timeline.jsonl): HTTP calls/replies, SSE frames, model requests,
  snapshots and crash/restart boundaries in observed order.
- [Summary](summary.json): exact native identities and measured outcomes.
- [Completed snapshot](completed.json), [before-kill snapshot](crash-before-kill.json),
  [restart snapshot](restart.json), and [final snapshot](final.json): schema and all
  table rows, including the plain user parts and the durable event types.
- [Plugin capture](hooks.jsonl.json): independent live positive control and absence
  of a command marker for the killed command.
- [Native file census](native-files.json) and [route schemas](routes.json).

Regression coverage is in
[`transcript-command-events.test.ts`](../../../packages/harness/src/adapters/opencode/transcript-command-events.test.ts).
It reads these captured frames and rows without starting OpenCode or a model.

The focused end-of-task command was:

```sh
bun run test:file -- packages/harness/src/adapters/opencode/transcript-command-events.test.ts packages/harness/src/adapters/opencode/transcript-prompt-entries.test.ts packages/harness/src/adapters/opencode/transcript-prompt-text.test.ts scripts/test-configuration.test.ts
```

All 25 OpenCode regressions passed, including the five new command cases. The
configuration file reported 39 passed and one existing failure, tracked by
POD-4907 and POD-4921: its Vitest invocation regex mistakes `lint:vitest-env` and
`check-vitest-env.ts` for runner commands. Both `package.json` and that guard are
byte-identical to the base revision `7e5892f8d`; this change does not modify them.
The four-file result is **64 passed, one failed**, not a green lean gate or a
suite result. No product behavior changes, so the broader runtime gate was
skipped; the focused lane covers the measured reader cases and cache declaration.
