# POD-2210 — the foreground all-in-one refuses the update, and says why

**Decision:** the daemon must not converge when its exit would also stop the coordinating
server and nothing would start that process again. It declines in the first person, before
anything is fetched or moved, and the refusal is carried all the way to the panel as its own
typed failure.

The brief offered three answers and asked for a reasoned choice rather than a coin toss.
Below is the reasoning, then what actually changed, then what a person now sees.

## The shape, restated from the evidence

POD-2157 drove this live and traced it to the composition root; the diagnosis was already
precise and this work did not have to re-find it.

| Shape | How it is composed | The daemon's post-convergence `process.exit(0)` |
|---|---|---|
| Installed, `persistence: systemd` | three units — server, janitor, daemon — each `Restart=always` | restarts the **daemon unit alone**; the server is never touched |
| Podium Desktop | sidecar child of the shell, `PODIUM_DESKTOP_SUPERVISED=1` | the shell respawns it (and it advertises no delivery caps anyway) |
| **`podium all` / bare `podium` with no persistence** | **server and daemon in ONE process** | **is the server's exit — and nothing exists to undo it** |

The shipped update unit confirms the intent for the installed shape: it runs `podium update`
and then `systemctl try-restart` on the *daemon* unit specifically. Only the third row has no
manager, and it is the shape a developer runs, which is why nobody noticed.

## Why not "restart it instead" (re-exec or in-process reload)

An in-process reload is not on the table: git delivery moves the source on disk, and only a
new process runs new code.

Re-exec is on the table, and it loses on a fact rather than on taste: **a source checkout moved
to a new commit may not boot without an install or a build.** That gate exists already — the
redeploy unit runs install and typecheck *before* it restarts server, daemon and janitor
together — and a foreground process has nowhere to run it and nobody to catch it if the new
code fails to start. So a self-restart trades a server that always dies for one that sometimes
dies, silently, at a slightly later moment.

The terminal semantics are the second count, not the first: the parent must exit before the
child can bind the port, the shell reaps the job and prints a prompt, and the surviving process
owns the terminal but no longer answers Ctrl-C.

## Why not "warn before starting" alone

A warning that is followed by the server dying anyway is a more polite version of the same
outcome. §6.2 requires the update to *end* somewhere named, and §7 requires the failure to name
itself — neither is satisfied by predicting the disappearance.

## Why the refusal comes BEFORE delivery, not after

Git delivery detaches the very checkout the running server reads from: its web assets, its
migrations, and `scripts/cli.ts`, which it spawns lifecycle workers from. A convergence that
did the delivery and then declined to exit would leave a live old process running against new
source — a worse state than either end of the operation. **Nothing changed is the only honest
half-way state**, so the refusal lands before the first byte.

It lands *after* the `already-current` check, though: a daemon that has nothing to converge has
nothing to refuse, and a fleet row reading `rejected` for a machine that is up to date would be
a new lie in place of the old one.

## What changed

- **`apps/daemon/src/convergence.ts`** — `refuseConvergence({ exitStopsServer, env })`, the
  pure decision, plus the refusal sentence. "Will something restart this process?" is answered
  with `INVOCATION_ID` (the *same* signal the server uses in `source-redeploy.ts` to decide it
  may restart itself) and `PODIUM_DESKTOP_SUPERVISED`.
- **`apps/daemon/src/grant-apply.ts`** — a `refuse()` dep on the grant path, checked before
  delivery; the refusal is reported as `rejected` carrying its reason.
- **`apps/daemon/src/daemon.ts`** — the restart seam itself is disarmed in that shape, so the
  *other* caller of the fatal exit (the protocol-mismatch self-update) cannot reintroduce the
  silent stop either. The property belongs to the process, not to one code path.
- **`apps/cli/src/cli.ts`** — `daemonOptionsForPlan` sets `exitStopsServer` for the in-process
  all-in-one. Only the launcher knows which roles this PID took, so it is passed, never sniffed.
- **`apps/server/.../operation.ts`** — a new §7 code, `machine-cannot-restart`. Without it the
  classifier's default would have called this `machine-unreachable` and told the operator to go
  and check whether a machine that had just answered them clearly was running.
- **`apps/web/.../operation-view.ts`, `update-view.ts`** — the panel copy for that code, and the
  free-text fallback for a server older than it.

## What a person sees now

Instead of a browser losing its server mid-operation:

> **ludovico is running as a single foreground process, so it cannot update itself. Nothing was
> changed.**
> Stop it in its terminal and start it again to pick this up — or run `podium setup` there to
> install it as a service, which can update itself without going down.

…with the raw reason kept in the collapsed diagnostic, and the same sentence logged into the
terminal the operator is watching.

This is the one §7 failure whose next action is genuinely not "try again" — the remedy is in
their terminal, and the copy says so.

## Known-open, deliberately

The *nicer* shape for this is not a failure at all but an **ask** (§3.5) — the same treatment
the desktop all-in-one gets, where the plan is empty, the operation settles into `waiting`, and
the panel says "finish this in Podium Desktop". Reaching it needs the host daemon's shape as a
fact on the wire (`PeerBuild`), a column on `machines`, and a planner branch — protocol, store
migration and server, all outside this issue's ownership. Filed as a follow-up; the refusal
landed here stops the harm and names itself, which is what §6.2 and §7 require.

A foreground *daemon-only* run (`podium daemon --server …` in a terminal) has the same
"nothing restarts it" property, but its exit costs a machine rather than the coordinating
server, and the fleet already reports that machine as gone. Left alone on purpose.

## Verification

- Focused suites, all green: `apps/daemon/{convergence,grant-apply,grant-apply.e2e,grant-apply-git}`,
  `apps/cli/{cli,local-dial-host}`, `apps/server/.../operation`, and the whole
  `apps/web/src/features/updates` suite run with the working directory set to `apps/web`.
- Scoped typechecks green: `@podium/daemon`, `@podium/cli`, `@podium/server`, `@podium/web`.
- **Every new assertion was proven able to fire.** Each guard was mutated once, the failure
  observed, and the mutation reverted:
  the `refuse()` check (2 red), the launcher's `exitStopsServer` (4 red), the `INVOCATION_ID`
  signal (2 red), the server's classifier pattern (1 red), and both panel-copy branches (3 red).
