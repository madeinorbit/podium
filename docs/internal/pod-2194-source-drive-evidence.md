# POD-2194 — source-drive acceptance subset: evidence

Drive of `docs/agents/updater-acceptance.md` cadence 3 + 4 (source checkout / git delivery),
restricted to what needs no bundle or web release build.

- **Candidate commit:** `c4105f010` (integration tip `worktree-updater-spec`), old commit `ee135e38d`
- **Installation kind:** source checkout, all-in-one (`scripts/cli.ts … all`), Linux x86_64
- **Artifact delivery kind offered:** `git` only — the host daemon advertised
  `deliveryCaps: ["update.delivery.git"]`
- **Date:** 2026-08-16
- **Host resources throughout:** ~3 GB memory available of 23 (swap 22/23 used), 3.3–3.6 GB disk free at 99 %

## Safety

Nothing touched the operator's default instance or state directory.

- Disposable named instance `pod2194`, state root `/home/mgw/src/other/podium-pod2194-state/state`,
  ports 18901 / 18902 / 18903, `PODIUM_AGENT_HOME` and `PODIUM_WEB_DIR` of its own.
- Disposable checkout: a git worktree at `/home/mgw/src/other/podium-pod2194`.
- Disposable clone for the delivery drive: `git clone --local --shared` at
  `/home/mgw/src/other/podium-2194-gitdrive`, so its `git fetch --all --prune` reached the local
  repository and never the operator's remote-tracking refs.
- Verified empirically rather than by reading the constant: the published target named
  `"repo": "/home/mgw/src/other/podium-pod2194/"` — the disposable checkout, not the live one.
  `DEVELOPMENT_SOURCE_ROOT` is derived from the running module's own location
  (`new URL('../../../../..', import.meta.url)`), so a server launched from a disposable checkout
  can only ever target that checkout.

## The premise this issue was given is false

The brief said the source-checkout drive "uses GIT delivery and therefore needs no headless bundle
or web release build". Against this code it does need one.

`planUpdateOperation` plans a `prepare` (pack) step whenever `needsDevelopmentBundle(target)`, and
that predicate tests only `target.artifacts.headless === undefined`. `devIdentityTarget` publishes
exactly that shape — no `headless`, `git` as the sole `headlessAlternatives` entry — so **every**
source-checkout update plans a pack. `machinesRunner` then refuses to grant while
`canGrantDevelopmentFleet(published)` is false, holding at *"Waiting for the update package."*
Git is an alternative offered **alongside** a packed bundle, never a substitute for it.

Observed live: the plan for the real target was `[prepare, machines, web]`, and the only machine in
the fleet advertised `update.delivery.git` alone — so it was waiting on a package it could never
consume. Filed as `POD-2195`.

A source server also runs a web-dist build at **boot**, before anybody clicks anything. It showed up
because the build command was stubbed and the stub logged it.

Consequence: claims (1) end-to-end, (3) and (4) below are gated behind a pack this box cannot afford
(main's `dist-bun` is 325 MB, `apps/web/dist` 36 MB, against 3.3 GB disk and ~3 GB memory) and the
brief forbids. They stay with POD-2157 — and POD-2157's cost is higher than the epic assumed,
because the *source* drive needs the same resources as the bundle drive.

## How the build-free drive was made possible, stated plainly

`BUN_BIN` (read only by `devBuildCommand` in `build-scope.ts`, a documented env seam — no source was
modified) was pointed at a stub: one variant sleeps, one exits 1. That holds a `prepare` step
`running` at zero cost, or fails it instantly. **No compiler ran and no artifact was produced.**

What this proves is the operation engine's behaviour across a real process boundary — which is
exactly what the regimen says the drills exist for ("the unit suites can only prove the decision,
never that the wiring survives a real process boundary"). It proves nothing about the compiler, and
no claim below depends on one.

## Results

| # | Claim | Verdict |
|---|---|---|
| 1 | Adoption across a coordinating-server restart | **PASS** (the adoption half; convergence half not reached) |
| 2 | Single-flight | **PASS**, both arms |
| 3 | Stalled download ages into a visible stall | **NOT REACHED** |
| 4 | Straggler reconciliation | **NOT REACHED** |
| 5 | Panel screenshots | **NOT REACHED** |
| — | Regimen step 1: HEAD moves, server PID does not | **PASS** |
| — | Negative: dirty checkout refuses, preserving local work | **PASS**, at two layers |
| — | Git delivery itself, against a real repository | **PASS**, four arms |

### 1. Adoption across a coordinating-server restart — PASS

With `prepare` running, the coordinator (pid 1148321) was SIGTERMed and a successor started
(pid 1150824).

```
BEFORE RESTART: op op_12af90b2-2e91-4637-ab73-0f4759aa55bd
  prepare: state running, detail "Building the update package… 30s",
           attempts 1, startedAt 1786903110214, lastProgressAt 1786903140232
AFTER RESTART:  op op_12af90b2-2e91-4637-ab73-0f4759aa55bd  createdAt 1786903110210 (unchanged)
  prepare  running  'Building the update package…'  attempts 2
  machines pending
  web      pending
operations on record: 1
```

- Same operation id, same `createdAt` — the same durable operation, not a new one.
- Step positions and order unchanged.
- The adopted step was **not** failed for the dead process's silence: `startedAt` is preserved from
  the original while `lastProgressAt` is fresh and the elapsed label restarts at 15 s. That is the
  documented rule — a step is judged on how long *it* has been quiet.
- `attempts` 1 → 2: the successor re-entered the runner rather than leaving the group wedged.
- Exactly one operation on record, so no second dialog.

Not covered: *"a stall the operation already recorded SURVIVES the restart"*. No stall could be
recorded (see 3), so that arm is untested. Also untested: `operation-adoption-failed` for an
unregistered kind.

### 2. Single-flight — PASS, both arms

Two `updates.start` calls issued concurrently, 7 ms apart, inside the async planning window:

```
A: operationId op_12af90b2-…  alreadyRunning false
B: operationId op_12af90b2-…  alreadyRunning true      ← same id
exclusionGroup "lifecycle" on both;  operations on record: 1
```

Refused-as-join, not queued, not merged, not started twice. Then the release arm: `operations.cancel`
moved it to `canceled`, `operations.active` went null, and the next `updates.start` returned a fresh
id `op_c576c2b5-…` — the group frees on the terminal transition.

### Regimen step 1 — PASS

`git checkout --detach c4105f0` in the running server's own checkout; server pid 1148321 before and
1148321 after. `/version` then published `dev+c4105f0` while `appVersion` stayed `dev+ee135e3`, and
the fleet read `targetVersion dev+c4105f0, behind 1` — the panel's *available* state at the data
layer. No HEAD watcher fired (there is no redeploy unit for this instance).

Worth recording: after the restart the successor reported `appVersion dev+c4105f0`. On a source
install the restart **is** the server update — the coordinator arrives at the target by being
restarted onto the moved checkout.

### Negative: dirty checkout — PASS, at two layers

Two uncommitted changes (`M README.md`, `?? dirty-local-work.txt`):

- **Publisher layer:** no target is published at all. `updates.fleet` reported
  `preparation.failureDetail: "The source checkout has 2 uncommitted changes and no longer matches
  HEAD (ee135e3). Commit or stash them to publish dev+ee135e3."`, and `updates.start` refused with
  `PRECONDITION_FAILED`.
- **Delivery layer:** `convergeViaGit` returned `{ok:false, reason:"dirty-working-tree"}` after
  `git-status` alone.

Both local files were byte-identical afterwards (md5 unchanged) and `git status` was unchanged. No
`reset`, `clean`, `--hard` or `--force`.

Blemish, filed as `POD-2197`: the sentence that reaches the caller is the bland *"No update target is
configured."*; the useful one lives only in `preparation.failureDetail`.

### Git delivery itself — PASS, four arms

The shipped `convergeViaGit` driven against a real repository with a real `spawn` runner (no injected
fakes), on the `--shared` clone:

```
ARM 1 dirty        → {"ok":false,"reason":"dirty-working-tree"}   phases ["git-status"]
                     HEAD unmoved, local file intact
ARM 2 clean        → {"ok":true} in 210 ms                        phases ["git-status","git-fetch","git-checkout"]
                     HEAD ee135e3 → c4105f0
ARM 3 already at   → {"ok":true}                                  phases ["git-status"]  (no fetch, no checkout)
ARM 4 "--upload-pack=evil" → {"ok":false,"reason":"invalid-git-reference"}  phases []  (no git process ran)
```

Arm 3 is the documented short-circuit that stops a same-SHA `--detach` from abandoning the branch.
Arm 4 proves the argument-injection guard live.

This is the convergence half of claim 1 — proven as a mechanism against a real tree, but **not**
proven as reached through a real grant from an operation, which needs the pack.

## What was not reached, and why

- **(3) Stalled download.** Requires a granted machine reporting download progress and then going
  quiet. No machine can be granted without the pack. The only step that would run build-free is
  `prepare`, and its watcher heartbeats every 15 s, so it never accrues silence. The engine's
  timer-armed deadline is therefore untested by this drive.
- **(4) Straggler reconciliation.** Needs a grantable target for the reconnecting machine — the same
  block. None of its four arms (converges to current target, paused while an exclusive operation is
  active, no hot-loop after `rejected`/`stuck`, publishing alone installs nothing) were driven.
- **(5) Panel screenshots.** The panel needs `apps/web/dist` built from this integration tip; the
  dist in the main checkout predates the epic's `UpdatePanel`, so it would show the old panel. A web
  build is a build. Every panel state above was captured at the API layer instead.
- **Deliberately skipped per the brief:** anything needing a bundle or desktop build, the
  stable-channel feed drive, and `verify-update.sh`. Those stay with POD-2157.

## Issues filed (each with a `discovered-from` edge on POD-2087)

- `POD-2195` — git delivery still requires a pack
- `POD-2196` — dev channel unreachable from the CLI (`podium channel dev` is refused; a source
  instance defaults to `stable`, where the dev target never applies, so the drive needed
  `PODIUM_UPDATE_CHANNEL=dev`)
- `POD-2197` — dirty-checkout refusal loses its sentence
