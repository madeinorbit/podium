# POD-2157 — end-to-end acceptance: evidence

The acceptance drives POD-2194 and POD-2200 could not reach, run now that the box has disk
to build with. Their results are not repeated here: between them they already cover an
all-git update end to end with no pack, adoption across a coordinating-server restart with
the same operation id, single-flight in both arms, a stalled machine ageing on the step's own
timer, straggler reconciliation in four arms, the post-cancel case and the dirty-checkout
refusal.

- **Candidate:** `788d9b24c` (this branch, cut from integration tip `worktree-updater-spec`)
- **Date:** 2026-08-16
- **Host:** Linux x86_64, 8 cores, 23 GB memory (2–3 GB available throughout, swap full),
  13 GB disk free at the start

## Safety

Nothing touched the operator's default instance, state directory or checkout.

- Disposable named instance `pod2157`, state root `/home/mgw/src/other/podium-pod2157-state`,
  ports 18921 / 18922 / 18923, its own `PODIUM_AGENT_HOME`.
- Disposable checkout: `git clone --local --shared` at `/home/mgw/src/other/podium-pod2157`,
  so its `git fetch` reaches the local repository and never the operator's remote. Its
  `origin` was confirmed to be `/home/mgw/src/other/podium`.
- The served website is that checkout's own `apps/web/dist` (`PODIUM_WEB_DIR` left unset, so
  `desktopWebDir()` resolves relative to the running server module), which is disposable for
  the same reason the checkout is.
- `node_modules` was hardlink-copied (`cp -al`, 17 s) from a worktree whose `bun.lock` blob is
  identical (`b7e5677c`). No install, no measurable disk cost. Resolution was proved to land
  in the disposable checkout with `Bun.resolveSync`, not in the main one.
- Everything was removed afterwards; the disk returned is recorded at the end.

## What the trust boundaries allow, decided before driving

Two constants in the shipped code decide what a drive on this host can and cannot prove, and
they are stated up front so no result below is read as stronger than it is.

`packages/runtime/src/update-delivery.ts:273` picks the key each delivery is verified against:

```ts
const trustedPubkey = delivery === 'bundle' ? deps.pinnedPubkey : deps.pubkey
```

- **bundle** → the per-server key pinned at pairing, which the coordinating server MINTS
  itself (`readOrCreateUpdateSigningKey`). Fully drivable here, positive and negative arms.
- **feed** → `PODIUM_UPDATE_PUBKEY`, the production release key baked into the binary.
  `scripts/.podium-update-dev.key` — the gitignored private half — is ABSENT on this box, so
  no feed artifact produced here can be accepted by a compiled daemon. Only the fail-closed
  arms of feed delivery are drivable.

This matters most for the stable channel, because `resolveReleaseTarget` REFUSES a release
manifest offering any non-feed delivery. A stable target is therefore feed-only by
construction. Where that boundary is reached it is named explicitly rather than papered over.

**Corrected once by measurement, and the correction is the reason to measure.** The
paragraph above was written before driving, and its conclusion — that no positive feed arm
was reachable here — was wrong. Podium publishes REAL production-signed releases, and the
stable manifest resolves from this box right now (HTTP 200, version `0.1.3`, feed artifacts
with production signatures). So the positive feed path is drivable after all, using
artifacts Podium itself signed, without the private key ever being on this host. The
absent dev key only rules out signing NEW feed artifacts locally, which is a much smaller
claim than the one first written down.

## Instruments, all outside the product

No file under `apps/` or `packages/` was modified for any drive below, and no
file was written inside the disposable checkout either — a file there would make
it dirty and trip the publisher's dirty refusal, which is a different drill.

- **A supervisor**, because the disposable instance had none. A plain `while`
  loop around the same launch command, recording each generation. See the section
  above for why it is needed and what a real install has instead.
- **A screenshot driver**: one Chromium page, opened once and kept open for the
  whole drive, taking commands from a file. It is a single page on purpose — the
  panel's your-turn state is a fact about the build running THAT page.
- **`PODIUM_UPDATE_CHANNEL`**, the documented env seam, to pin the host to
  `stable`. No code change and no fetch interception: the stable manifest is
  Podium's real published one.

Two things this drive deliberately did NOT use, both of which earlier drives did:
no `BUN_BIN` build stub (the builds here are real, which was the point) and no
hand-stamped `podium-build.json` (POD-2200 used one to avoid the web step; this
drive exists to run it).

## A foreground all-in-one has no supervisor, and a git update stops it

Found while driving, and worth stating as a product fact rather than a harness
detail, because it decides what "the all-in-one restarts itself" means.

`apps/daemon/src/host-runtime.ts:389` gives the grant runner
`restart: opts.restartAfterUpdate ?? (() => process.exit(0))`, and nothing in the
shipped composition supplies `restartAfterUpdate`. So a daemon that has converged
exits. What that costs depends entirely on whether the daemon is its own process:

- **Installed all-in-one — PROTECTED.** In `apps/cli/src/cli.ts`, a bare invocation
  with `config.persistence === 'systemd'` resolves an all-in-one to THREE units —
  server, janitor and daemon — and `apps/cli/src/cli-systemd.ts` gives each its own
  `ExecStart` and `Restart=always`. The daemon's exit restarts the daemon unit
  alone; the coordinating server is never touched. The shipped update unit
  (`cli-systemd.ts:330`) confirms the intent: it runs `podium update` and then
  `systemctl --user try-restart <daemonUnit>` — the DAEMON unit, specifically.
- **Foreground `podium all` — NOT PROTECTED.** The other branch of the same
  function runs `runServer` and `runDaemon` in ONE process, and it is taken when
  there is no persistence or when the mode is named explicitly as a subcommand.
  There the daemon's `process.exit(0)` is the coordinating server's exit too, and
  with nothing supervising it does not come back. The browser simply loses the
  server mid-operation; the panel has no way to say so.

This is not a defect in the installed product. It is an unobvious property of the
shape a developer uses, and it is why this drive had to supply the supervisor that
systemd supplies on a real host — a plain restart loop around the same launch
command, which is all a unit is here.

## Results

| # | Claim | Verdict |
|---|---|---|
| 1 | The WEB STEP plans, runs a real build, and moves the served website | **PASS** |
| 2 | The panel reaches its your-turn state and tells the user to reload | **PASS**, screenshots attached |
| 3 | A stable-pinned host plans an update against the stable authority | **PASS**, live |
| 4 | Stable FEED delivery: fetch, verify against the production key, swap | **PASS**, live |
| — | Found: a stable installation is never offered an update | **FAIL** → `POD-2212` |
| — | Found: a downgrade bricks the install, unrecoverably | **FAIL** → `POD-2213` |
| — | Adoption across a process death, on the drive's own evidence | **PASS** (second sighting) |

### 1. The web step — PASS, and it is the first time any drive has reached it

POD-2200 avoided this step by stamping the served dist by hand. Here it was
planned, granted and run for real.

The plan, read off the persisted operation rather than inferred:

```
op_d9e0763a-a0f2-42cd-8e4b-5d0cfb7bf308   created 21:00:17.647Z
steps:    [machines, web]          ← no `prepare`, and no `server`
awaiting: [reload-surfaces  surface=web  required=false]
```

**No `prepare` step**, which is POD-2198's all-git guarantee holding on a fleet
whose one machine advertised `update.delivery.git` alone. **No `server` step**,
because `INVOCATION_ID` was unset, so `createSourceUnitRequest` returns undefined
and `canRestartServer` is false — the honest setting for an instance with no unit.

The step ran a real vite build, not a re-stamp. Three independent facts say so:

```
21:17:38.436  machines done   ludovico current 100%
              @podium/web build:dist: ✓ built in 8.46s
              [precompress] 73 files: 5.79 MB raw -> 1.38 MB br / 1.65 MB gzip
              build stamp: version dev+03a2892, bundle bundle+CZdXHa7z, source 03a2892
21:18:06.798  web done        "The new app is being served."
21:18:06.800  operation done
```

- the served stamp moved `d994fbb → 03a2892` and its `builtAt` is 21:18:05.713Z;
- the entry chunk hash moved `bundle+yhtREioC → bundle+CZdXHa7z`;
- the still-open browser tab began logging **404s for its own chunk filenames** —
  the old hashed files were physically replaced, which a re-stamp cannot do.

Afterwards all four authorities agree on the target: the served `index.html` meta
is `dev+03a2892`, `/version` reports `appVersion dev+03a2892`, the fleet reads
`targetVersion dev+03a2892, behind 0, state current`, and the checkout HEAD is
`03a2892`.

### 2. The panel, photographed in the branch app — PASS

Real clicks in a real Chromium page against the disposable instance, one page kept
open for the whole drive (the your-turn state is about the build running THAT page,
so a fresh page per shot would destroy the state being captured).

| Shot | State | What it says |
| --- | --- | --- |
| `01-app-no-panel.png` | — | nothing to update: no panel in the DOM at all |
| `02-panel-offer-available.png` | `offer` | *Podium dev+03a2892 is available*, with place rows in user language: *This app and your server (127.0.0.1) — will rebuild; this page will need to reload*; *Podium on your phone — will rebuild; reload it there*; *ludovico — will not be interrupted*; *Your sessions keep running.* Buttons: **Hide**, **Update Podium** |
| `03-panel-your-turn-reload.png` | `waiting-you` | *Podium dev+03a2892 is ready here* / *Everything else is updated. This page is still on the previous build.* Both steps ticked — *Updating your machines · 1 of 1 · ludovico current 100%*, *Serving the new app · The new app is being served.* — then *Reloads this page, about 2 seconds; your sessions keep running.* Buttons: **Hide**, **Reload** |
| `04-after-reload-panel-gone.png` | none | after clicking **Reload**: no panel in the DOM, the page is on `dev+03a2892` |

The panel is non-modal throughout, bottom-right, and the app stays usable behind
it. **The your-turn state does tell the user to reload, in those words**, and the
panel disappears once the page is current — it is never dismissed for them.

One state is deliberately NOT reported: the shot taken immediately after the
**Update Podium** click. A second session briefly amended this drive's target
commit at that moment, and that shot names the amended commit, so every panel
state between the click and the restart is contaminated. It is discarded rather
than cleaned up.

### 3. The stable channel — PASS at the planning layer, and it found a defect

The most important remaining claim, because until POD-2189 the operation channel
was the literal `'dev'`, so a stable-pinned fleet got no operation at all, and
every previous drive ran on the dev configuration where that is invisible.

**A real stable release exists and resolves.** This was worth checking rather
than assuming: `https://github.com/madeinorbit/podium/releases/latest/download/podium-update.json`
returns HTTP 200 with version `0.1.3`, feed delivery, and production digests and
signatures for `linux-x86_64`. No manifest was faked for this drive and no fetch
was intercepted.

The instance was relaunched with `PODIUM_UPDATE_CHANNEL=stable`; the fleet then
read `ludovico … channel: "stable"`. `updates.start` on that host:

```
op_99716e2a-cc80-4294-8149-730a1d572250   state running → done in 8 ms
details.channel      "stable"                      ← the HOST's channel, not 'dev'
details.target       version 0.1.3, artifacts.headless.delivery "feed",
                     digest sha256-/c0MiQRAnatMNKIshru3mDqReOuXKFrzk1z5fRJwbVg=
details.fromVersion  "dev+03a2892"
steps                []
deferred             [{ ludovico, reason: "cannot-take-delivery" }]
error                null
```

**A stable-pinned host gets an operation, and it is computed against the stable
authority** — the claim POD-2189 was written for, now shown on a live server
rather than in a planner test. The machine is `deferred` with
`cannot-take-delivery`, which is the correct answer and not a failure: a SOURCE
machine advertises `update.delivery.git` alone, and `resolveReleaseTarget`
refuses any non-feed delivery in a release manifest, so a stable target is
feed-only by construction. The absent machine did not hold the outcome open and
nothing was invented for it.

**Found here: a stable installation is never OFFERED an update — filed as
`POD-2212`.** POD-2189 fixed the OPERATION's channel and did not fix the read
path the panel's offer is built from. On the same running server, in the same
second, the operation resolved the stable target `0.1.3` while `/version`
advertised `dev+03a2892`: `server.ts:637` wires `/version`'s target as
`devPublisher.publishTarget() ?? updates.target()`, and `UpdatesService.target`
is declared `target(channel: UpdateChannel = 'dev')`. Both halves ask the dev
authority. On an installed host the publisher half is disabled and the fallback
resolves nothing, so `/version` carries no target and
`use-update-state.ts` — which derives the whole offer from `server.target` —
has nothing to show. The right helper already exists two methods away
(`targetFor(machineId)`, and `operationChannel(hostMachineId)`).

Honest limit on that finding: the disagreement is measured, the installed-host
consequence is read off the code, because this drive's host is a source install
whose publisher masks it. `POD-2212` says so.

### 4. Stable feed delivery, end to end — PASS, and it bricked the install

The second half of the stable claim: not just planned, but *run*. It needed a
machine that can take feed delivery, which a source checkout cannot
(`deliveryCaps` is `['update.delivery.git']` for `installKind === 'source'`), so
the drive used a disposable INSTALLED instance — staged from
`dist-bun/headless`, the bundle this branch's own dev publisher built at boot,
which is this branch's compiled binary. `PODIUM_HOME` being set is what makes it
`installKind !== 'source'` and so feed-and-bundle capable.

Instance `pod2157i`, ports 18931–3, its own state root, channel `stable`.

```
23:36:44  gen 1 starts        install VERSION dev+03a2892
23:36:48  gen 1 exits rc=0    install VERSION 0.1.3
```

**Four seconds**, and in them the shipped daemon fetched the real
`podium-headless-linux-x64.tar.gz` from GitHub, checked its digest, verified its
signature against the baked production key `PODIUM_UPDATE_PUBKEY`, and swapped
its own install directory. The swapped binary is demonstrably the published
release and not the staged one: `podium-cli` is 101,386,368 bytes dated Aug 10
21:31 (the release build) where the staged one was 102,156,416 bytes dated
Aug 16 23:18. Reproduced twice from a clean re-stage.

So the positive feed arm IS provable on this host — using artifacts Podium
itself signed, with the private key never present. That corrects the
pre-drive assumption recorded at the top of this document.

**Then it never came back up — filed as `POD-2213`.** The target it converged to
is OLDER than the build it was running, and the older binary refuses to start:

```
error: database has applied migration '20260809112031_transcript-segment-incarnations',
       which this build does not define. The database is newer than this build —
       upgrade the Podium server (downgrades are not supported).
```

It crash-looped through all 8 supervisor generations, each exiting in about a
second, and it cannot recover on its own: `podium update` on the swapped install
answers `already up to date (0.1.3)` because the feed has nothing newer, and the
panel that might offer a fix is served by the server that will not boot.

The downgrade itself is deliberate and correct —
`packages/protocol/src/update/convergence.ts` opens by explaining that
convergence is target EQUALITY and not `isNewer`, precisely so rollback stays
possible, and noting that `dev+<sha>` has no ordering at all. The defect is the
**collision**: the updater treats a downgrade as a supported rollback, the server
declares downgrades unsupported and refuses to start, and nothing sits between
them. A rollback across a migration boundary is not a rollback, it is a brick.

Worth noting how easily it is reached: POD-2196 recorded that a source instance
defaults to `stable`, so any build NEWER than the latest published release —
every development build, and every machine between releases — is one convergence
away from this. This drive reached it without asking for an update at all.

### 5. `bun run test:e2e` — the prescribed command cannot pass right now

Not because of anything in the updater. `test:e2e` is
`bun run build && … vitest … tests/e2e`, and `bun run build` ends in
`apps/web`'s bundle-size ratchet (`web-bundle-budget.ts dist --check`), which
fails at this tip with five breaches:

```
[web-bundle-budget] eager parsed source bytes: 7475360 exceeds 7400000
[web-bundle-budget] settings raw bytes:         261050 exceeds 105000
[web-bundle-budget] settings gzip bytes:         76671 exceeds 30000
[web-bundle-budget] settings Brotli bytes:       63419 exceeds 26000
[web-bundle-budget] settings parsed source bytes: 867740 exceeds 280000
error: script "build" exited with code 1
```

So the `&&` short-circuits and **no e2e test runs at all**. This is
`POD-2206`'s territory (*"four of its size budgets have been failing on main"*),
not a finding of this drive.

The comparison that makes that claim safe is unusually simple here, so it is
worth stating rather than gesturing at: **this branch changes no code at all.**
`git diff --name-only 788d9b24c..HEAD | grep -v '^docs/'` returns nothing — the
whole branch is this document, four screenshots and a log excerpt. A docs-only
branch cannot move a bundle budget, so the red is inherited by construction, and
no A/B run against the fork point is needed to say so.

`build:dist` itself SUCCEEDED — the ratchet is a check that runs after it — so
`apps/web/dist` exists and is stamped at this tip. The suite was therefore run
directly, skipping only the ratchet:

```
PODIUM_TEST_WORKERS=1 NODE_OPTIONS=--conditions=@podium/source \
  bun scripts/test-heavy.ts -- bun --bun node_modules/vitest/vitest.mjs run \
  --config vitest.integration.config.ts --maxWorkers=1 tests/e2e
```

<!-- E2E RESULT -->

### Adoption, seen again without being asked for

Not a new claim — POD-2194 proved it — but this drive produced it as a side
effect and the numbers are worth keeping, because this time the predecessor did
not exit politely: it was taken down mid-step by the daemon it shares a process
with (see above), 13 supervisor generations before the successor stuck.

```
BEFORE: op_d9e0763a  createdAt 1786914017647  machines running  web pending
AFTER:  op_d9e0763a  createdAt 1786914017647  machines done     web done
```

Same id, same `createdAt`, same step order. The successor picked up a `machines`
step whose place had been mid-`downloading` when the process died, settled it as
`current`, and carried the operation to `done`.

