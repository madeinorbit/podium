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
construction, and the last hop of a stable update cannot be completed on a host without the
production key. Where that boundary is reached it is named explicitly rather than papered
over.

## Instruments, all outside the product

No file under `apps/` or `packages/` was modified for any drive below.

<!-- INSTRUMENTS -->

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

