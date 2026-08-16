# POD-2200 — acceptance drills for an all-git fleet: evidence

Drive of the claims POD-2194 could not reach, now that POD-2198 plans the pack per delivery
capability. POD-2194's own results (adoption across a coordinating-server restart,
single-flight, the dirty-checkout refusal, git delivery's four arms) are not repeated here.

- **Candidate:** integration tip `b64716255`, plus disposable drill commits on this branch
- **Installation kind:** source checkout, Linux x86_64, split server + daemon processes
- **Artifact delivery offered:** `git` only — the host daemon advertised
  `deliveryCaps: ["update.delivery.git"]` throughout
- **Date:** 2026-08-16
- **Host resources throughout:** 2–4 GB memory available of 23, ~3.5 GB disk free at 99 %

## Safety

Nothing touched the operator's default instance, state directory or checkout.

- Disposable named instance `pod2200`, state root `/home/mgw/src/other/podium-pod2200-state`,
  ports 18911 / 18912 / 18913, its own `PODIUM_AGENT_HOME` and `PODIUM_WEB_DIR`.
- Disposable checkout: `git clone --local --shared` at `/home/mgw/src/other/podium-pod2200`,
  so its `git fetch` reached the local repository and never the operator's remote.
- Verified empirically rather than by reading a constant: the published target named
  `"repo": "/home/mgw/src/other/podium-pod2200/"` — the disposable checkout.
- `node_modules` was hardlink-copied (`cp -al`, 3.6 s) from a sibling worktree whose
  `bun.lock` blob is identical. No install, no measurable disk cost.
- Everything was removed afterwards; the disk it returned is recorded at the end.

The commits preceding this one on this branch are not padding: each is a real update target
this drive published and moved a checkout onto, which is why the SHAs below name them.

## No compiler ran

`BUN_BIN` — the documented env seam read by `devBuildCommand`; no source was modified —
pointed at a stub that appends its argv to a log and exits 0. Across the whole drive that
log contains only the two boot-time invocations each server start makes
(`run --filter @podium/web build:dist`, `run --filter @podium/mobile build:web`). **No pack
was ever attempted, by any operation** — which is itself part of the evidence below.

The served website was stamped by hand at each target commit (`podium-build.json` carrying
`sourceSha`, in `PODIUM_WEB_DIR`), so the website was already current and no `web` step was
planned. That is a state of the world, not a code change: `planUpdateOperation` plans `web`
only when `servedWebDigest !== target.artifacts.web.digest`.

Two further drill instruments, both outside the product:

- **A grant counter.** A `git` shim first on the *daemon's* PATH which, when an arm file is
  present, hangs on `--untracked-files=all` — the token only `convergeViaGit`'s status call
  passes — and is the real git otherwise. Its log is one line per convergence attempt that
  reached the machine, which is how "no grant was issued" is measured below rather than
  assumed.
- **A version pin.** `PODIUM_APP_VERSION` on the daemon, so a machine can report a version
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

**No `prepare` step**, and the `machines` step granted without one — the grant counter moved
on the operation's own start, and POD-2195's *"Waiting for the update package."* never
appeared once.

**The guarantee is zero PACK steps, not zero build steps** — stated precisely because the
looser wording invites a false failure report. The plan for a fleet like this is `machines`,
then `server` if this server is behind and can restart itself (a restart, not a build), then
`web` if the served website's digest differs from the target — and on a source install that
last one runs a vite build of `apps/web`. A `web` step is therefore not a failure of the
premise. It did not appear here because the served dist was already stamped at the target
commit (see above), which is what makes this drive's plan free of any build at all; on a
host with disk to spare, letting the `web` step run is the ordinary case.

**Precondition, checked first.** Unknown delivery capabilities deliberately count as needing
the pack, so a machine that has never handshaken its caps plans a `prepare` step and looks
exactly like the old behaviour. This fleet's one machine reported
`deliveryCaps: ["update.delivery.git"]` on every `updates.fleet` read of the drive, before
and after each operation. The premise was tested against a machine that had actually said
what it can take.

(The `server` step was planned because `INVOCATION_ID` was inherited from the launching
session, so the server believed a supervisor could restart it. It was unset for every later
phase — the honest setting for an instance with no systemd unit — and with it unset the plan
for the same fleet is `[machines]` alone.)

## Results

| # | Claim | Verdict |
|---|---|---|
| 1 | All-git fleet updates end to end, no pack planned or needed | **PASS** |
| 2 | A granted machine that goes silent stalls on the step's own timer | **PASS** |
| 3 | Straggler reconciliation | **PASS**, four arms |
| 4 | A cancelled operation grants nothing afterwards | **PASS** |
| — | Found: an operation cannot clear a terminal verdict | **FAIL** → `POD-2201` |

### 1. All-git fleet, end to end — PASS

```
20:57:10  updates.start  → plan [machines, server], no prepare
20:57:12  supervisor: process exited rc=0, successor starting HEAD=68fc342
          operation op_81b9d4a6 done, 2.8 s after createdAt
  machines  done  progress 1/1  places [ludovico current 100%]  attempts 2
  server    done
```

The machine converged by git delivery and the process restarted onto the moved checkout; the
successor **adopted the same operation id** (`attempts` 1 → 2) and drove it to `done`.
Afterwards `/version`, the fleet target and the checkout HEAD all read `dev+68fc342`,
`behind 0`.

Git delivery took its documented same-sha short circuit here (`phases: ["git-status"]`),
because on a source install the checkout the operator moves IS the machine's checkout.
POD-2194 already proved the fetch-and-checkout arms against a real repository; what is new
is that a convergence was **reached through a real grant from an operation**, which is the
half POD-2194 could not drive at all.

### 2. Stalled machine — PASS, on the step's own timer with nothing polling

The machine was granted by the operation at 21:18:12 (grant counter 0 → 1). Its delivery was
made to hang in `git-status`, and the daemon was then SIGSTOPped, so it could neither report
progress nor report its own eight-minute git budget expiring. **Nothing read the server for
the whole of each window**: one read was armed for after each deadline and no other reader
existed.

```
21:18:11.993  place ludovico  downloading                       (grant counter 1)
21:18:50.107  place ludovico  offline        ← last progress of any kind
   … 10 minutes in which nothing polled the server …
21:28:50.131  step stalled and re-entered:  stalls 1, attempts 2   (+600 024 ms)
   … 10 more minutes in which nothing polled the server …
21:38:50.127  operation FAILED                                    (+600 002 ms)
    error.code    machine-unreachable
    error.places  ["cd1d481b-…"]                ← the machine, named
    error.message "ludovico stopped responding while updating.
                   Check it's running; it will resume when it reconnects."
    fleet row     state stuck, "The machine stopped reporting progress while updating."
```

Both deadlines fired within ~130 ms of their budgets with no reader in the loop, which is
the claim that replaced the old poll-driven deadline. **Exactly one stall and exactly one
retry**: `stalls` stopped at 1 and the second breach failed rather than retrying again. The
failure names the machine rather than being a stall with no places — `describeUpdateStall`
did its job.

Two honest notes. The `stalled` state itself is transient — the engine persists it, then
re-enters the runner, which reports `running` again; this drive read 22 s later and so
observed the recorded `stalls: 1` rather than the state. And the machine went `offline`
twelve seconds after the SIGSTOP (the coordinator noticed the dead connection), which
restarted the place clock once; both silence windows are measured from that, and `offline`
is deliberately one of the awaited states.

### 3. Straggler reconciliation — PASS, four arms

**Offline when the operation ran.** With the only machine offline, the plan was empty and the
operation reached `done` carrying
`deferred: [{ id: …, name: "ludovico", reason: "offline" }]` and `error: null`. The absent
machine did not hold the outcome open, and nothing was invented for it.

**Converges on reconnect, unattended.** Reconnected one version behind at 21:08:02, it was
granted and converged at 21:08:03 — one second, nobody looking, no second click. The
successor daemon came back on the target at 21:08:05. The fleet row reads
`convergedBy: "reconciler"`, and `operations.history` still held exactly the three
operations that had been started by hand: **no new operation** was created for the
convergence.

**No hot-loop after a refusal.** A machine that answered `rejected` was reconnected three
times (21:05:24, 21:05:42, 21:06:02). No grant followed any of them: every daemon exit in
the log is one this drive caused, the machine stayed `rejected` and behind, and the grant
counter did not move.

**Publishing alone installs nothing.** A new target (`dev+af88da1`) was published while the
straggler was connected and behind. Over 60 s nothing was granted and nothing converged; the
grant counter stayed put. The reconciler acts on a machine's reconnect, not on a
publication — a new version is an offer.

### 4. Post-cancel — PASS

```
21:41:09  updates.start   → machine granted, delivery hanging   (grant counter 1 → 2)
21:41:20  operations.cancel → { canceled: true }, state canceled, operations.active null
21:44:06  grant counter STILL 2; no new operation; machine did not converge
```

Nothing was granted after the cancel — not by the wave, and not by the reconciler once it
resumed on the terminal transition (it refuses a machine whose grant is in flight). The
machine is left `stuck` with the deliberate sentence "The update was canceled while this
machine was updating."

### Found on the way: an operation cannot clear a terminal verdict — filed as POD-2201

`machinesRunner.ensure` calls `settleMachines` before `markAuthorized`, so a machine whose
last word was `rejected` or `stuck` decides the *next* operation before anyone asks it. Two
entry points, both measured with the grant counter and both issuing zero grants:

```
machine rejected:            updates.start → failed in 10 ms, 0 grants
                             updates.retry → failed in 10 ms, 0 grants  (the panel's Try again)
machine stuck after cancel:  updates.start → failed in  9 ms, 0 grants
```

Each failure says "ludovico stopped responding while updating" while the machine is
connected and idle. The cancel path is the severe one: cancelling an update leaves the
operator unable to start another. The only escape found on this drive was publishing a
different target commit.

## Not reached

- **Panel screenshots.** Unchanged from POD-2194: the panel needs `apps/web/dist` built at
  this tip, which is a build. Every state above was captured at the API layer.
- **A genuine fetch-and-checkout convergence driven by an operation.** On a single-machine
  source instance the published target is derived from the same checkout the machine owns,
  so git delivery always takes its same-sha short circuit. Proving the long path through a
  grant needs a second machine with its own checkout.
