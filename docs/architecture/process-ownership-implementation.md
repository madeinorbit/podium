# Process ownership: implementation plan

Status: implementation plan for `process-ownership.md` (POD-2694), to be
executed under POD-2691. Written to discharge the spec's §7 obligations: every
contract the spec requires pinned "in writing, before code" is pinned here.
Phases are ordered so each lands something independently shippable and gated;
nothing after phase 0 starts until phase 0's measurements exist.

## Call-site inventory (the ground truth this plan changes)

Every place a durable or agent-adjacent process is spawned today, each owning
its own `spawn` and `stdio`:

| # | Site | Today | Becomes |
| --- | --- | --- | --- |
| 1 | `packages/pty/src/abduco.ts` — `execCreate` + `systemdScopeArgv` argv, scoped abduco create | `systemd-run --scope -- abduco -n <label> …`, double-forking master | terminal workload: transient *service*, abduco foreground (phase 3) |
| 2 | `apps/daemon/src/runtime/opencode-server.ts:509` | scoped `opencode serve`, journal + credentialed probe | durable service workload, adopt = rebind (phase 4) |
| 3 | `apps/daemon/src/runtime/codex-app-server.ts:531` | scoped `codex app-server --listen unix://…`, stdin-EOF lifetime | non-durable daemon child (phase 5) |
| 4 | `apps/daemon/src/runtime/grok-acp-server.ts:245` | scoped `grok agent stdio` | non-durable daemon child (phase 5) |
| 5 | `apps/daemon/src/runtime/opencode-attach.ts` client spawn (`attachLabel(sessionId, kind)`) | scoped abduco client TUI | terminal-workload path, same as #1, role `viewer` (phase 3) |
| 6 | `apps/server/src/modules/updates/build-scope.ts` | scoped build with its own reclaim | build workload via the same seam, role `build` (phase 6) |
| 7 | Unscoped fallbacks in each of the above (`canScopeMaster()` false, macOS) | plain `child_process.spawn`, no record | supervisor fallback backends with declared capabilities (phases 3, 7) |

All seven converge on one API (phase 2). After phase 6 a direct
`child_process.spawn` of an agent-side process outside the seam is a review
error; a lint rule (`no-restricted-imports`/custom) enforces it in the daemon
and server packages.

## Phase 0 — the two gating spikes

Nothing else merges until both spike reports exist as committed docs under
`docs/measurements/`.

**S1 — Linux transient services.** Script (checked in, rerunnable):

1. `systemd-run --user --unit=podium-spike-<rand>.service --slice=podium-sessions.slice --collect --property=Type=exec --property=CPUWeight=50 <payload>` where the payload spawns a grandchild that `setsid`s and scrubs env.
2. Kill the launching process (stand-in for the daemon). Verify the unit
   survives, `systemctl --user show -p InvocationID,ControlGroup,MainPID`
   answers, and the grandchild is still inside the cgroup.
3. `systemctl --user stop` the unit; verify the cgroup is empty (read
   `cgroup.procs` until absent) — the `verified-empty` outcome.
4. Repeat across `systemctl --user daemon-reexec`.
5. Measure: does `systemd-run` (CLI) suffice for all needed properties
   (`Type=exec`, slice, budgets, `--setenv`), or is the D-Bus
   `StartTransientUnit` API required (it is if any property proves
   CLI-unreachable — record which).

*Exit gate:* enumeration, survival, verified-empty, and re-exec behavior all
demonstrated, and the CLI-vs-D-Bus decision recorded with evidence.

**S2 — macOS launchd.** From the native app's sanctioned execution model
(SMAppService/`launchctl bootstrap gui/<uid>`):

1. Bootstrap a uniquely labelled job running a foreground payload that spawns
   (a) a plain child, (b) a `setsid` child, (c) an env-scrubbed double-forker.
2. Kill the app/daemon stand-in; verify the job survives and
   `launchctl print gui/<uid>/<label>` enumerates it.
3. `launchctl bootout` the job; measure exactly which of (a)–(c) die
   (`AbandonProcessGroup` both ways).
4. Exercise the approval flow once (first-run Login Items prompt) and record
   the UX cost.

*Exit gate:* a written per-family macOS capability table (what launchd can
enumerate and terminate), signed into `process-ownership.md`'s §6 by editing
the spec — the spec's macOS promises are whatever S2 proved, no more.

## Phase 1 — instance identity

- `packages/runtime/src/instance.ts`: extend `InstanceStateIdentity` to
  `{ version: 2, instanceId, instanceUuid }`. Read path accepts version 1 and
  mints the UUID in place on first daemon boot (write-back with the same
  `wx`/race handling `ensureInstanceStateIdentity` already has). `instanceId`
  keeps every existing consumer (paths, ports, services, slices) untouched.
- New `instanceUuidShort()` — first 8 hex chars — for unit names; full UUID in
  job metadata. Collision within one machine is checked at guard time (below)
  and refuses with a rekey hint rather than probabilistically ignored.
- **In-root lock:** daemon holds `<stateDir>/daemon.lock` (flock) for its
  lifetime; second daemon on the same root refuses with the holder's pid.
- **Per-machine singleton guard:** `$XDG_RUNTIME_DIR/podium/instances/<uuid>`
  (macOS: `~/Library/Caches/podium/instances/<uuid>`), flock held for the
  daemon's lifetime, content = state-root path. Held ⇒ same UUID already live
  ⇒ refuse: "state root copied? run `podium instance rekey`".
- **`podium instance rekey`:** mints a fresh UUID into a copied root;
  documents that old jobs stay owned by the old UUID and surface as foreign.
- Tests: version-1 upgrade, copied-root refusal, rekey, concurrent mint race.

*Ships alone:* pure additive identity; nothing consumes it yet.

## Phase 2 — the `WorkloadSupervisor` seam

Location: `packages/agent-runtime/src/supervise/` (where the architecture
proposal's §8 places supervision), with the pty/cgroup helpers it needs
imported from `@podium/pty`.

```ts
interface WorkloadSpec {
  workloadId: WorkloadId              // uuidv7, minted by caller, never reused
  role: 'agent' | 'viewer' | 'shell' | 'build'
  family: 'opencode' | 'codex' | 'grok' | 'terminal'
  sessionIds: SessionId[]             // product bindings at admission
  argv: string[]
  env: Record<string, string>         // stamps added by the seam, not callers
  durable: boolean                    // from the driver's declaration
  budget: ScopeBudget                 // resolved as today (scope.ts)
}
interface WorkloadHandle {
  workloadId: WorkloadId
  boundary:                            // what actually supervises it
    | { kind: 'systemd'; unit: string; invocationId: string }
    | { kind: 'launchd'; label: string }
    | { kind: 'abduco-registry'; label: string; socketDir: string }
    | { kind: 'daemon-child'; pid: number }
  identity: { pid: number; startTime: string; bootId: string } // triple, always
}
type StopOutcome =
  | { kind: 'verified-empty' }
  | { kind: 'job-removed' }
  | { kind: 'incomplete'; residue: CensusRecord }   // record retained, never deleted
  | { kind: 'refused'; reason: string }
interface WorkloadSupervisor {
  start(spec: WorkloadSpec): Promise<WorkloadHandle>
  list(): Promise<CensusRecord[]>          // all Podium UUIDs, ours flagged
  stop(id: WorkloadId, mode: 'graceful' | 'force'): Promise<StopOutcome>
  watch(cb: (e: WorkloadEvent) => void): () => void
  capabilities(): BackendCapabilities      // per family: durable? contained? verified-empty?
}
```

`CensusRecord` carries the spec's §4 dimensions verbatim (owner UUID +
attribution confidence, binding state incl. `ambiguous`, lifecycle observation
incl. `reap-in-progress` and lock observation for fallback lanes, coverage).
Events: `workload-exited`, `stop-verified`, `oom-kill` (Linux), `pressure`,
`orphan-discovered`, `foreign-observed`, `adoption-result` — each tagged with
its producer (`unit-signal` | `kqueue` | `census-delta`) and workloadId.

Environment stamps are applied inside `start` only: `PODIUM_INSTANCE`,
`PODIUM_INSTANCE_UUID`, `PODIUM_STATE_DIR`, `PODIUM_SESSION_ID`,
`PODIUM_WORKLOAD`. Callers cannot forget them.

*Ships alone:* interface + a `daemon-child` backend that simply wraps today's
plain spawn (no behavior change), so call sites can migrate one by one from
phase 3 onward.

## Phase 3 — Linux backend + abduco foreground

- **Backend `systemd`:** per S1's decision, `systemd-run` CLI or D-Bus.
  Unit `podium-<uuid8>-<workloadId>.service`, `--slice` and budget properties
  exactly as `systemdScopeArgv`/`scopeBudgetProperties` build them today
  (reuse those functions; they become internal to the backend). Readiness
  stays driver-owned (opencode health loop unchanged). `list()` =
  `list-units 'podium-<uuid8>-*'` then **exact-match** each candidate against
  computed names — the `ProcessIdentity.key` discipline, now against
  UUID-qualified names. `stop()` = `systemctl stop` + poll `cgroup.procs`
  empty (helpers exist in `packages/pty/src/cgroup.ts`) → `verified-empty`.
  Identity triple read at admission from `MainPID` + `/proc/<pid>/stat`
  start-time + `/proc/sys/kernel/random/boot_id`.
- **abduco foreground:** add a flag to the vendored `abduco.c` (the double
  fork in `abduco.c:393-513`) that keeps the master in the foreground as the
  service's main process; socket creation, label semantics, attach, and the
  detach-key remap are untouched. The abduco *client* path (attach) is
  unchanged. Characterization tests: create-foreground + attach + detach +
  reattach + terminated-socket reap, against the real binary.
- **abduco-registry fallback backend** (no usable user manager): today's
  scoped-less abduco spawn, plus the spec's fallback-lane disciplines — the
  inherited held-lock witness (explicit stdio slot, non-CLOEXEC, parent-close
  after spawn, per-incarnation retention probe recorded in the handle) and
  the reap-claim protocol (`O_EXCL` claim file beside the socket, owner +
  phase + deadline). `canScopeMaster()` remains the selector.
- **Retire per-name squat reclaim on the new path:** fresh per-incarnation
  unit names make `reclaimStaleScope`'s "unit already exists" class
  impossible; the function stays only for the legacy import (phase 8).
- **Memory attribution:** `attributeMemory`'s cmdline-substring contract
  (documented in `opencode-attach.ts`) is replaced for supervised workloads
  by cgroup reads keyed off the handle's unit; the `/proc` walk remains for
  fallback lanes and strays. `scope-monitor.ts` consumes handles instead of
  deriving names from labels.

*Exit gate:* terminal + viewer families (call sites 1, 5) run under the new
backend behind a daemon flag; kill/reattach/redeploy e2e green on Linux.

## Phase 4 — opencode as the durable server workload

Call site 2 migrates. Journal keeps credentials/epochs (rebind state);
`process` claims inside it are replaced by the `WorkloadHandle`. Adoption:
`list()` → exact unit match for the session's recorded workloadId →
credentialed `probeHealth` → CAS the binding row to the adopted handle;
failures abandon to a fresh spawn exactly as `opencode-server.ts:595-607`
does today. `server-reap.ts`'s opencode arm re-targets handles.

## Phase 5 — codex and grok become non-durable

Call sites 3, 4. Remove the scoped spawn; spawn as daemon children through
the seam (`durable: false`, `daemon-child` boundary — on Linux they sit in
the daemon's own service cgroup and die with it; that is the design, not a
regression). Daemon shutdown runs each driver's existing graceful stop
(codex stdin-EOF + bounded `exited()`; grok `terminate()`) before exit.
Adoption code for both families is deleted — `adoptFromJournal` for
codex/grok becomes "resume from rollout / named session", which is what it
already effectively did. The `reclaimIfLast` shared-unit care in
`codex-app-server.ts` is deleted with the shared units themselves.
Product-visible change to document in release notes: a daemon redeploy ends
in-flight codex/grok turns (it already severed their transports; now it is
honest), and drains should precede deploys where that matters.

## Phase 6 — desired state, reconciler, hygiene

- **Store additions** (daemon `binding-store` + server rows as appropriate):
  `workloadId` on session bindings; `stop_intents` table
  `{ workloadId, state: pending|executing|verified, firstSignalAt,
  verifiedAt, outcome }` — fsynced `pending` before the first signal,
  retained as tombstones; shared-workload reference counts.
- **Reconciler** (daemon): replaces the sweep half of `server-reap.ts`.
  Runs at boot, every 15 min, after every stop, and on `watch()` events.
  Implements the spec's §5 rules exactly: (1) execute recorded intents by
  state machine; (2) own-UUID job with no active binding at a **complete
  snapshot epoch with completion watermark**, past the **persisted
  first-observed grace** (stored in job metadata /
  `list()`-side sidecar); (3) own-UUID stamped stray of a *declared
  non-durable* family matching no live job — triple-verified, then killed;
  (4) viewer warm-park reclaim (moves from `opencode-attach`'s pressure
  hook into the reconciler, same signal). Everything else → census facts to
  the server surface.
- **Sync watermark:** the daemon records the epoch of its last complete
  session-table snapshot from the server; rule 2 arms only when
  `epoch.complete === true`. Partial/delta updates advance data, not the
  watermark.
- **Break-glass:** `podium workload reap --uuid <owner> --workload <id>`
  (operator-only, distinct result type, warns when the owner instance's
  singleton guard is currently held — i.e. the owner is live).

*Exit gate:* the measured incident replayed as a fixture — 15 synthetic
orphans across three instance UUIDs, control plane down — and the daemon
clears exactly its own twelve, reports the foreign three, touches nothing
else. This fixture is the acceptance test for the whole design.

## Phase 7 — macOS backend

Shaped entirely by S2's table: launchd jobs per incarnation for families the
spike proved; `durable:false` for the rest. Census sources as the spec names
them (`kern.boottime`, `proc_pidinfo`/`PROC_PIDTBSDINFO`, `KERN_PROCARGS2`,
`libproc`, defined refusal state). Terminal masters: pid from the abduco
socket protocol, triple-captured, revalidated immediately before every
signal. Stop outcomes cap at `job-removed`/`verified-stamped-set` per
capabilities; `incomplete` retains residue records.

## Phase 8 — migration, coexistence, rollout

- **Ordering:** phases land behind a per-family daemon flag; old and new
  spawn paths coexist per family until its flag flips. A session spawned old
  stays old until its next respawn — no in-place conversion.
- **Legacy import:** one-time `podium workload import-legacy` — enumerates
  `podium-*` scopes matching today's exact label conventions
  (`durableSessionLabel`, `opencodeScopeLabel`, `codexScopeLabel`,
  `grokAcpProcessKey`, attach infixes — computed-and-compared, never
  parsed), attributes them via env stamps where present, prints the ledger
  of live/orphan/unattributable, and reaps only on explicit per-line
  confirmation. Documented as the operator's backlog-clearing pass; never
  runs automatically.
- **Rollback:** flags revert per family; the legacy path is deleted only
  after two releases with all flags on.
- **Version skew:** unit names are versioned by convention
  (`podium-<uuid8>-…`); an older daemon ignores them (fails its exact-match
  against legacy names) and never reaps them — verified by test.

## Phase 9 — test matrix

- Unit: name computation/exact-match (property-based against near-miss
  names), identity-triple verify, intent state machine, watermark arming,
  grace persistence across restart, claim expiry.
- Race acceptance (from both designs' lists, union): admission vs daemon
  crash; stop-intent retry vs session resume; adopt vs fresh-spawn CAS;
  copied-root rekey vs boot; manager `daemon-reexec` mid-workload;
  fallback-registry publication vs sweep; two concurrent sweepers vs one
  claim; kill vs reattach (terminals).
- e2e per platform: redeploy-survival (opencode, terminal), redeploy-ends
  (codex, grok) with successful resume, incident-replay fixture (phase 6
  gate), no-systemd container run (fallback lane).
- Every new guard mutation-checked: each hygiene rule gets a fixture that
  *produces the thing it guards against* and fails when the guard is
  deleted.

## Sub-issue decomposition for POD-2691

One sub-issue per phase (0–9), each independently mergeable behind its flag;
phase 0 is two parallel sub-issues (S1, S2); phases 4 and 5 can run in
parallel after 3; phase 7 depends only on 2 + S2. The incident-replay
fixture (phase 6's gate) is the definition of done for the epic-level
promise.
