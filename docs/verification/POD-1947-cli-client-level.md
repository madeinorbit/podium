# POD-1947 — raising a client's log level from the CLI, verified end to end

`podium logs clients` / `podium logs level` against the **running** instance on
ludovico (`https://ludovico.shetland-banjo.ts.net:55555`), 2026-08-12, from the
issue worktree via `bun --conditions @podium/source scripts/cli.ts`. Host clock
is CEST; the client records below carry the *browser's* clock (UTC), which is why
their timestamps read two hours earlier — they are the same events.

The claim being verified is not "the command returns ok". It is that **the level
change reaches a real connected client and changes what actually gets written**,
and that the reset puts it back.

## 1. Discovery

```
$ podium logs clients
1 client connected, now at its boot default:
  c3  role=web

Listing IS a reset — the server reports who is connected only by answering a
level command, and `level: null` is the safe one to send blind.
Raise one with `podium logs level debug --role <role>`.
```

`--json` gives the reply verbatim:

```json
{"command":"logs clients","ok":true,"data":{"level":null,"clients":[{"clientId":"c3","role":"web"}]}}
```

## 2. The raise

```
$ podium logs level debug --role web --for 5m
Raised 1 client to debug for 5m:
  c3  role=web

Reproduce the problem, then read:
  logs/clients/web.ndjson
It turns itself back down when the window expires; `podium logs level reset` is sooner.
```

The client's own file records the transition, at `warn` so it survives the
default threshold (`~/.podium/logs/clients/web.ndjson`):

```json
{"ts":"2026-08-12T16:48:26.444Z","level":"warn","ns":"client-core:log-level","msg":"client log level raised","to":"debug","ttlMs":300000,"role":"web",…}
```

## 3. The level change takes effect in what is WRITTEN — the A/B

`client-core:socket-hub` logs a reconnect twice: `socket closed — reconnecting`
at `warn`, then `reconnecting` at `debug`. The same event therefore writes one
record at the default and two while raised, which is the cleanest evidence
available on an idle tab.

**Before the raise** (client at its `warn` boot default) — four socket closes,
no `debug` sibling for any of them:

```json
{"ts":"2026-08-12T16:46:25.195Z","level":"warn","ns":"client-core:socket-hub","msg":"socket closed — reconnecting","retryInMs":1000,…}
{"ts":"2026-08-12T16:46:26.267Z","level":"warn",…,"msg":"socket closed — reconnecting","retryInMs":2000,…}
{"ts":"2026-08-12T16:46:28.332Z","level":"warn",…,"msg":"socket closed — reconnecting","retryInMs":4000,…}
{"ts":"2026-08-12T16:47:52.085Z","level":"warn",…,"msg":"socket closed — reconnecting","retryInMs":500,…}
```

`grep -c '"level":"debug"' web.ndjson` → **0** across all 105 lines.

**During the raise**, the next reconnect writes both records:

```json
{"ts":"2026-08-12T16:50:20.609Z","level":"warn","ns":"client-core:socket-hub","msg":"socket closed — reconnecting","retryInMs":500,…}
{"ts":"2026-08-12T16:50:21.112Z","level":"debug","ns":"client-core:socket-hub","msg":"reconnecting","afterMs":1000,…}
```

That `debug` line is the whole feature: a record that the client had been
discarding at its own threshold for the previous 105 lines is now forwarded to
the server and on disk, because one `setLogLevel` frame moved console and
forwarding together. It appeared 33 s after the raise, with no client-side
action and no new build.

## 4. Reading it back

`podium logs <origin>` now finds `logs/clients/<origin>.ndjson`, so the flow the
command is shaped for does not end at a bare path:

```
$ podium logs web --pretty
16:47:52.085 WARN  client-core:socket-hub socket closed — reconnecting retryInMs=500 role=web platform=Mozilla/5.0 …
```

Only for an explicitly named component — bare `podium logs` still means this
host's own processes.

## 5. The reset

```
$ podium logs level reset --role web
Restored 1 client to its boot default:
  c3  role=web
```

and the client files it, naming what it came down from:

```json
{"ts":"2026-08-12T16:46:10.320Z","level":"warn","ns":"client-core:log-level","msg":"client log level restored","from":"debug","to":"warn","reason":"reset",…}
```

## 6. The failure that must not look like success

A selector matching nothing is the way this ships broken, so it is the case with
its own exit code:

```
$ podium logs level debug --role nosuch
No connected client matched. Nothing was raised.
Run `podium logs clients` to see what is connected right now.
$ echo $?
1
```

`--json` carries the same verdict as `ok:false`. A **reset** that matches nothing
stays exit 0 and says why — a client that is gone is already at its default.

Observed once during this session and worth knowing: a reset issued while the
client happened to be mid-reconnect answered `No connected client matched`, and
the next call reached it under a **new** connection id. Connection ids churn on
reconnect; `--role`/`--machine` are the stable selectors, and `--client` is for
telling two tabs apart within one sitting.

## Gates run

| Gate | Command | Result |
|---|---|---|
| CLI unit lane | `apps/cli` → `vitest run` (full config) | **27 passed / 1 skipped, 426 tests**, exit 0 |
| Server logs module | `apps/server` → `bun test --conditions @podium/source src/modules/logs/ src/modules/issues/relay-gate.test.ts` | **21 passed**, exit 0 |
| Typecheck | `bun scripts/typecheck.ts` | 24/24 successful |

Exit statuses were read directly (`echo "EXIT=$?"` on the command itself, output
redirected to a file) — never through a pipe into `tail`, which reports the
pipe's status.

`apps/server`'s own `bun run test` refuses before running: *"the shard roster
does not describe this checkout"*, listing four unowned test files
(`handoff-transfer.types.test.ts`, `store-issues-frame-cache.test.ts`,
`store-users-frame-cache.test.ts`, `store.conversation-idle-writes.test.ts`).
That is **pre-existing and not attributable to this branch**: `git diff --stat
main -- apps/server packages/` is empty — this change touches `apps/cli` and
`docs/` only.
