# Updater acceptance regimen

Use this regimen to answer one question: can an operator discover, start, survive, and
recover from a Podium update on every supported installation shape? A green unit suite is
necessary, but it is not evidence that the updater works in practice.

## Safety and evidence

- Never exercise an update against the operator's default live instance or state directory.
  Use a named instance, disposable checkout or install, and disposable state.
- Record the candidate commit, old and target versions, installation kind, platform, and
  artifact delivery kind with every run.
- Keep the update panel visible in screenshots or a short recording at four points:
  available, applying, reconnected/current, and a deliberately induced failure.
- Record the final on-disk version and the fleet status after reconnect. A toast or a process
  exit is not enough to prove that an update landed.
- Run validation commands sequentially. Do not overlap focused tests, typecheck, the default
  test gate, or the heavier runtime lanes.

The headless release workflow publishes stable assets only from `v*` tags. Publishing the
rolling `edge` prerelease requires an explicit `workflow_dispatch`; ordinary pushes to `main`
never publish it. Both paths finish by downloading the release assets that GitHub actually
serves and exercising their production signature with the shipped updater.

## Cadence

### 1. Every updater code change

Run the smallest focused tests for the files that changed.

**`test:related` cannot see `apps/web`.** It runs the `node` and `normalized-wire` projects
only, and `apps/web` has its own vitest config, so a web test file is never selected and the
gate reports success having run nothing about your change. Web work runs its own suite
directly:

```bash
# web surfaces — UpdatePanel.tsx, operation-view.ts, update-view.ts,
# use-update-state.ts, operations-client.ts, updates-context.tsx
cd apps/web && bun --bun vitest --config vitest.config.ts run src/features/updates/

# everything else — the operation engine, the update kind, delivery, the daemon side
bun run test:related -- apps/server/src/modules/operations/engine.ts apps/server/src/modules/updates/operation.ts apps/server/src/modules/updates/reconciler.ts apps/server/src/modules/updates/wave.ts apps/daemon/src/grant-apply.ts packages/runtime/src/update-delivery.ts
```

The module layout these names come from, since the operation rewrite moved most of it:

| Concern                                                                              | Module                                                                                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Generic operation lifecycle: identity, single-flight, sequencing, liveness, adoption | `apps/server/src/modules/operations/engine.ts` (+ `store.ts`, `transitions.ts`, `kinds.ts`) |
| What an update operation _is_ — the plan, the steps, the asks                        | `apps/server/src/modules/updates/operation.ts`                                              |
| Fleet choreography for one operation: canary, widening, concurrency                  | `apps/server/src/modules/updates/wave.ts`                                                   |
| Background convergence of stragglers, with no operation at all                       | `apps/server/src/modules/updates/reconciler.ts`                                             |
| Artifact download, digest + signature verification, progress reporting               | `packages/runtime/src/update-delivery.ts`                                                   |
| The one panel, its states and its single dismiss verb                                | `apps/web/src/features/updates/UpdatePanel.tsx`                                             |
| Operation → what a person reads                                                      | `apps/web/src/features/updates/operation-view.ts`                                           |
| Offer → what a person reads, before any operation exists                             | `apps/web/src/features/updates/update-view.ts`                                              |

Then drive the changed interaction in the real branch app using
`docs/agents/driving-podium.md`. For a failure-panel change, induce a failure, click **Hide**
— the only dismiss verb the panel has — and observe that the panel disappears without
navigation or page reload.

Before a substantive commit, run these one at a time. Repo-wide `typecheck` is not survivable
on the shared box (it OOM-kills sessions mid-command, with no error); scope it, and keep
`--concurrency=1`, which is the part that makes it survive:

```bash
turbo run typecheck --filter=@podium/server --concurrency=1
bun run test
```

### 2. Every updater candidate

Run the headless signed-feed smoke:

```bash
bash scripts/verify-headless-update.sh
```

It must prove both arms:

- a valid signed artifact changes the disposable install from `0.1.0` to `0.1.1`;
- a tampered artifact is rejected and leaves the old install unchanged.

Run the full-stack process lane when server/daemon/grant/restart behavior changed:

```bash
bun run test:e2e
```

Run the independent-instance lane when instance identity, state roots, endpoints, CLI
routing, ownership, or lifecycle behavior changed:

```bash
bun run test:multi-instance
```

### 3. Operation-model drills

These four are the properties the operation rewrite added, and none of them is visible in a
happy-path update. Each is a real drive, not a planner test: they exist because the unit
suites can only prove the decision, never that the wiring survives a real process boundary.

**Adoption across a coordinating-server restart.** Start an update whose plan has a step
still running, then restart the coordinating server under it (the all-in-one shell install
does this to itself, which is why it is the ordinary case and not the exotic one). The
successor process must ADOPT the same operation rather than starting a second one or leaving
the group wedged: the panel keeps its identity and step positions across the reconnect, and
finishes. Two things to check specifically, because both have been wrong before:

- the adopted step is not immediately failed for the DEAD process's silence — the successor
  restarts the clock on the places it is waiting on, so a step is judged on how long _it_ has
  been quiet;
- a stall the operation already recorded SURVIVES the restart. A restart must not buy a
  fresh silence budget, or a wedged step can be revived indefinitely by restarting.

An operation whose kind the successor binary does not register must surface as
`operation-adoption-failed`, not as a silent disappearance.

**Single-flight (P6).** With an update operation active, start another from a second surface.
The second must be REFUSED and told who holds the group — not queued, not merged, and above
all not started. Race it properly: two starts issued close enough together to overlap the
async planning window, since the guard that matters is the one at the store, not the one in
the caller. Then confirm the group is released on the terminal transition and a new operation
can start.

**Stalled download.** Interrupt the artifact transfer mid-flight (a proxy that accepts the
connection and then stops sending is the cheapest way) on a machine taking feed delivery. Required behaviour: progress frames stop, the step goes `stalled` rather than
sitting in `downloading` forever, the panel says which machine stopped reporting rather than
showing a generic spinner, and the download eventually fails on its hard deadline instead of
holding the operation open. Then let it recover instead of failing, and confirm the stall is
recorded on the step rather than erased by the resumption — a stall the operator lived
through is a fact about the update.

**Straggler reconciliation.** Have a machine offline when an update runs, so the plan puts it
in `deferred` and the operation reaches `done` without it. Then bring it back and watch it
converge with nobody looking, and no second human decision. What to prove:

- it converges to the CURRENT target, and the fleet row says the reconciler moved it rather
  than presenting it as an ordinary update;
- reconciliation does not race an operation: while an exclusive lifecycle operation is
  active it is paused (`operation-active`), resuming on the terminal transition — including
  after a FAILED operation, which is how the fleet cleans up without a human pressing
  Try again;
- it does not hot-loop. A machine that answered `rejected` or `stuck` must be left alone
  until the target changes or a human applies it by hand. Drive this one deliberately: refuse
  an update on a machine, then reconnect it repeatedly and confirm no new grant is issued.
  This is the arm most likely to regress silently, because a broken version looks like a
  working one until you count the grants.
- publishing a new target does NOT trigger it. Publish while a straggler is connected and
  behind, and confirm nothing installs: a new version is an offer, and convergence that
  starts itself is auto-update nobody asked for.

### 3a. macOS external payload and fleet-of-one

The signed .app is now the frame and recovery seed, not the live server/daemon/web
installation. On first backend-bearing boot, and only when the complete payload directory is
absent, the shell copies Contents/Resources/payload to the Application Support payload home,
marks its launchers executable, recursively removes com.apple.quarantine, and starts the thin
parent there. Presence is the sole seed decision: boot does not inspect health and never
overwrites an existing directory.

Three former desktop dispositions are retired deliberately:

- build-report.ts no longer empties delivery capabilities for a supervised daemon.
  PODIUM_DESKTOP_SUPERVISED describes crash ownership only; an installed Mac reports feed
  delivery like any other installed machine.
- wave.ts and the standing reconciler no longer exclude supervised machines. The
  all-in-one server coordinates its own host as a fleet of one; daemon-only Macs take the
  same grants from their paired remote coordinator.
- operation.ts no longer mints the required desktop-install ask. A payload operation uses
  the ordinary machine step, so schema gating, canary/waves, progress, stuck detection,
  restart proof, rollback, and operation adoption remain visible. The constant and
  post-restart cleanup remain only to adopt operations persisted by an older server.

For every Mac payload candidate, prove these cases on a disposable Application Support root:

- **Fresh install:** payload directory absent → one seed copy; the daemon registers, then a
  normal grant catches the seed up to the current channel target.
- **No overwrite:** an existing incomplete or corrupt directory is left untouched during
  boot and the shell shows the baked payload-repair page when the local UI cannot serve.
- **Repair:** Settings and podium update --repair force an equal-version grant through the
  coordinator. If the coordinator cannot serve, the baked page atomically restores the
  signed seed, retains the damaged directory beside it, restarts the parent, and ordinary
  reconciliation catches it up.
- **Shell untouched:** publish a dev payload target, apply it to the Mac, and confirm the
  .app version and bytes do not change while the Application Support payload does.
- **Handover supervision:** observe the old parent report its detached successor, the shell
  follow that verified payload executable, and Quit terminate the current successor rather
  than only the original child.
- **Gatekeeper:** launch the seeded copy after quarantine removal and launch a
  grant-delivered, digest/signature-verified copy. Record codesign --verify --deep --strict
  and the actual launcher exit/version for both.

**Transition release gate.** The first release containing this layout must be cut with a
v\* tag, not by the headless-only workflow dispatch. That one tag starts both release
workflows and therefore mints a new notarized Mac shell which knows the external payload
home. Old shells continue using Contents/Resources; publishing only new headless payloads
would strand them, so the companion desktop artifacts are release-blocking for this cut.
After that transition, ordinary payload releases do not require another shell unless frame
code changes.

### 4. RETIRED — source checkout / git delivery drive

**Deleted deliberately, 2026-08-21 (POD-2503, spec §1 and disposition 5).** This section
required a real UI drive of a machine converging a git checkout to a granted sha, plus two
negative variants: a dirty checkout that must refuse without `reset`/`clean`/`--hard`, and a
machine offered no delivery it could take.

The `git` delivery kind no longer exists. Exactly one machine in the reference topology runs
from source — the publisher on ludovico — and it is not a fleet consumer; once POD-2512 lands
it becomes an installed consumer like every other machine. A daemon running from source now
reports NO delivery capability at all, so it is never granted anything, and there is no code
path left for either the positive drive or the dirty-checkout refusal to exercise.

WHAT WAS LOST AND WHERE IT WENT, so this is a retirement rather than a gap:

- The **dirty-checkout refusal** still exists, but on the PUBLISHER rather than on a
  consumer: `assertSourceMatchesHead` in `dev-bundle.ts` fails closed before a release is
  built, because an edited checkout cannot produce a bundle of the commit it claims. That is
  now covered by drive 5's dev-channel leg (below) — publish from a dirty tree and confirm
  the release is refused with the offending paths named, and the working tree untouched.
- The **unsupported-delivery refusal** is unchanged and moves to drive 5: a machine that
  cannot take what the target offers must be shown as deferred with a reason, never granted
  and left to fail.
- The **twice-around** requirement (repeat from the new version, to catch stale target,
  pending-marker and restart state that only appear on the second cycle) moves to drive 5 and
  is not optional there.

### 5. Installed headless feed drive — INCLUDING the dev channel

On a disposable installed instance, publish a signed feed target and repeat the UI sequence
above. Verify the machine uses feed delivery, swaps only its instance-owned install, restarts,
reconnects, and reports the target version. Repeat with a corrupted artifact and with a
signature made by the wrong key; both must fail closed and leave the old install bootable.

Run it on the DEV channel as well as a release channel, because per-channel trust is the one
thing the two legs do not share (spec §1):

- the dev leg must verify against the key the daemon pinned at pairing, and the release leg
  against the baked release key. Prove BOTH directions of the mistake: a dev-signed artifact
  offered on a release-channel target, and a release-signed artifact offered on a dev target.
  Each must be refused with a signature failure and nothing swapped. Also the missing half:
  an instance-trusted target reaching a daemon that pinned no key at all must refuse closed
  before any download, with nothing swapped.
- the dev feed is machine-authenticated: an unauthenticated request for either the manifest
  or an artifact must be refused with 401 before anything is opened.
- a release-channel manifest naming an artifact URL outside the release feed must be refused
  at RESOLVE time, before any download.
- publish from a dirty checkout and confirm the release is refused, the offending paths are
  named, and the local files are preserved exactly.
- offer no delivery the machine can take and confirm a fail-closed refusal, followed by a
  dismissible panel that explains the next useful action.
- repeat once more from the new version, to catch stale target, pending-marker and restart
  state that only appear on the second cycle.

### 6. Signed desktop release drive

Linux can use the existing AppImage verifier when its prerequisites and development signing
key are available:

```bash
bash apps/desktop/scripts/verify-update.sh
```

For each release candidate, also run one production-signed macOS update on a real machine.
Start the old notarized build, point it at the candidate channel, and verify check, download,
signature validation, install, application restart, and the post-restart version. Also
exercise a broken artifact and confirm the native fallback never blocks the app, the old
build remains launchable, and the web panel gives a dismissible actionable failure. The
Linux AppImage run does not substitute for this macOS proof.

## Release acceptance table

| Surface                      | Positive path                                               | Required negative path                                                                        | Proof of completion                                                                    |
| ---------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Installed headless (release) | Signed feed swap and reconnect, twice                       | Tamper; wrong signing key                                                                     | On-disk version and reconnect agree                                                    |
| Installed headless (dev)     | Signed feed swap from the pulled dev feed                   | Cross-channel key; missing pinned key; unauthenticated feed request; dirty publisher checkout | On-disk version and reconnect agree; refusals name the cause                           |
| Web update panel             | Available to applying to current                            | Connection/delivery failure can be dismissed                                                  | Real click observed in branch app                                                      |
| Linux desktop                | Signed AppImage replacement                                 | Signature/install failure                                                                     | Re-launched on-disk AppImage reports target                                            |
| macOS payload                | Signed seed, then ordinary fleet grant with frame untouched | Existing corrupt directory; equal-version repair; quarantine                                  | Application Support payload and fleet report target; notarized frame version unchanged |
| Multiple instances           | Only selected instance updates                              | Other named instance stays untouched                                                          | State, ports, services, and bundle remain disjoint                                     |
| Operation adoption           | Successor server adopts and finishes the same operation     | Unregistered kind surfaces `operation-adoption-failed`                                        | Operation id and step positions unchanged across the restart                           |
| Single-flight                | Second start refused, naming the holder                     | Two starts racing the async plan window still yield one                                       | Only one non-terminal operation in the group, throughout                               |
| Stalled download             | Stall is shown, named, and recovers                         | Hard deadline fails it rather than holding the operation open                                 | Stall count survives on the step after recovery                                        |
| Straggler reconciliation     | Reconnected machine converges unattended                    | Refused machine is not re-granted on repeated reconnects; publishing alone installs nothing   | Fleet row attributes the move to the reconciler; grant count does not climb            |

An updater candidate is not accepted while any applicable row lacks its positive path,
negative path, or post-restart proof. If a platform cannot be exercised on the current host,
record it as an explicit release-blocking verification item rather than calling the updater
fully verified.
