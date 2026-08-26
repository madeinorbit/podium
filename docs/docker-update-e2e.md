# Fresh-machine update gate

`bun run test:update-e2e` is the release-completion gate for the headless updater. It
creates one server-only source coordinator and two clean Ubuntu 24.04 consumers on a
private Docker network, installs the consumers through `install.sh`, publishes a signed
development release, observes the rendered browser offer, accepts its `Update Podium`
button, and observes the canary, widening, self-handover, refusal, migration, and
rollback boundaries.

The instance is always named `update-e2e` (or another non-default value supplied through
`PODIUM_UPDATE_E2E_INSTANCE`). The source checkout is cloned into the coordinator; no
consumer executes from a checkout. The script proves that workspace package resolution
stays inside that clone before it trusts any build output.

## Run it

```bash
bun run test:update-e2e
```

The command needs Docker, Bun, Git, curl, jq, OpenSSL, Zig, rcodesign, an installed
Playwright Chromium, and at least 10 GiB free on both the worktree and Docker-data
filesystems. Zig and rcodesign are
mounted read-only into the source builder because the production publisher cross-builds
all four headless targets. The gate never pulls or removes a shared base image. It
provisions one uniquely labeled seed, and removes it, without leaving BuildKit cache. The
command refuses before creating a Docker object when either disk floor is not met. Raise
the floor when the release host needs more safety margin:

```bash
PODIUM_UPDATE_E2E_MIN_FREE_GB=14 bun run test:update-e2e
```

The focused packaged-server lane has a measured 2.0 GiB expected peak and a
2.5 GiB safe-capacity estimate. Its default remains 10 GiB, but an operator who
has accounted for competing workloads may lower only that focused lane as far
as 2 GiB; every disk checkpoint remains active:

```bash
PODIUM_UPDATE_E2E_MIN_FREE_GB=2 bun run test:update-e2e:server
```

Preserve bounded journals and the matrix when collecting release evidence:

```bash
PODIUM_UPDATE_E2E_OUTPUT_DIR=/path/on-a-roomy-disk/update-e2e-evidence \
  bun run test:update-e2e
```

Ordinary runs rely on stdout/CI capture and remove their scratch files. Preserved evidence
also includes the rendered offer and post-rollout version-display screenshots. The gate
rechecks its disk margin after every build, rollout, and rollback boundary. Cleanup selects
containers only by the run's unique Docker label, then removes the exact network and the
image tag the run created. It never invokes BuildKit, calls `docker system prune`, or
creates volumes. The final cleanup row goes red if a labeled object remains.

### The provisioned base image is cached

`prepare_image` has never used `docker build`, so it has never had a layer cache — that
exists only for `build`, not for `commit`. It used to provision a bare Ubuntu and commit
the result to a tag unique to the run, which cleanup then deleted, so every run paid the
full apt install of a compiler toolchain that never changes: 635 lines of output before
the first meaningful step, and nothing reusable even in principle.

The provisioned layer is now content-addressed. It is tagged
`podium-update-e2e-base:<hash>`, where the hash covers `provision.sh`, the base OS image,
the invoking uid and gid, and the image config the commit bakes on. It is built only when
that tag is absent. The uid and gid are in the key because provisioning bakes ownership
in — `provision.sh` creates the `podium` account from the two arguments it is handed — so
a cache keyed without them would hand a second user an image whose bind-mounted evidence
they cannot write.

What the gate needs fresh is the **Podium install**, not the base OS. POD-2565 (a clean
named-instance install that could not start) was findable only on a machine with no prior
install, and every unit test passed straight over it. No assertion depends on gcc and the
apt layer being newly provisioned.

Measured on one host, driving the real `prepare_image`:

| | wall clock | apt output lines |
| --- | --- | --- |
| first run, cold | 37.4s | 334 |
| second run, unchanged `provision.sh` | 0.1s | 0 |
| after one byte changes in `provision.sh` | 34.8s | 334 |

**Cleanup did not have to be weakened to get this.** `$IMAGE` is still the run-scoped tag;
the cached base is merely tagged into it, and removing one of two tags that share an image
id removes only that tag. Cleanup removes `$IMAGE` and asserts it is gone exactly as
before. The shared base carries no run label, is owned by no run, and survives on purpose
— the same way a pulled `ubuntu:24.04` does.

Force a rebuild when a cached layer is suspect for a reason the hash cannot see, such as
an `ubuntu:24.04` that moved underneath its own tag:

```bash
PODIUM_UPDATE_E2E_REBUILD_BASE=1 bun run test:update-e2e
```

The OS image must be present locally only for a run that will actually provision; one
served by the cache does not need it and is not refused for its absence. A separate, non-gating host-disk row reports `RESOURCE` if host-wide free
space does not return within the documented tolerance; concurrent usage is not attributed
to the harness after all of its exact objects are gone.

## Manual hold lane

To drive both the publisher and consumer decisions by hand on the same cold
topology as the gate, run:

```bash
PODIUM_UPDATE_E2E_HOLD=proposal bun run test:update-e2e
```

Hold mode installs the source coordinator and two clean Ubuntu consumers, pairs both
consumers, leaves a development release proposal pending, and returns without approving,
building, publishing, accepting, or cleaning up. In **Settings → Updates**, review the
listed commits and migration warning, approve the proposal to start the heavy build, watch
the build and publication state, and then accept the resulting offer. The bootstrap bundle
needed to create the cold machines is still built automatically; the proposed release is
not.

To retain the earlier consumer-only rehearsal, where the harness publishes a verified
signed release before stopping, use:

```bash
PODIUM_UPDATE_E2E_HOLD=published bun run test:update-e2e
```

`PODIUM_UPDATE_E2E_HOLD=1` remains an alias for `published`. Both modes default the
packaged source to `worktree-pod-2462-update-path`; use
`PODIUM_UPDATE_E2E_HOLD_REF=<ref>` only when a specific integrated candidate must be
exercised.

The final output prints the host-only URL and, when Tailscale is available, a URL bound
only to the host's Tailnet IPv4 address. It also prints authentication status, proposal or
published version, one `docker exec` command per container, and a one-line teardown scoped
to that run's exact label, network, image, and scratch directory. The containers and scratch
data deliberately consume disk until that printed teardown succeeds. Hold mode is
diagnostic and never substitutes for the complete matrix or either deliberate-red control.

The source coordinator is intentionally server-only, so it does not advertise a local coding
agent and a new browser's ordinary onboarding stops at **Set up your agents**. For an
update-only rehearsal, use the printed diagnostic entry URL and press **Finish setup**. That
URL selects the same final activation route used by the automated updater probe; it bypasses
agent selection and therefore proves nothing about agent installation or onboarding.

## Put a new version into a sandbox that is already running

Testing a new version used to mean tearing the hold down and running the gate again, which
rebuilt a whole container image to change one binary. Caching the base image removed most
of that wait, but not the shape of the mistake: this epic exists to prove that a **running
install takes a new version in place**, so a sandbox that has to be rebuilt to change its
version was never using the mechanism the gate proves.

`scripts/docker-update-e2e-revise.sh` addresses a hold that is already standing and puts a
new version into it through the product path:

```bash
PODIUM_UPDATE_E2E_PASSWORD=<the run's password> \
  scripts/docker-update-e2e-revise.sh --run <RUN_ID> --ref <git-ref>
```

`RUN_ID` is the `Run label:` value the hold printed, minus the label key. The tool moves
the source the coordinator watches onto `--ref`, waits for the development release
proposal that names that commit, checks it against the same HEAD/version identity contract
the `dev-release` row asserts, approves it, and waits for the offer to reach the fleet.
Nothing is rebuilt and nothing restarts that the updater would not itself restart. The
fetch costs no copying: `/input` is still mounted and the clone was made `--local
--shared`, so the objects are already reachable.

By default the offer is left **pending**, because that is the state a sandbox is usually
for — every machine still runs what it ran before, and you accept from the running UI. Add
`--accept` to have the tool drive the acceptance itself through `updates.start`, the same
call the UI's Update button makes, and wait for the fleet to install the new version.

It borrows `rpc`, `container_exec`, `wait_for`, the authenticated session handling and the
identity contract from the gate by sourcing it rather than reimplementing any of them.
That contract has drifted from a second copy before (POD-2747), so it has one
implementation.

### The bundle swap, and why it is not the default

```bash
scripts/docker-update-e2e-revise.sh --run <RUN_ID> \
  --swap-bundle <tarball> --into <container>
```

This writes an install directory from a tarball with no grant, no signature check by the
running product, and no operation recorded. It is not a way to deliver a version. It is a
way to **construct a starting state the updater would never legitimately produce** — a
machine pinned to an old build, a deliberately mismatched pair — so that a real update can
then be driven from it. A swapped install proves nothing about the update path, and the
tool says so out loud when it runs.

## Reading a failing request

Every request the gate makes goes through the helpers in
`scripts/docker-update-e2e/http.sh`, so a refusal names its own subject:

```
[update-e2e] REQUEST FAILED: POST http://127.0.0.1:32772/trpc/repos.add
[update-e2e]   status: 400
[update-e2e]   request body: {"path":"/work/source"}
[update-e2e]   response body:
  | {"error":{"json":{"message":"machine \"source\" runs no daemon..."}}}
[update-e2e]   refusal: machine "source" runs no daemon and cannot host a repo
```

No request may use `curl -f`. That flag is why a 400 once surfaced only as
`curl: (22) The requested URL returned error: 400`: it names no URL, and it
discards the response body, which is where a tRPC refusal explains itself.
`scripts/docker-update-e2e-http.test.ts` enforces both halves.

Readiness polling uses `http_probe` instead, which is silent on purpose — a
non-2xx is the expected answer while a service is still coming up, and `wait_for`
already names the label and the last output when it gives up.

## Prove the gate can fail

The negative-control modes deliberately leave a production input broken and then run the
ordinary positive rollout assertion. They must exit non-zero with a red matrix:

```bash
PODIUM_UPDATE_E2E_PROVE_FAILURE=tampered bun run test:update-e2e
PODIUM_UPDATE_E2E_PROVE_FAILURE=schema bun run test:update-e2e
PODIUM_UPDATE_E2E_PROVE_FAILURE=canary bun run test:update-e2e
```

`tampered` appends a byte to the artifact without changing its signed manifest. `schema`
removes an applied migration from the target. Manifest mutations are followed by a cold
coordinator boot, bypassing the manual-refresh cache. A green exit from either command is
a broken harness, not a successful updater.

`canary` is the odd one out, and deliberately: the update it produces SUCCEEDS. It patches
the source the bootstrap coordinator is built from — before that build, because that
coordinator is the one that plans the wave — so every rollout starts with the canary
already proved and the first round widens to the whole fleet at once. The machines
converge, the versions land, the handovers happen; only the shape of the wave changes.
`rollout` must go red naming the rounds it read.

## What `rollout` actually checks

The row's claim is that exactly one machine converged before the rest. It used to prove
that by sampling `updates.fleet` every hundred milliseconds and setting a flag if a sample
happened to catch one machine in flight while the others were still on the old version.
That state is transient, and a sampling observer cannot prove a transient fact: when the
update ran fast the window closed before the first sample landed, and a correctly gated
wave was failed for it. The row flipped about one run in three.

The product now writes the wave down. Every round of grants an update issues is appended
to the operation's own durable `details.waveRounds` as it happens — when, which gate
produced it (`canary` or `widen`), what it granted, and every machine it held back with
the reason from a closed set (`canary-gated`, `wave-full`, `offline`, `already-current`,
`in-flight`, `terminal-verdict`, `source-checkout`). The row reads that record out of
`operations.history` once the operation is done and asks four things of it:

- the first round of this operation's wave ran under the `canary` gate;
- it granted exactly one machine;
- it held at least one other machine `canary-gated` — eligible, and kept back only because
  nothing had proved the bundle yet, which is what stops a single-machine fleet passing a
  row about ordering between machines;
- and a later round granted every machine that first round held, which is the widening.

The fleet sampling stays and is no longer part of the verdict: `logs/rollout-transitions.ndjson`
is how a human reads back what the fleet did. The rounds themselves are preserved as
`logs/rollout-wave-rounds.json`.

## Focused legacy lane

While release minting is blocked, the independent packaged legacy migration can be
exercised without pretending the remaining matrix ran:

```bash
PODIUM_UPDATE_E2E_ONLY=legacy PODIUM_UPDATE_E2E_OUTPUT_DIR=.tmp/update-e2e-legacy bun run test:update-e2e
```

This lane intentionally exits red until packaged per-transition SIGKILL coverage exists;
a passing migration row must not mask that named gap.

## Focused positive lane

When a refusal fixture or its durable grants would obscure a later rollout diagnosis, run
the positive path on an otherwise identical cold topology:

```bash
PODIUM_UPDATE_E2E_ONLY=positive PODIUM_UPDATE_E2E_OUTPUT_DIR=.tmp/update-e2e-positive bun run test:update-e2e
```

This lane covers the real offer, UI acceptance, canary and widening, self-handover,
same-PID durable sessions, and rollback. It marks all three refusal rows `BLOCKED`; it is
diagnostic evidence only and never substitutes for the complete matrix or either
deliberate-red command.

## Packaged server lane

The ordinary fleet rows update two packaged daemon-only consumers. The focused server
lane covers the production all-in-one shape separately:

```bash
bun run test:update-e2e:server
```

It installs a clean Ubuntu machine from the signed bootstrap bundle and keeps that
machine all-in-one: its parent owns a packaged server, its database, its local daemon, and
the in-server janitor worker. The checkout container is a build host only and is never the
update target. Because joining an all-in-one install to the source coordinator would
correctly convert it to daemon-only, the server resolves the unmodified production
`edge` channel through a run-local HTTPS feed. The throwaway bootstrap and release embed
an ephemeral release trust root; no repository key, public feed, live instance, or
existing Docker object is changed.

The lane asserts that fresh web and phone build stamps move with the server, a real
migration is both materialized and recorded in `__drizzle_migrations`, a browser
WebSocket and the local daemon reconnect at the target version, the parent changes PID
inside the same systemd invocation, and the exact attached abduco shell master PID
survives. The clean containers do not install Codex, Claude, or another coding-agent
CLI, so this proves process/session preservation at Podium's abduco boundary; it does
not claim that a real coding-agent harness was exercised.
It then offers a separately signed, migration-free bundle whose packaged launcher exits
97, proves that bundle was swapped in, and requires `.old` to restore the prior healthy
server with a named failed operation.

Each new boundary has an armed negative control. Every command below must exit nonzero
and name its own red row:

```bash
PODIUM_UPDATE_E2E_ONLY=server PODIUM_UPDATE_E2E_PROVE_FAILURE=server-assets bun run test:update-e2e
PODIUM_UPDATE_E2E_ONLY=server PODIUM_UPDATE_E2E_PROVE_FAILURE=server-migration bun run test:update-e2e
PODIUM_UPDATE_E2E_ONLY=server PODIUM_UPDATE_E2E_PROVE_FAILURE=server-client bun run test:update-e2e
PODIUM_UPDATE_E2E_ONLY=server PODIUM_UPDATE_E2E_PROVE_FAILURE=server-handover bun run test:update-e2e
PODIUM_UPDATE_E2E_ONLY=server PODIUM_UPDATE_E2E_PROVE_FAILURE=server-agent bun run test:update-e2e
PODIUM_UPDATE_E2E_ONLY=server PODIUM_UPDATE_E2E_PROVE_FAILURE=server-rollback bun run test:update-e2e
```

This focused lane retains the 10 GiB floor. Its measured steady-state footprint is about
1.2 GiB, but the fresh client and packaged release build is the peak-risk boundary; do
not infer that 1.2 GiB of free disk is sufficient.

## Real-release lane

> The commands here invoke the script directly. The `bun run test:update-e2e` form used
> elsewhere in this document does not resolve on this branch — `package.json` defines no
> such script — so those are documented but not runnable as written.

Every other lane in this gate starts at current source. This one starts at a **real
published release** and lets that release's own updater perform the first hop:

```bash
PODIUM_UPDATE_E2E_ONLY=real-release bash scripts/docker-update-e2e.sh
```

It downloads the published `v0.1.0` headless tarball, verifies it against the
**production** release key — which is what proves these are the published bytes and not a
rebuild — installs it with the real `v0.1.0` `install.sh`, and lets `v0.1.0`'s own code
write its own systemd units, database and config. It then serves a release built from this
checkout at the URL a `stable` install actually fetches, and asserts the machine converges
onto the single-unit topology with its data intact.

### Why this lane exists

`legacy-migration` looks like it covers this and does not. It renders a three-unit layout
from today's `cli-systemd` and watches today's binary migrate it, so it proves our *idea*
of an old install migrates. The component that performs the first hop for every existing
user — the old updater — never runs in it.

The difference is not theoretical. Diffing what real `0.1.0` wrote against
`render-legacy-units.ts` shows the fixture adds an `Environment=PODIUM_PORT` line that
`0.1.0` never wrote, and omits the `--server` arguments it did. `reconcileSupervision`
renders the new parent unit with `resolvePort()`, which reads `PODIUM_PORT` first — so
against the fixture it always finds the port in the unit env, while a real install (no
`PODIUM_PORT`, no `port` in config) falls through to the per-instance default. The fixture
therefore cannot reach the resolution path a real install takes.

Be precise about how much that currently costs: for the **default** instance both paths
land on 18787, so today the divergence is latent rather than user-visible. It matters
because the fixture is silently pinning a value the real thing derives — the next change to
port resolution would be exercised only on the branch no user is on. Whether a released
0.1.0 that was set up on a *custom* port keeps it is a separate question this lane does not
answer; `setup.complete` was observed not to persist `port` at all.

Every run records the diff at `logs/real-release-fixture-drift.diff`.

### The one deviation, and how it is bounded

`v0.1.0` bakes `PODIUM_UPDATE_PUBKEY` as a module constant with no environment override,
so a real published binary installs only artifacts signed by the production release key.
No test has that key and none should. The lane substitutes that one 60-character base64
field inside `podium-cli`, in place:

- refused unless the constant appears **exactly once** (`patch-trust-root.ts`);
- refused if the replacement is a different length, which would move every offset;
- the measured byte delta is asserted to fall inside the constant, and the row's evidence
  string names it.

This is the same isolation the packaged-server lane performs by patching
`update-delivery.ts` and rebuilding, applied to a real artifact instead of a rebuild. It
says nothing about migration, topology, schema or units — the four things the lane asserts
on.

### Why this lane runs the default instance

Every other row runs a named instance for isolation. This one must not, for two reasons
found by running the real artifact:

- A real `0.1.0` **cannot complete a named-instance install**. It materializes its embedded
  abduco into the instance state directory before it claims that directory, then refuses to
  adopt the now non-empty root, so the channel is never persisted and every later command
  refuses. (Fixed in current code.)
- A named instance also resolves a different port, because `defaultInstancePorts` hashes the
  id while a released install carries no `port` in config and no `PODIUM_PORT` in its units.
  Pinning the port with an environment variable to paper over that would reintroduce the
  fixture's central untruth into the row written to replace it.

The container is disposable, so the isolation a named instance buys is worth nothing here.

### The pairing refusal is part of the row

Before it proves the upgrade works, the lane proves the old resolver is really the thing
answering: it first serves a desktop manifest at a **different** version. `v0.1.0` requires
exact version equality between `podium-update.json` and `latest.json` on every channel,
including a headless Linux server that will never run a shell, so the real binary refuses
the whole target and names the pairing. Repairing the manifest to the matching version is
what makes the target appear.

That refusal is the stranding recorded on POD-2789: a headless-only release, or an edge
release whose shell has stopped moving in lockstep, is invisible to every `0.1.0` install
in the field. The row keeps it reproduced by the old code rather than argued from source.

### Prove it can fail

```bash
PODIUM_UPDATE_E2E_ONLY=real-release PODIUM_UPDATE_E2E_PROVE_FAILURE=real-release-migration \
  bash scripts/docker-update-e2e.sh
```

This makes the parent unit's path a directory, so `reconcileSupervision`'s one write fails,
the legacy units never retire, and `real-release-converged` must go red. Nothing else is
touched, so a red can only be the migration.

### Options

| Variable | Meaning |
| --- | --- |
| `PODIUM_UPDATE_E2E_REAL_RELEASE=X.Y.Z` | which published release to start from (default `0.1.0`) |
| `PODIUM_UPDATE_E2E_REAL_RELEASE_CACHE=PATH` | a directory already holding that release's tarball, `.sig` and `install.sh`, so the run does not re-download 54 MiB |

## Rows with no result

A `SKIP` row asserts nothing, and its evidence column says which of three things
happened — they are deliberately worded so they cannot be mistaken for each other:

| Evidence reads | What it means |
| --- | --- |
| `out of scope for PODIUM_UPDATE_E2E_ONLY=<lane>` | The focused lane never runs this row. Nothing went wrong. The complete matrix still prints the row so a failure in it has somewhere to land. |
| `not reached after <row> failed` | A real red stopped the run before this row. `<row>` is the one that failed. |
| `not reached: the run was INTERRUPTED (SIG…) …` | The run was killed. The table also carries an `*** INTERRUPTED ***` banner above it and the run exits 130/143/129, so a partial matrix is never mistaken for a finished one. |
| `not reached: the run aborted before this row — <reason>` | The harness stopped itself for a reason no row owns: a missing tool, a breached disk floor. |
| `HARNESS BUG: …` | A row was neither run nor excluded and nothing failed. The harness has lost track of one of its own rows; the run exits nonzero rather than reporting a pass it cannot explain. |

Until POD-2813 every one of these printed `not reached after an earlier failure`, so a
clean focused lane and a run that died halfway read identically.

## What the matrix means

| Row | Programmatic evidence |
| --- | --- |
| Environment | Setup is complete before updater checks; the cross-built and exact packaged/materialized `abduco` binaries execute, every container has `gzip`, and the packaged mobile dist contains precompressed assets. |
| Fresh install | `install.sh` claims the named state identity, persists the channel, and creates one named parent unit; identity and channel are reported independently and the full installer/setup transcript is preserved. Its only OS children are server and daemon, and janitor has no unit/process because it is a server worker. |
| Diagnostic version | The packaged `--version` command must print the exact build version even when pointed at a foreign non-empty state root, and must not adopt or mark that root. The row records a failure without short-circuiting later update scenarios. |
| Fleet join | Two independently installed parents pair, each has exactly one daemon child, daemon mode config, no local server, and an accurate advertised version. |
| Fleet join refusal | A third fresh container replays an already-consumed join credential; installation must exit nonzero, name the authentication refusal, and never print the joined-success message. |
| Version display | Baseline and post-update Playwright probes compare rendered component and machine versions with the version endpoints and served client stamps. Failure evidence includes screenshot, URL, body text, stdout, and stderr, and this row cannot suppress release or refusal execution. |
| Dev release | An administrator-equivalent approval binds HEAD+version and publishes a signed `podium-update.json` pulled back through the dev resolver. |
| Schema/tampered/unsigned refusals | Each mutation proves its premise first: exactly one migration removed, signature field removed, or served artifact digest changed. The refusal is named and neither on-disk `VERSION` changes. |
| Agent survival | Real remote shells are created after refusal checks. The harness discovers the packaged bounded socket root, records each abduco listing, captures the exact attached master PID for every full session UUID, and requires the same PIDs after handover. The containers do not install a real coding-agent CLI, so this is abduco session/process survival evidence, not a Codex/Claude harness claim. A setup failure blocks only this row and does not suppress release, refusal, or rollout evidence. |
| Rollout | Playwright sees the target offer and presses its human action. Polling observes exactly one consumer in-flight while the other is still old and ungranted before widening; both parent PIDs change while the systemd invocation and restart count do not, baseline and post-rollout UI versions match the source and fleet, and both install/fleet versions reach the target. |
| Legacy migration | Real packaged three-unit files remain live and persistently enabled while an injected packaged parent repeatedly fails, then converge after recovery. |
| Real-release install | The published `v0.1.0` tarball verifies against the **production** release key before anything touches it; its own `install.sh` installs it with one re-anchored trust-root constant, refused unless that constant appears exactly once and asserted to have changed nothing outside it; `0.1.0`'s own code then writes its era's three-unit layout, and the diff against the rendered fixture is recorded. |
| Real-release pairing refusal | With the desktop manifest at a different version, the real `0.1.0` resolver refuses the whole target and names the desktop pairing — POD-2789 reproduced by the released code rather than argued from source. Also the proof that the feed is reaching the old resolver at all, so a later green cannot be a row wired to nothing. |
| Real-release resolve | Repairing the desktop manifest to the matching version makes the same install offer the target, read through the `releases/latest/download/` URL a released `stable` install actually fetches. |
| Real-release converged | A real published install, upgraded **by its own updater**, ends with exactly the parent unit and no legacy units, active and enabled, at the target version, with its pre-upgrade session row and database row intact. |
| Legacy SIGKILL | Explicitly red: source-backed migration evidence is rejected, and black-box packaged-process SIGKILL coverage does not yet span every transition state. |
| Rollback | A second signed manifest proves its schema is identical, then contains an intentionally crashing successor; its canary restores a sentinel available only through `.old`, removes the consumed backup, leaves both installs on the prior version, and reports failure/stuck. |
| Packaged server | A separate all-in-one install updates its server, database migration, web/phone bytes, browser and local-daemon connections through self-handover while retaining the exact abduco shell master PID; a migration-free crashing successor must restore `.old`. |
| Cleanup | No run-labeled container, exact network, or exact harness image remains. |
| Host disk | Reports whether host free space returned within the bounded tolerance after owned cleanup; `RESOURCE` records concurrent host growth without falsely failing cleanup. |

The gate is intentionally Linux/headless. Desktop shell update acceptance remains in
`docs/agents/updater-acceptance.md` and cannot be inferred from this matrix.

This is a privileged, four-platform release gate rather than a routine CI lane. Run it on a
disposable or measured release worker with the documented disk margin.
