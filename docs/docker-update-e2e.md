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
all four headless targets. The official `ubuntu:24.04` image must already be present; the
gate never pulls or removes a shared base image. It provisions one uniquely labeled seed,
commits one exact run-owned image, and removes both without leaving BuildKit cache. The
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
containers only by the run's unique Docker label, then removes the exact network and
committed image the run created. It never invokes BuildKit, calls `docker system prune`,
creates volumes, or touches an existing image. The final cleanup row goes red if a labeled
object remains. A separate, non-gating host-disk row reports `RESOURCE` if host-wide free
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

## Reading a failing request

Every request the gate makes goes through the helpers in
`scripts/docker-update-e2e/http.sh`, so a refusal names its own subject:

```
[update-e2e] REQUEST FAILED: POST http://127.0.0.1:32772/trpc/repos.add
[update-e2e]   status: 400
[update-e2e]   request body: {"path":"/work/source"}
[update-e2e]   response body:
[update-e2e]   | {"error":{"json":{"message":"machine \"source\" runs no daemon..."}}}
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
```

`tampered` appends a byte to the artifact without changing its signed manifest. `schema`
removes an applied migration from the target. Manifest mutations are followed by a cold
coordinator boot, bypassing the manual-refresh cache. A green exit from either command is
a broken harness, not a successful updater.

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
| Legacy SIGKILL | Explicitly red: source-backed migration evidence is rejected, and black-box packaged-process SIGKILL coverage does not yet span every transition state. |
| Rollback | A second signed manifest proves its schema is identical, then contains an intentionally crashing successor; its canary restores a sentinel available only through `.old`, removes the consumed backup, leaves both installs on the prior version, and reports failure/stuck. |
| Packaged server | A separate all-in-one install updates its server, database migration, web/phone bytes, browser and local-daemon connections through self-handover while retaining the exact abduco shell master PID; a migration-free crashing successor must restore `.old`. |
| Cleanup | No run-labeled container, exact network, or exact harness image remains. |
| Host disk | Reports whether host free space returned within the bounded tolerance after owned cleanup; `RESOURCE` records concurrent host growth without falsely failing cleanup. |

The gate is intentionally Linux/headless. Desktop shell update acceptance remains in
`docs/agents/updater-acceptance.md` and cannot be inferred from this matrix.

This is a privileged, four-platform release gate rather than a routine CI lane. Run it on a
disposable or measured release worker with the documented disk margin.
