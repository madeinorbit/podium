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

## Cadence

### 1. Every updater code change

Run the smallest focused tests for the files that changed. Common entry points are:

```bash
bun run test:related -- apps/web/src/features/updates/UpdateDialog.tsx apps/web/src/features/updates/use-update-state.ts apps/web/src/features/updates/update-view.ts
bun run test:related -- apps/server/src/modules/updates/dev-bundle.ts apps/server/src/modules/updates/service.ts apps/daemon/src/grant-apply.ts packages/runtime/src/update-delivery.ts
```

Then drive the changed interaction in the real branch app using
`docs/agents/driving-podium.md`. For a failure-panel change, induce a failure, click the
dismiss control, and observe that the panel disappears without navigation or page reload.

Before a substantive commit, run these one at a time:

```bash
bun run typecheck
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

### 3. Source checkout / git delivery drive

Use a disposable source checkout on an old commit and a separate target commit. Start it as
a named instance so its state, ports, daemon, and update target cannot touch the default
instance. Follow `docs/multi-instance.md` for identity selection.

In the UI, verify this sequence with real clicks:

1. The panel names the target version and the affected places in user language.
2. Clicking **Update server** changes the same non-modal panel to applying.
3. The source daemon selects git delivery; an installed daemon must not select git merely
   because it is offered.
4. Sessions remain usable while the server/daemon reconnect.
5. The panel reaches current and disappears; `/version`, fleet status, and the checkout HEAD
   all report the target.
6. Repeat once more from the new version to catch stale target, pending-marker, and restart
   state that only appear on the second cycle.

Run two negative variants against disposable checkouts:

- make the checkout dirty and confirm the update refuses without reset, clean, `--hard`, or
  `--force`, preserving the local file exactly;
- offer no delivery compatible with the machine and confirm a fail-closed refusal, followed
  by a dismissible panel that explains the next useful action.

The exact launch and target-publication commands should live beside the delivery
implementation once POD-1738 settles them; do not replace this real UI drive with a pure
planner test.

### 4. Installed headless bundle/feed drive

On a disposable installed instance, publish a signed bundle/feed target and repeat the UI
sequence above. Verify the machine uses bundle or feed delivery, validates the pinned
per-server key where required, swaps only its instance-owned install, restarts, reconnects,
and reports the target version. Repeat with a missing/wrong pin and a corrupted artifact;
both must fail closed and leave the old install bootable.

### 5. Signed desktop release drive

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

An updater candidate is not accepted while any applicable row lacks its positive path,
negative path, or post-restart proof. If a platform cannot be exercised on the current host,
record it as an explicit release-blocking verification item rather than calling the updater
fully verified.
