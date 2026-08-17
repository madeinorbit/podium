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

| Concern | Module |
| --- | --- |
| Generic operation lifecycle: identity, single-flight, sequencing, liveness, adoption | `apps/server/src/modules/operations/engine.ts` (+ `store.ts`, `transitions.ts`, `kinds.ts`) |
| What an update operation *is* — the plan, the steps, the asks | `apps/server/src/modules/updates/operation.ts` |
| Fleet choreography for one operation: canary, widening, concurrency | `apps/server/src/modules/updates/wave.ts` |
| Background convergence of stragglers, with no operation at all | `apps/server/src/modules/updates/reconciler.ts` |
| Artifact download, digest + signature verification, progress reporting | `packages/runtime/src/update-delivery.ts` |
| The one panel, its states and its single dismiss verb | `apps/web/src/features/updates/UpdatePanel.tsx` |
| Operation → what a person reads | `apps/web/src/features/updates/operation-view.ts` |
| Offer → what a person reads, before any operation exists | `apps/web/src/features/updates/update-view.ts` |

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
  restarts the clock on the places it is waiting on, so a step is judged on how long *it* has
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
connection and then stops sending is the cheapest way) on a machine taking bundle or feed
delivery. Required behaviour: progress frames stop, the step goes `stalled` rather than
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

### 4. Source checkout / git delivery drive

Use a disposable source checkout on an old commit and a separate target commit. Start it as
a named instance so its state, ports, daemon, and update target cannot touch the default
instance. Follow `docs/multi-instance.md` for identity selection.

In the UI, verify this sequence with real clicks:

1. Disable the checkout HEAD watcher, move the checkout to the target, and prove the
   coordinating server PID does not change before approval.
2. The panel names the target version and only the affected development-authority places
   in user language; edge/stable-selected machines are not counted against the dev target.
3. Clicking **Update Podium** changes the same non-modal panel to applying.
4. Every selected development machine reaches the exact target and reconnects as
   `current` before the coordinating server requests its guarded restart. Prove this
   from the server's raw post-reconnect machine identity, not an optimistic update status
   emitted before the old daemon exits.
5. The source daemon selects git delivery; an installed daemon must not select git merely
   because it is offered.
6. Sessions remain usable while the server/daemon reconnect.
7. The panel reaches current and disappears; `/version`, fleet status, and the checkout HEAD
   all report the target, while the HEAD watcher remains disabled.
8. Repeat once more from the new version to catch stale target, pending-marker, and restart
   state that only appear on the second cycle.

Run two negative variants against disposable checkouts:

- make the checkout dirty and confirm the update refuses without reset, clean, `--hard`, or
  `--force`, preserving the local file exactly;
- offer no delivery compatible with the machine and confirm a fail-closed refusal, followed
  by a dismissible panel that explains the next useful action.

The exact launch and target-publication commands should live beside the delivery
implementation once POD-1738 settles them; do not replace this real UI drive with a pure
planner test.

### 5. Installed headless bundle/feed drive

On a disposable installed instance, publish a signed bundle/feed target and repeat the UI
sequence above. Verify the machine uses bundle or feed delivery, validates the pinned
per-server key where required, swaps only its instance-owned install, restarts, reconnects,
and reports the target version. Repeat with a missing/wrong pin and a corrupted artifact;
both must fail closed and leave the old install bootable.

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

| Surface | Positive path | Required negative path | Proof of completion |
| --- | --- | --- | --- |
| Source checkout | Git delivery and reconnect, twice | Dirty checkout; unsupported delivery | HEAD, `/version`, and fleet target agree |
| Installed headless | Signed bundle/feed swap | Tamper; missing/wrong pinned key | On-disk version and reconnect agree |
| Web update panel | Available to applying to current | Connection/delivery failure can be dismissed | Real click observed in branch app |
| Linux desktop | Signed AppImage replacement | Signature/install failure | Re-launched on-disk AppImage reports target |
| macOS desktop | Production-signed install and restart | Broken artifact/native fallback | Restarted notarized app reports target |
| Multiple instances | Only selected instance updates | Other named instance stays untouched | State, ports, services, and bundle remain disjoint |
| Operation adoption | Successor server adopts and finishes the same operation | Unregistered kind surfaces `operation-adoption-failed` | Operation id and step positions unchanged across the restart |
| Single-flight | Second start refused, naming the holder | Two starts racing the async plan window still yield one | Only one non-terminal operation in the group, throughout |
| Stalled download | Stall is shown, named, and recovers | Hard deadline fails it rather than holding the operation open | Stall count survives on the step after recovery |
| Straggler reconciliation | Reconnected machine converges unattended | Refused machine is not re-granted on repeated reconnects; publishing alone installs nothing | Fleet row attributes the move to the reconciler; grant count does not climb |

An updater candidate is not accepted while any applicable row lacks its positive path,
negative path, or post-restart proof. If a platform cannot be exercised on the current host,
record it as an explicit release-blocking verification item rather than calling the updater
fully verified.
