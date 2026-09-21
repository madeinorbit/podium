# VERIFY-POD-4470 — 1.5 Headless hosts into driver families

Base: `origin/integrate/4414-single-harness-transport` @ `c44b663de` (POD-4469 tip).
Branch: `issue/4470-1-5-headless-hosts-into-families` (11 WIP commits, all with
`Podium-Issue: POD-4470` trailers).

## DONE WHEN 1 — listed daemon files gone; runtime/ literals; lint leak drop

Deleted (11 files):
`apps/daemon/src/runtime/{codex-app-server,codex-driver,grok-acp-server,grok-driver,opencode-server,opencode-driver,claude-sdk-driver}.ts`,
`apps/daemon/src/claude-sdk-{client,host,protocol}.ts`, `apps/daemon/src/pi-stream.ts`.

```
$ ls apps/daemon/src/runtime/ | grep -E "codex-app-server|opencode-server|grok-acp-server|codex-driver|grok-driver|opencode-driver|claude-sdk-driver|queue-abandonment"; ls apps/daemon/src/ | grep -E "claude-sdk-client|claude-sdk-host|claude-sdk-protocol|pi-stream"
(no output — all gone)
```

Moved-out parts (files stay, harness paths extracted):
- `headless-drivers.ts`: codex `exec --json` turn → `families/codex/exec-turn.ts`;
  cursor `create-chat` alloc → `cursor/chat.ts` (invocation + id grammar);
  claude-sdk executable resolution → `families/claude-sdk/exec.ts`.
- `durable-headless.ts`: cursor `create-chat` → `cursor/chat.ts`;
  Claude command resolution → `families/claude-sdk/exec.ts` (`buildClaudeDurableTurn`).
- `runtime/machine-runtime.ts`: driver union
  (`'opencode'|'opencode2'|'codex'|'grok'`, journalled table, per-family
  journal reads) → generic loop over `ServerFamilyRuntime`
  (`families/server-family.ts`); `JournalledServerProcess.driver` is now `DriverId`.
- `runtime/queue-abandonment.ts`: `reportQueueAbandonment` →
  `families/queue-report.ts` (shared, family name as a value). File deleted.

```
$ rg -n "['\"\`](claude-code|codex|grok|opencode|cursor)['\"\`]" apps/daemon/src/runtime --glob '!*.test.*'
apps/daemon/src/runtime/opencode-attach.ts:192,193,194,1015  (P2 POD-4434 — explicitly excluded from this issue)
apps/daemon/src/runtime/terminal-instrumentation.ts:98,109,114 (+1)  (3.2 hooks lane)
```
`runtime/host.ts`: zero literals (wiring only). `machine-runtime.ts`,
`registry.ts`, `server-reap.ts`, `headless-driver.ts`, `host-runtime.ts`,
`durable-headless.ts`, `headless-drivers.ts`: zero literals.
Remaining `runtime/` literals live only in files owned by other lanes
(all still allowlisted): `opencode-attach.ts` (4, P2), `terminal-instrumentation.ts` (4, 3.2).

```
$ bun run lint:boundaries 2>&1 | grep -E "allowlisted|NEW harness|is dead|lower the count"
harness vendor boundary — 517 allowlisted literal(s)   (baseline: 587 → drop of 70)
(no NEW / dead / lower lines — clean)
```
14 dead allowlist entries removed (the 7 runtime files + queue-abandonment +
`durable-headless`, `headless-drivers`, `host-runtime`, `machine-runtime`,
`registry`, `server-reap`); `control/session.ts` lowered 7→5.
`scripts/harness-boundary-allowlist.ts` is 1.1's file; the edits are the
ratchet's own mechanical demands (dead entries fail the gate).

## DONE WHEN 2 — conformance green; §4.8 green, shown red first

```
$ bun run test:file -- <4 conformance suites>
Test Files  4 passed (4) / Tests 276 passed (276)   (baseline: 276 — unchanged)
$ scripts/audit-browser-reach.test.ts: 8 passed (8)  (browser.ts stayed host-free)
```

§4.8 failure tests (9 new, per family):
- codex launch, engine up + listener silent → `EngineBindUnrecoverable`
  (during `launch`, address on the error), kill NOT called, journal untouched.
- opencode launch, engine up + health silent → same shape (address + secret
  in fields, secret absent from the message).
- codex/opencode/grok session `adoptFromJournal`: journalled + driver
  failure → REJECTS with cause (was: swallowed to `undefined`); no entry →
  still `undefined`. Grok keeps one documented exception: a protocol ANSWER
  (`GrokAcpRpcError`) stays retryable-`undefined`.
- machine `adoptJournalled` with a throwing family → `{found, reason}`
  (flow coverage; the catch predates this issue).

Red runs (all on stashed pre-change code):
- codex launch test vs old engine-host: FAIL (old code SIGKILLs + throws
  generic `Error`).
- opencode launch test vs old engine-host: FAIL (old code kills + generic error).
- codex/opencode/grok session propagation tests vs old sessions:
  `AssertionError: promise resolved "undefined" instead of rejecting` (×3).
- During the work the suite also caught one REAL regression I introduced
  (blanket propagation broke grok's retryable-load test) — fixed via the
  `GrokAcpRpcError` transient rule above, green since.

What 1.5 deliberately does NOT own (filed as P2 sub-issue POD-4490 under
epic POD-4462, blocked by POD-4470 + POD-4434): DaemonSession invalidating
pending turns on `EngineBindUnrecoverable` and journalling kept engines.
The §4.8 sequence owner (2.1) does not exist yet; 1.5 delivers the typed
signal, the kept process/journal, and the reason propagation it will read.

Deliberate non-change, recorded: codex launch bind failure keeps (not
kills) the engine even though no thread id exists to adopt it by — killing
would contradict §4.8 step 4 ("kept for an operator decision, never
silently orphaned"); the address rides the error and a warn log names the
label for the operator/P2 reaper.

## DONE WHEN 3 — typecheck by count

```
$ bun run typecheck
Tasks: 23 successful, 23 total   (successful + failed == total; @podium/mobile green)
$ bun run test   → LEAN GATE PASSED (4 files, 135 tests; "lean gate green")
```

## Design notes for the reviewer

- Port inversion (harness cannot import `@podium/process` or daemon
  modules): `EngineSupervisor`/`EngineAttachment` (`families/engine-supervision.ts`)
  implemented once in `runtime/host.ts`; journals, env composition
  (`composeEngineEnv`), version gates (`runtime/version-probe.ts`, same
  exported names), socket root, WS dial likewise daemon-side.
- Facts, not literals: `families/<family>/engine-facts.ts` read argv stems,
  executable names, strip lists, scope tokens (`clientTerminal.labelToken`)
  and journal namespaces off adapter sections; opencode serves two speakers
  (`opencodeFlavor()`/`opencode2Flavor()`, the latter from
  `serverAlternatives[0]`) through one engine host — the genericity test.
- Daemon deps moved with files: `@anthropic-ai/claude-agent-sdk`
  daemon→harness (the only SDK importer moved), `ws` added to harness
  devDeps (family transport tests). `bun.lock` also drops 1.4's stale
  dissolved-package entries on reinstall (no such packages on disk).
- Pre-existing reds, unchanged by this issue (shown red on base via stash):
  `claude-sdk-isolation.test.ts` "still sees what an ALLOWED module loader
  loads" (reads `packages/pty/src/backends/node-pty-backend.ts`, deleted in
  base `61b8e2ef0`); `opencode-attach.test.ts` opencode2-cmd (this machine
  has `/home/mgw/.opencode/bin/opencode2` installed); `daemon.test.ts`
  integration lane (multi-bridge/abduco suites fail identically at base in
  this environment; two representatives compared base-vs-branch).
- Two pre-existing reds this issue FIXED as migration fallout (now green):
  the opencode-attach adopt tests (never provided process ownership; now
  declare supervision stubs) and the inventory barrel mock (spread actual).
- Session binding note: filing POD-4490 via `attach --subissue
  --confirm-rehome` re-homed this session onto POD-4490 (tooling limitation,
  coordinator notified — landing is by branch, unaffected). All commits
  trailer `Podium-Issue: POD-4470`.
