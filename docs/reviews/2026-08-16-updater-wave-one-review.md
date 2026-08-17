# Updater wave-one integration review

**Review date:** 2026-08-16  
**Epic:** POD-2087  
**Integration branch:** `worktree-updater-spec`  
**Reviewed tip:** `e3eb6b55d997d05dea1dc4095d1c2ffa37e2c9f3`

## Verdict

**Changes requested.** The channel/target-refresh slice is structurally sound but its
manual-check rate limit is racy. The daemon-hardening slice has a more serious launch-path
hole: desktop replacement daemons never set the flag on which both new safety guards depend.
The prerelease comparator also accepts a class of malformed SemVer values despite its
fail-closed contract.

The confirmed defects below are filed independently as POD-2137, POD-2138, and POD-2139.

## Confirmed defects

### 1. High — desktop replacement daemons bypass both supervision guards (POD-2137)

**Files:** `apps/desktop/src-tauri/src/main.rs:47-50`, `apps/desktop/src-tauri/src/main.rs:529-531`,
`apps/desktop/src-tauri/src/main.rs:542-577`, `apps/daemon/src/build-report.ts:22-43`,
`apps/daemon/src/build-report.ts:83-87`, `apps/server/src/modules/updates/wave.ts:81-86`

`replacement_daemon_command` does not export `PODIUM_DESKTOP_SUPERVISED=1`. That constructor
is used both for normal desktop `LocalDaemon` mode and when an all-in-one shell retargets after
a server transfer. Consequently `buildReport` omits `supervised`, `deliveryCaps` returns the
ordinary source/git capability set, and neither `machineCanTakeDelivery` nor the daemon's
empty-capability refusal fires.

**Concrete failure:** on Linux, Podium Desktop copies its bundled sidecar to a runnable path
and starts it in daemon mode against a remote server. The daemon reports as an ordinary source
machine with `update.delivery.git`; a convergence wave may select it and mutate the copied
shell-owned daemon instead of leaving it for the desktop update. The same exposure appears
after an all-in-one instance transfers its server role and respawns as a replacement daemon.

The new tests do not reach this boundary. `build-report.test.ts:81-114` injects the environment
flag directly, `wave.test.ts:190-243` constructs `supervised: true` by hand, and
`build-report.integration.test.ts:106-119` hand-builds the handshake payload. Meanwhile the
existing desktop test at `main.rs:967-989` explicitly pins the unsafe real command to have no
supervision flag. The guards themselves are non-vacuous for synthetic inputs, but the affected
production launch paths cannot produce those inputs.

This violates the daemon-hardening plan's first acceptance item and the design's P5/surface
rule that a fleet wave never rewrites a desktop-supervised daemon.

### 2. Medium — concurrent `checkNow` calls bypass the 30-second per-channel limit (POD-2138)

**File:** `apps/server/src/modules/updates/service.ts:265-277`

`checkNow` reads `checks`, decides the cached record is outside the window, and then awaits
`refreshTarget`. The refreshed timestamp is not recorded until that await finishes. There is
no in-flight reservation or promise coalescing, so multiple callers can all pass the same
pre-await check.

**Concrete failure:** more than 30 seconds after the last stable check, a slow release feed
takes five seconds to answer. Two tabs invoke `updates.checkNow` during that interval. Both see
the old timestamp and both resolve `stable`, producing two feed requests inside one 30-second
window. Repeated clicks or more clients multiply the requests.

The tests at `service.test.ts:619-642` cover sequential inside-window and outside-window calls
only, so the literal acceptance claim “no more than one forced refresh per channel per 30 s”
is not established under concurrent callers.

### 3. Medium — malformed SemVer with leading zeroes can trigger self-update (POD-2139)

**Files:** `apps/cli/src/podium-update.ts:76-89`, `apps/cli/src/podium-update.ts:129-165`,
`apps/cli/src/podium-update.test.ts:27-63`

The parser accepts leading zeroes in numeric core and prerelease identifiers, then normalizes
them through `Number()`. SemVer forbids both forms. This conflicts with the slice's explicit
contract that unparseable input on either side fails closed.

**Concrete failure:** with current version `0.1.4-edge.1`, a malformed manifest candidate
`0.1.4-edge.02` parses successfully and compares as newer, so the unattached updater downloads
and swaps instead of rejecting the malformed version. A malformed core such as `00.1.5` is
accepted for the same reason.

The table-driven malformed cases cover missing/extra components and empty identifiers, but no
leading-zero case. The comparator otherwise implements numeric prerelease ordering, release
precedence, text ordering, and ignored build metadata correctly.

## Suggestions and coverage gaps

### Make `channelChecks` absence-tolerant before a client consumes it

**File:** `apps/server/src/modules/updates/trpc.ts:132-138`

The comment calls `channelChecks` additive and absence-tolerant, but the exported response type
makes it required and there is no wire parser/default at this boundary. No client consumes the
field yet, so this is not a current runtime defect. Before Settings uses it, model the old-server
case explicitly (`channelChecks?` or a shared parser/default). Otherwise a newly loaded client
that temporarily reconnects to an older server during rollback can legally receive no field
while its generated type says an array is guaranteed.

### Add one real desktop-command-to-daemon assertion

The hardening tests prove each new component in isolation but miss the ownership signal's source.
One focused test should carry the environment from each desktop-spawned daemon command into the
captured build/capability report. That boundary test would have caught POD-2137 while remaining
hermetic.

## Acceptance audit

### Channel defaults and target refresh (`085021900`)

- **One default channel:** pass. `resolveMachineChannel` at
  `packages/model/src/entities/machine.ts:262-267` is the common resolution function. The old
  `?? 'dev'` / `?? 'stable'` defaults are gone from `UpdatesService.channelOf`, both fleet
  handlers, the fleet projection, and `MachinesService`; remaining literals in these files are
  channel selections/comparisons or compatibility method defaults, not absent-machine-channel
  resolution sites.
- **Injected timer:** pass. `startTargetRefresh` receives the scheduling seam at
  `target-refresh.ts:35-50`; direct `setTimeout`/`clearTimeout` use is isolated in the production
  adapter at `target-refresh.ts:57-62`. Scheduler tests drive captured callbacks and assert the
  initial and 24-hour delays without sleeping.
- **Active-wave skip:** pass at the service/scheduler seam. The scheduler test makes the skip
  predicate return true for one channel, and service tests produce true from an outstanding
  grant, so the guard is demonstrably able to fire.
- **Refresh bookkeeping and stale-failure clearing:** pass. Successful re-check clears the
  absence reason while a failed re-check preserves an already-good target and records a failed
  outcome.
- **Fleet exposure:** pass as an additive server response field, with the forward-compatibility
  suggestion above before its first client consumer.
- **Manual rate limit:** fail under concurrency; see finding 2.

### Daemon update hardening (`74767ec3f`)

- **Supervised build report / empty delivery caps:** fail for desktop replacement-daemon launch
  paths; see finding 1. The behavior passes for callers that actually supply the flag.
- **Server-side wave exclusion:** the predicate and canary/widening tests pass for a persisted
  `supervised: true` report, and the field is optional through the passthrough `PeerBuild` schema
  and optional `MachineWire` field. The production signal-source gap prevents the overall
  acceptance claim from passing.
- **Migration:** pass static audit. `20260814100717_machine-supervised-flag/migration.sql` contains
  only `ALTER TABLE machines ADD supervised integer;`; schema and store changes read old `NULL`
  rows as false. No destructive/rebuild SQL was introduced.
- **Atomic pending marker:** pass static audit and coverage. Bytes go to a same-directory temp
  file, the file is fsynced, rename publishes it atomically, and the directory sync is attempted.
  The torn-write test proves the previous marker remains readable and includes an oracle showing
  the old direct write destroys it.
- **Prerelease-safe comparison:** partial. Ordinary prerelease precedence is correct, but malformed
  leading-zero versions do not fail closed; see finding 3.
- **Frozen contracts:** pass for the new supervised fields. `PeerBuild.supervised` is optional in a
  passthrough schema and `MachineWire.supervised` is optional, so older peers/clients tolerate the
  addition and absent continues to mean false.

## Scope and verification

Reviewed every commit in `main..worktree-updater-spec` at the tip above:

- `081091bf5` — design specification
- `2954bcea5`, `a12ddc21b`, `50bc24113`, `e3eb6b55d` — plans/protocol amendments
- `085021900` — channel defaults and target refresh
- `74767ec3f` — daemon update hardening

The durable operations framework was not present on the integration branch at this reviewed tip.

This was a static, line-by-line and history/diff review. Per POD-2111 and the review brief, no
build was started on the 98%-full disk. In particular, the plan-required
`scripts/verify-headless-update.sh` was not independently re-run because it builds or reuses the
headless bundle; this is recorded as an unexecuted verification item, not as a defect. The known
base `apps/web` typecheck failure (POD-2109) is excluded from findings.
