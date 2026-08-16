# POD-2200 — acceptance drills for an all-git fleet: evidence

Drive of the claims POD-2194 could not reach, now that POD-2198 plans the pack per delivery
capability. POD-2194's own results (adoption across a coordinating-server restart,
single-flight, the dirty-checkout refusal, git delivery's four arms) are not repeated here.

- **Candidate:** integration tip `b64716255`, plus disposable drill commits on this branch
- **Installation kind:** source checkout, Linux x86_64, split server + daemon processes
- **Artifact delivery offered:** `git` only — the host daemon advertised
  `deliveryCaps: ["update.delivery.git"]` throughout
- **Date:** 2026-08-16
- **Host resources throughout:** ~2 GB memory available of 23, ~3.5 GB disk free at 99 %

## Safety

Nothing touched the operator's default instance, state directory or checkout.

- Disposable named instance `pod2200`, state root `/home/mgw/src/other/podium-pod2200-state`,
  ports 18911 / 18912 / 18913, its own `PODIUM_AGENT_HOME` and `PODIUM_WEB_DIR`.
- Disposable checkout: `git clone --local --shared` at `/home/mgw/src/other/podium-pod2200`,
  so its `git fetch` reaches the local repository and never the operator's remote.
- Verified empirically rather than by reading a constant: the published target named
  `"repo": "/home/mgw/src/other/podium-pod2200/"` — the disposable checkout.
- `node_modules` was hardlink-copied (`cp -al`, 3.6 s) from a sibling worktree whose
  `bun.lock` blob is identical. No install, no measurable disk cost.

## No compiler ran

`BUN_BIN` — the documented env seam read by `devBuildCommand`, no source modified — pointed
at a stub that appends its argv to a log and exits 0. Across the whole drive that log
contains only the two boot-time invocations each server start makes
(`run --filter @podium/web build:dist`, `run --filter @podium/mobile build:web`). **No pack
was ever attempted**, by any operation, which is itself part of the evidence below.

The served website was stamped by hand at each target commit (`podium-build.json` with
`sourceSha`, in `PODIUM_WEB_DIR`) so the website was already current and no `web` step was
planned. That is a state of the world, not a code change: `planUpdateOperation` plans `web`
only when `servedWebDigest !== target.artifacts.web.digest`.

Two other drill instruments, both outside the product:

- a `git` shim first on the **daemon's** PATH that hangs on
  `--untracked-files=all` (the token only `convergeViaGit`'s status call passes) when an arm
  file is present, and is the real git otherwise. Its log is an exact **grant counter**:
  one line per convergence attempt that reached the machine.
- a one-shot `PODIUM_APP_VERSION` pin on the daemon, so a machine can report a version
  BEHIND the checkout it shares with the server. Without it a single-checkout source
  instance can never have a machine that is behind and connected at the same time.

## Premise: an all-git fleet plans no pack — CONFIRMED, live

`updates.start` against a fleet whose one machine advertised `update.delivery.git` alone,
with the checkout moved from `b647162` to `68fc342`:

```
opId op_81b9d4a6-…  alreadyRunning false  state running
STEPS: [(machines, pending), (server, pending)]
deferred: []   awaiting: []
```

**No `prepare` step.** No pack, no web build. The premise everything below depends on holds
against this code.

(The `server` step was planned because `INVOCATION_ID` was inherited from the launching
session, so the server believed it could ask a supervisor to restart it. It was unset for
every later phase, which is the honest setting for an instance with no systemd unit — and
with it unset the plan for the same fleet is `[machines]` alone.)

## Results

| # | Claim | Verdict |
|---|---|---|
| 1 | All-git fleet updates end to end, zero build steps planned | **PASS** |
| 2 | Stalled machine ages into a visible stall on the step's own timer | see below |
| 3 | Straggler reconciliation | **PASS**, four arms |
| 4 | A cancelled operation grants nothing afterwards | see below |

### 1. All-git fleet, end to end — PASS

```
21:57:10  updates.start  → plan [machines, server], no prepare
21:57:13  supervisor: process exited rc=0, successor starting HEAD=68fc342
          operation op_81b9d4a6 done, 2.8 s after createdAt
  machines  done  progress 1/1  places [ludovico current 100%]  attempts 2
  server    done
```

The machine converged by git delivery and the process restarted onto the moved checkout;
the successor **adopted the same operation id** (`attempts` 1 → 2) and drove it to `done`.
Afterwards `/version`, the fleet target and the checkout HEAD all read `dev+68fc342`,
`behind 0`.

Git delivery took its documented same-sha short circuit here (`phases: ["git-status"]`),
because on a source install the checkout the operator moves IS the machine's checkout.
POD-2194 already proved the fetch-and-checkout arms against a real repository; what is new
here is that the convergence was **reached through a real grant from an operation**, which
is the half POD-2194 could not drive.

### 3. Straggler reconciliation — PASS, four arms

**Offline when the operation ran.** With the only machine offline, the plan was empty and
the operation reached `done` carrying
`deferred: [{ id: …, name: ludovico, reason: "offline" }]` and `error: null`. The absent
machine did not hold the outcome open, and nothing was invented for it.

**Converges on reconnect, unattended.** Reconnected one version behind at 21:08:02, it was
granted and converged at 21:08:03 — one second, nobody looking, no second click. The
successor daemon came back on the target at 21:08:05. The fleet row reads
`convergedBy: "reconciler"`, and `operations.history` still held exactly the three
operations that had been started by hand: **no new operation** was created for the
convergence.

**No hot-loop after a refusal.** A machine that answered `rejected` was reconnected three
times (21:05:24, 21:05:42, 21:06:02). No grant followed any of them: every daemon exit in
the log is one this drive caused, the machine stayed `rejected` and behind, and the git
shim's grant counter did not move.

**Publishing alone installs nothing.** A new target (`dev+af88da1`) was published while the
straggler was connected and behind. Over 60 s nothing was granted, nothing converged, and
the grant counter stayed at zero. A new version is an offer; convergence that starts itself
would be auto-update nobody asked for.

## Filed

- `POD-2201` — Try again cannot clear a refused machine (discovered-from POD-2087)
