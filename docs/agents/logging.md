# Logging (for agents)

Everything Podium runs — server, daemon, janitor, CLI, web, desktop webview, the
Expo app — logs through **one core**, `@podium/logger`. `console.*` in product
source is a lint failure (`console-ownership` in
[`scripts/check-boundaries.ts`](../../scripts/check-boundaries.ts)); the
exemptions are listed there, in code, with reasons.

The reason is not tidiness. A `console.warn` in a detached server goes to a pipe
nobody reads; on a phone it goes nowhere at all. A logger record goes to every
registered sink at once — the console you are watching, the rotating file on
disk, the ring buffer that a crash report carries with it.

Design: [`docs/superpowers/specs/2026-08-11-logging-strategy-design.md`](../superpowers/specs/2026-08-11-logging-strategy-design.md).

## Writing a log line

```ts
import { createLogger } from '@podium/logger'

const log = createLogger('server:relay')   // module scope, once per file

log.warn('daemon handshake retry', { machineId, attempt, durationMs })
log.error('write failed', { err })          // `err` is the reserved error key
```

Namespace convention is `<package-or-role>:<module>` — `server:relay`,
`daemon:pty`, `runtime:boot`, `client-core:replica`, `sync:ledger`. Packages that
run on more than one host (`packages/sync`, `packages/client-core`) name the
**module**, not the host: the `role` field on every record already says which
process it came from, so one namespace serves all of them and there is no
host-specific import to get wrong.

## Levels

Severity is an **attention** axis, not a category. There is no `perf` level;
performance rides as a `durationMs` field on a normal record, at `warn` when it
overran a budget.

| Level | Means | Examples |
|---|---|---|
| `error` | A broken invariant; someone needs to look | unhandled exception, failed durable write |
| `warn` | Degraded but recovering, or a budget overrun | retry, dropped frame, quota degrade, slow op |
| `info` | Lifecycle | boot, shutdown, session start, config load |
| `debug` | Diagnosis detail | state transitions, RPC summaries |
| `trace` | Firehose | per-frame / per-message detail |

Two things follow from the sink table below and are worth knowing before you
pick a level:

- **`warn` is the client's default visibility.** A browser, webview or phone
  shows `warn` and above unless someone raises it. A diagnostic that must be
  seen the moment it happens on a user's machine belongs at `warn`, not `info`.
- **`debug` is cheap and worth writing.** The ring buffer is pinned at `trace`
  and always on, so a `debug` record costs memory and nothing else until a crash
  fires — at which point it is the minute of context that explains the crash.
  Write it. On a genuinely hot path (per PTY frame, per feed row) guard with
  `log.isLevelRequested('trace')` — it answers "did an operator turn this
  namespace up?", so the cost is only paid when someone is looking. That guard
  keeps the records out of the flight recorder too, which is the trade: use it
  where the volume is real, and prefer an unguarded `trace` everywhere else.
  (`log.isLevelEnabled` is the other predicate, and it is *not* the one for a
  hot path: the ring buffer pinned at `trace` makes it true forever.)

## Fields

Fields are free-form and structured — put the values in the object, not in the
message string. `log.warn('mirror failed', { nativeId, err })` is greppable and
queryable; `log.warn(\`mirror failed for ${nativeId}\`)` is neither, and the
message stops being a stable key to group by.

The record shape owns `ts`, `level`, `ns`, `msg`, `role`, `v` and `err`. A
caller field under one of those names is **dropped**, not merged — a call site
overwriting `ns` would silently corrupt the one column every query groups by.
`err` is the exception, reserved precisely so you can pass one; it goes through
the error serializer (name / message / stack / cause) on the way in.

`role` and `v` come from the process context set once at boot, not from call
sites.

### `v` — which build wrote this line

`v` exists to answer one question: does the thing that logged this contain a
given fix? It is set at boot by each role's composition root and is never
absent.

| role | `v` | set by |
|------|-----|--------|
| released binary (any role) | the release version, e.g. `0.9.9` | `PODIUM_APP_VERSION`, baked in by `scripts/build-bun.ts` |
| server / daemon / janitor / cli from source | `dev+<short sha>`, plus `-dirty` when the tree differs from that commit | `resolveLogVersion` in `packages/runtime/src/logging.ts` |
| web / desktop (the same bundle) | `PODIUM_APP_VERSION`, or `dev+<short sha>` on a dest host | `pageBuildVersion` in `apps/web/src/lib/logging/build-version.ts`, from `<meta name="podium-version">` or the Vite define |
| mobile | the build-time inline, else `dev` | `appVersion()` in `apps/mobile/src/lib/logging.ts` |

The product version is the same string Update, `/version`, and About show.
The Vite entry-chunk hash (`bundle+DHMkD0wf`) stays on the stamp as
`bundleVersion` so a crash stack can still be matched; it must not replace
`v`. Server/daemon source logs may still append `-dirty` via
`developmentLogVersion()`; Update never does.

None of this is optional, deliberately (POD-1965). `ClientLoggingOptions.version`
is a REQUIRED field because it used to be optional, both web callers omitted it,
and every web record shipped with no `v` at all for months — a defect made
entirely of an absent field, which is the kind no test notices unless one asserts
presence. Those assertions exist now; if you add a role, add one for it too.

## Raising verbosity

| Where | How |
|---|---|
| Server / daemon / janitor / CLI | `PODIUM_LOG_LEVEL=debug` for everything |
| One namespace | `PODIUM_LOG='daemon:*=debug'` — comma/space separated, most specific pattern wins |
| Clients (no env: browser, webview, phone) | `podium logs level debug --role web` from a shell on the server host — see below |
| A REMOTE machine's daemon (no shell on it) | `podium logs daemon-level debug --machine <id>` from the coordinating server — see below |
| Desktop Rust side | `PODIUM_LOG_LEVEL` only; the per-namespace syntax is not implemented in the crate |

Raising a client's level raises the console **and** the forwarding stream
together — one knob, so a client's reported level and its visible level can
never disagree. On the server family, `PODIUM_LOG_LEVEL`/`PODIUM_LOG` always
beat the process's own default; nothing pins its own threshold.

### Raising a client you are not sitting at

A browser, webview or phone has no env to set, and the whole point of forwarding
is diagnosing a problem on someone else's machine. From a shell on the server
host — which is where you are:

```sh
podium logs clients                              # who is connected, and what they call themselves
podium logs level debug --role web --for 30m     # turn one up
# …reproduce the problem…
podium logs web-<machine> --pretty               # read what it forwarded
podium logs level reset --role web               # put it back
```

The selector flags are `--role`, `--machine` and `--client`; they AND together,
and no selector at all means every connected client. `--for` takes `90s`, `30m`
or `2h`, defaults to the client's own 30 minutes, and is capped at 24h.

Two things to know before you use it:

- **`podium logs clients` is also a reset.** There is no "list connected
  clients" query — the server answers "who is connected" only by replying to a
  level command, so the listing sends the safe one (`level: null`) and puts every
  client back to its boot default. Do not run it in the middle of an
  investigation expecting a passive read; run it *before* you raise.
- **A raise that matched nothing exits non-zero** and says so, rather than
  printing an ok. That is the failure mode worth guarding: a typo'd `--role`
  reaches no connection, and the server has no way to call that an error (see
  below).

Underneath it is one call to `logs.setLevel` (tRPC, admin), which pushes a level
down the client socket to the connections open right now:

```jsonc
// every connected client, for half an hour
{ "level": "debug", "ttlMs": 1800000 }
// one of them, named the way its log file is
{ "level": "debug", "target": { "role": "mobile", "machineId": "m2" } }
// and back
{ "level": null }
```

The reply lists every connection it reached, with the role/version/machine that
connection reported — which is the same tuple `clients/<origin>.ndjson` is named
after, and is how you find out what is connected in the first place. An unknown
`clientId` is not an error; it simply reaches nobody. The CLI prints that
reached-list verbatim for exactly this reason.

The CLI talks to the local server over `/trpc` with the operator's credential,
**not** through the agent relay: `logs.setLevel` reaches across into somebody
else's running client, so it is not something a scoped agent capability carries.
Run it on the box the server is on.

Targeting is `role` / `machine` / `clientId` only. There is no per-namespace
raise for a client: the wire frame carries a global level, so a `--namespace`
flag would be a promise it cannot keep.

Three things about it are load-bearing:

- **`level` is the whole knob.** It lands in `setLogLevel` on the client, and the
  forwarding sink pins no threshold, so console and forwarded stream move
  together. There is no separate forwarding threshold and adding one would break
  that silently.
- **Every raise expires.** `ttlMs` defaults to 30 minutes on the client and is
  capped at 24 hours; `level: null` restores the client's *boot* default rather
  than a named level, so a change to that default cannot strand a stale one in a
  support instruction.
- **Nothing is persisted, on either side.** The server keeps no "should be at
  debug" table, so a client that reloads or reconnects is back at its default
  with nobody having to remember to undo anything. That is also why the raise
  and its expiry are logged at `warn` on the client: in the forwarded file they
  are what separates "this client had nothing to say" from "this client was
  never turned up".

The user at the client can do the same thing from **Settings → Privacy →
Diagnostic detail** ("turn up for 30 minutes"), which drives the identical knob —
for hosted installs, phones, and anyone you cannot give a shell command to.

### Raising a daemon on a machine you have no shell on

Same problem one plane out: a remote host's daemon has an env you cannot set and
a journal you cannot read without SSH. From the **coordinating server**:

```sh
podium logs daemons                                     # which machines have a live daemon
podium logs daemon-level debug --machine <id> --for 30m # turn one up
# …reproduce the problem…
podium logs fleet-<id> --pretty                         # read what it forwarded
podium logs daemon-level reset --machine <id>           # put it back
```

Everything the client verbs promise holds here — the listing is also a reset, a
raise that matched nothing exits non-zero, `--for` defaults to 30 minutes and is
capped at 24h — plus three differences that are the whole design:

- **A daemon forwards nothing until it is raised.** A browser forwards `warn`+
  continuously because its records are the user's own data moving between the
  user's own processes. A remote daemon's records are *another host's* paths,
  branch names and command output crossing a network, so the default is closed
  and every raise expires. An empty `fleet-<id>.ndjson` before you raise is
  correct, not a broken pipeline.
- **The raise ships the recent past.** The daemon keeps a `trace` flight recorder
  in memory at all times and sends it as the first batch, so the central file
  starts *before* the moment you typed the command — including records below the
  level the daemon was running at.
- **The machine is not self-reported.** The daemon frame carries no machine
  field. The server files the records under the machine the daemon socket
  *authenticated as*, so `fleet-<id>.ndjson` is a claim the server made, where
  `clients/<origin>.ndjson` is a claim the client made about itself.

A raise that a machine misses because it was offline is simply not delivered —
the command sends only to machines with a live socket and lists what it reached.
Re-issue it; nothing is queued, deliberately.

Underneath it is one call to `logs.setDaemonLevel` (tRPC, admin) — the sibling
of `logs.setLevel` above, same admin floor, same "no state on the server" rule —
which pushes a `setDaemonLogLevel` control frame down the daemon socket.

## Where the logs are

The two process families wire different sink sets, and the difference matters
when you are wondering where a line went.

**Server family** (server, daemon, janitor, CLI) gets **exactly one** sink,
chosen by how the process is supervised — no double-writing:

| Supervised as | Sink | Destination |
|---|---|---|
| systemd | stdout NDJSON | the unit's stdout; journald owns retention |
| detached | rotating NDJSON file | `~/.podium/logs/<role>.ndjson` |
| foreground | console, pretty | your terminal |

Default level is `info`, except the CLI, which defaults to `warn` so an ordinary
command stays quiet. Either default yields to `PODIUM_LOG_LEVEL`/`PODIUM_LOG`.

**Clients** (browser, desktop webview, Expo app) get **three at once**, and they
disagree on purpose:

| Sink | Threshold | What it is for |
|---|---|---|
| Console | follows config (`warn` by default) | the developer looking right now |
| Ring buffer | `trace`, always | the flight recorder a crash report carries |
| Forwarding | follows config (`warn` by default) | the operator later, via the server |

On disk:

- **Server family:** `~/.podium/logs/<role>.ndjson`, rotated at 10 MB × 5.
- **Forwarded client logs:** `~/.podium/logs/clients/<origin>.ndjson`, one file
  per origin (role + machine), same rotation.
- **Forwarded remote-daemon logs:** `~/.podium/logs/fleet/<machine>.ndjson`, one
  file per machine, same rotation. A separate directory from `clients/` on
  purpose: the machine there is the one the server *authenticated*, not one a
  peer described itself as, and the two evidentiary grades should not share a
  filename space.
- **How both forwarded families are written:** one primitive
  (`apps/server/src/modules/logs/queued-writer.ts`). Ingestion **never writes on
  the request or socket callback that carried the batch**. Records are tagged and
  queued, and the queue drains in bounded slices between event-loop turns, so a
  500-record batch costs the next request a slice rather than the batch. The
  queue is bounded and drops **oldest**; those drops are counted apart from the
  drops a sender reports about its own queue, because a lossy link and a
  saturated server are different problems. A sender's reported drops are also
  written **into the file** as a marker record, so a gap is not ambiguous to
  whoever reads it. At shutdown the final drain is unsliced — there is no request
  left to protect and the tail is the part that explains the stop.
- **Under systemd:** nothing on disk here — records go to the unit's stdout and
  journald owns them.
- **`~/.podium/logs/<role>.log`** (no `.ndjson`) still exists in detached mode
  and is *not* the logger's file. It is the detached spawner's raw
  stdout/stderr capture — the net for stray output that never reached the
  logger at all (a bun panic, a library's own printf). If a line is in `.log`
  but not in `.ndjson`, that is what it means.

`~/.podium` is the default state dir; `$PODIUM_STATE_DIR` moves all of the
above.

Reading them:

```sh
podium logs                      # tail the component logs
podium logs --pretty             # NDJSON rendered for humans
podium logs web-<machine>        # a forwarded client's own file, by origin
podium logs fleet-<machine>      # a raised remote daemon's own file, by machine
podium logs export-crash         # bundle recent crash events for support
```

`podium logs clients` and `podium logs level` are the same verb's reach into a
connected client — see [Raising a client you are not sitting
at](#raising-a-client-you-are-not-sitting-at). `podium logs daemons` and
`podium logs daemon-level` are its reach into a remote machine's daemon — see
[Raising a daemon on a machine you have no shell
on](#raising-a-daemon-on-a-machine-you-have-no-shell-on).

Under systemd `podium logs` points you at `journalctl` instead, which is the
authority there.

## The lint boundary

`console.*` is refused in `apps/` and `packages/` product source. Exempt, by
category:

- **`apps/cli`** — every line it prints is the user's answer. (Its
  non-user-facing diagnostics already go through the logger.)
- **`packages/logger`** — the console sink cannot log through itself.
- **Tests**, carved out by *directory* (`test/`, `tests/`, `__tests__/`,
  `test-support/`, `fixtures/`) as well as by `.test.`/`.spec.` filename, so
  test infrastructure that is not named `.test.ts` is not swept.
- **Build tooling** — `scripts/` and `apps/<x>/scripts/**`.
- **Named files** where console output *is* the product: perf harnesses
  (including `console.table`, which the rule does cover), the terminal
  diagnostics feature, the abduco build step, and the logging module's own
  degrade notices — those last must stay `console`, or a degraded forwarding
  sink reports its own degradation through itself.

Rust is out of scope: the rule reads `.ts`/`.tsx` only, and the desktop crate's
`println!`/`eprintln!` are its own sink's stderr mirror.

Adding an exemption means adding it to `CONSOLE_EXEMPT_FILES` with a positive
reason of the same kind — "console output IS what this file produces", never
"converting it was awkward".

Verify with `bun run lint:boundaries` directly. `bun run lint` chains it, but
biome's own backlog fails that composite first, so the boundary run is the one
that actually tells you about this rule.
