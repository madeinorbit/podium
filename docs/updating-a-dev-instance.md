# Updating a development instance

How to move a Podium development authority forward, including the one-time transition from the old
source units to the installed single-unit update path. Written after moving `ludovico` onto the
update-operations work (POD-2087), then corrected by the source-to-installed rehearsal (POD-2894).

## Which path applies

A published `0.1.0` headless install is already persistence-managed. Its first hop must use its own
updater and a release whose headless and desktop manifests have the same version; see
[the real-release upgrade investigation](investigations/2026-08-25-real-release-upgrade.md).

The exception below is for a development authority whose systemd units run `scripts/server.ts` and
`scripts/daemon.ts` directly. It accepts both source shapes found during this work:

- config version 2, `mode: server`, with no `persistence` key (the isolated rehearsal); or
- config version 2, `mode: server`, `persistence: systemd`, with separate source server and daemon
  units (Ludovico at cutover time).

Do not use it for desktop supervision, detached persistence, named instances without adapting all
instance paths and unit names, or an installed `0.1.0` user.

## The normal path after this cutover

The live service executes an installed, orderable build. `PODIUM_DEV_SOURCE_ROOT` names the protected
checkout only as publisher/build input. Move that checkout forward, approve the dev release, then
accept the ordinary update offer. The installed parent owns swap, handover, health gate, and rollback.

## Build records

Every development release attempt leaves a record in the instance state directory, and the files it
published live with that record rather than in the checkout:

    <stateDir>/builds/<buildId>/
      manifest.json   what was approved, checked, signed and published
      client.json     the coordinator child's own client evidence
      bundles/        podium-headless-<version>-<platform>.tar.gz, plus .sig and .meta.json
      timing.jsonl    how long each step of this attempt took

`<buildId>` is `<stamp>-<sha>` — `20260828T131500Z-2595a90` — so a directory listing is in release
order. `manifest.json` names:

- `approvedSha`, `version`, `platforms` — what the attempt was for.
- `client` — the client root digest, the source commit, and each Turbo task's hash with `HIT` or
  `MISS`. That is the durable answer to "did this release rebuild the clients, or restore them?".
- `artifacts` — per platform, the file name inside `bundles/`, its size, its SHA-256 digest and its
  signature.
- `signingKeyFingerprint` — the update identity that signed it. A record signed under a rotated key
  is never restored, because the fleet could not verify it.
- `outcome` — `validated`, `signed`, `published`, or `failed:<step>` (`failed:verify`,
  `failed:package`, `failed:sign`). An outcome only moves forward, and a failure is terminal: a
  failed attempt is forensics, never something a later step resumes.

To see what this host last published:

    cat ~/.podium/builds/$(ls ~/.podium/builds | tail -1)/manifest.json

Retention keeps the newest two releases plus the one the served feed still names, whatever its age,
and reclaims a whole record — bytes and evidence together — when it goes. A file a retained release
still references is never deleted, which is the property the fleet depends on mid-rollout.

Failed attempts are retained on a window of their own, so a run of failures cannot age out the last
release that worked.

**One-time cleanup on a publisher upgraded to the ledger.** Releases published before this change
are in the checkout's `dist-bun/`, outside the ledger, and nothing sweeps them any more. After the
first successful record appears under `<stateDir>/builds/`, delete them by hand:

    rm -f dist-bun/podium-headless-*.tar.gz dist-bun/podium-headless-*.tar.gz.sig \
          dist-bun/podium-headless-*.tar.gz.meta.json

The feed manifests (`dist-bun/podium-update.json`, `dist-bun/latest.json`) stay where they are:
they are what the checkout's own web server hands out.

## Repair an installed machine stranded before channel-keyed trust

Before POD-2932 there was **no supported out-of-band repair** for this case. `podium update
--repair` is not one: it asks the server for an ordinary grant, so a pre-channel-trust daemon still
downloads the feed and verifies it with the baked release key instead of its pinned instance key.
It fails by construction even when the artifact, signature, metadata fingerprint, and pin are all
correct.

The supported recovery is `scripts/repair-stranded-update.sh`. It is for an already-installed Linux
fleet machine that reports the retired `update.delivery.bundle` capability and is being offered a
development target with `trust: instance`. It does not contact Podium, invoke the installed updater,
or restart a service. It verifies an artifact trio copied onto the host, swaps the installed bundle
on the same filesystem, and retains `<install>.old` for rollback.

Do not use this path for an ordinary bad signature. A metadata fingerprint that differs from
`daemon.json` is a genuinely wrong key and the script refuses it as such. The legacy-build case is
different: the fingerprints match, but that build cannot consult the pin for a feed delivery.

Run the whole target-host part from one host-local SSH or console shell, never a Podium terminal.
Nothing about recovery may depend on the control plane being available after the restart.

### 1. Select and copy the published artifact out of band

On the development publisher host, select the retained artifact for the stranded machine's exact
platform from the build record that published it (see **Build records** above). It must be the
artifact from an approved, orderable development publish such as `0.1.1-dev.3+2595a90`, not a source
package stamped `dev+2595a90`. `manifest.json` in that record names the file and its digest.

    PODIUM_REPAIR_ARTIFACT=~/.podium/builds/20260827T000000Z-2595a90/bundles/podium-headless-0.1.1-dev.3+2595a90-linux-x86_64-20260827T000000Z.tar.gz
    test -r "$PODIUM_REPAIR_ARTIFACT"
    test -r "$PODIUM_REPAIR_ARTIFACT.sig"
    test -r "$PODIUM_REPAIR_ARTIFACT.meta.json"
    scp scripts/repair-stranded-update.sh \
      "$PODIUM_REPAIR_ARTIFACT" \
      "$PODIUM_REPAIR_ARTIFACT.sig" \
      "$PODIUM_REPAIR_ARTIFACT.meta.json" \
      flatblock:/tmp/podium-stranded-repair/

This is an out-of-band file copy from the publisher to the machine. Do not begin with `podium
update`, the feed URL, or `podium update --repair`: those all return to the broken verifier.

### 2. Capture rollback truth while the old process is healthy

On the stranded machine, set explicit paths. These are the defaults for the default instance; for a
named instance use its actual state root and install root.

    set -eu
    PODIUM_REPAIR_INSTANCE=default
    PODIUM_REPAIR_ACCOUNT_HOME=$(getent passwd "$(id -u)" | cut -d: -f6)
    PODIUM_REPAIR_STATE=$PODIUM_REPAIR_ACCOUNT_HOME/.podium
    PODIUM_REPAIR_INSTALL=$PODIUM_REPAIR_ACCOUNT_HOME/.local/share/podium
    PODIUM_REPAIR_UNIT_DIR=$PODIUM_REPAIR_ACCOUNT_HOME/.config/systemd/user
    PODIUM_REPAIR_INPUT=/tmp/podium-stranded-repair
    PODIUM_REPAIR_ARTIFACT=$PODIUM_REPAIR_INPUT/podium-headless-0.1.1-dev.3+2595a90-linux-x86_64-20260827T000000Z.tar.gz
    PODIUM_REPAIR_VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PODIUM_REPAIR_ARTIFACT.meta.json")
    PODIUM_REPAIR_RECOVERY=$PODIUM_REPAIR_STATE/recovery/stranded-update-$(date -u +%Y%m%dT%H%M%SZ)
    mkdir -m 700 -p "$PODIUM_REPAIR_RECOVERY/units"

Capture the identity, config if present, every Podium unit definition, and the exact enabled and
active sets. The script does not change units, but this record keeps recovery independent of memory
and of whichever historical unit topology the machine runs.

    for file in "$PODIUM_REPAIR_STATE/daemon.json" "$PODIUM_REPAIR_STATE/config.json"; do
      test ! -e "$file" || cp -a "$file" "$PODIUM_REPAIR_RECOVERY/"
    done
    : > "$PODIUM_REPAIR_RECOVERY/enabled-units"
    : > "$PODIUM_REPAIR_RECOVERY/active-units"
    for unit_file in "$PODIUM_REPAIR_UNIT_DIR"/podium*.service; do
      test -e "$unit_file" || test -L "$unit_file" || continue
      unit=$(basename "$unit_file")
      cp -a "$unit_file" "$PODIUM_REPAIR_RECOVERY/units/$unit"
      systemctl --user is-enabled --quiet "$unit" 2>/dev/null &&
        printf '%s\n' "$unit" >> "$PODIUM_REPAIR_RECOVERY/enabled-units" || true
      systemctl --user is-active --quiet "$unit" 2>/dev/null &&
        printf '%s\n' "$unit" >> "$PODIUM_REPAIR_RECOVERY/active-units" || true
    done
    test -s "$PODIUM_REPAIR_RECOVERY/active-units"
    test -x "$PODIUM_REPAIR_INSTALL/podium"
    test -r "$PODIUM_REPAIR_STATE/daemon.json"

If `<install>.old` already exists, preserve it with the rest of the evidence before continuing; the
repair script refuses to overwrite a rollback bundle.

    if test -e "$PODIUM_REPAIR_INSTALL.old" || test -L "$PODIUM_REPAIR_INSTALL.old"; then
      mv "$PODIUM_REPAIR_INSTALL.old" "$PODIUM_REPAIR_RECOVERY/pre-existing-install.old"
    fi

### 3. Verify, stage, and swap without stopping the process

The current process remains healthy while the script verifies the metadata digest and size,
compares the metadata fingerprint with the pinned `updatePubkey`, verifies Ed25519 directly against
that pin, checks platform and the orderable version, and extracts into a sibling staging directory.
Only then does it rename the current install to `.old` and promote the staged bundle.

    sh "$PODIUM_REPAIR_INPUT/repair-stranded-update.sh" \
      --artifact "$PODIUM_REPAIR_ARTIFACT" \
      --instance "$PODIUM_REPAIR_INSTANCE" \
      --state-dir "$PODIUM_REPAIR_STATE" \
      --install-dir "$PODIUM_REPAIR_INSTALL"
    test "$(tr -d '\n\r' < "$PODIUM_REPAIR_INSTALL/VERSION")" = "$PODIUM_REPAIR_VERSION"
    test -x "$PODIUM_REPAIR_INSTALL/podium"
    test -d "$PODIUM_REPAIR_INSTALL.old"
    while IFS= read -r unit; do systemctl --user is-active --quiet "$unit"; done < "$PODIUM_REPAIR_RECOVERY/active-units"

The last line proves no service was touched: the old process is still running from its already-open
executable while the new bundle waits at the stable install path.

### 4. Restart only the target's exact prior active set

Restart the recorded active units from the same host-local shell. Do not restart or modify the
publisher/server host.

    while IFS= read -r unit; do systemctl --user restart "$unit"; done < "$PODIUM_REPAIR_RECOVERY/active-units"
    while IFS= read -r unit; do systemctl --user is-active --quiet "$unit"; done < "$PODIUM_REPAIR_RECOVERY/active-units"
    test "$(tr -d '\n\r' < "$PODIUM_REPAIR_INSTALL/VERSION")" = "$PODIUM_REPAIR_VERSION"

From the coordinator, require a fresh handshake that reports the installed target version and no
longer advertises `update.delivery.bundle`. A current build also reports `update.probe.artifact`.
Only after that observation may the operator remove `$PODIUM_REPAIR_INSTALL.old` and the copied
artifact trio. Keep `$PODIUM_REPAIR_RECOVERY` as the audit and rollback record until the machine has
accepted a later ordinary development update.

### Roll back without Podium

If the machine does not reconnect healthy, remain in the same host-local shell and restore the old
bundle before asking the control plane for anything:

    while IFS= read -r unit; do systemctl --user stop "$unit"; done < "$PODIUM_REPAIR_RECOVERY/active-units"
    PODIUM_REPAIR_FAILED=$PODIUM_REPAIR_INSTALL.failed-$(date -u +%Y%m%dT%H%M%SZ)
    mv "$PODIUM_REPAIR_INSTALL" "$PODIUM_REPAIR_FAILED"
    mv "$PODIUM_REPAIR_INSTALL.old" "$PODIUM_REPAIR_INSTALL"
    while IFS= read -r unit; do systemctl --user start "$unit"; done < "$PODIUM_REPAIR_RECOVERY/active-units"
    while IFS= read -r unit; do systemctl --user is-active --quiet "$unit"; done < "$PODIUM_REPAIR_RECOVERY/active-units"

The failed candidate stays beside the install for inspection. The captured config, identity, unit
definitions, and exact enabled/active sets are sufficient to reconstruct the prior target-host state
without touching the publisher.

## One-time source-to-installed cutover

Run this from one host-local shell, never a Podium terminal. The data plane is deliberately down for
one short boundary, so recovery must not depend on Podium. These commands target the default instance
and standard port.

    set -eu
    PODIUM_CUTOVER_REPO=$(git rev-parse --show-toplevel)
    PODIUM_CUTOVER_ACCOUNT_HOME=$(getent passwd "$(id -u)" | cut -d: -f6)
    PODIUM_CUTOVER_STATE=$PODIUM_CUTOVER_ACCOUNT_HOME/.podium
    PODIUM_CUTOVER_CONFIG=$PODIUM_CUTOVER_STATE/config.json
    PODIUM_CUTOVER_UNIT_DIR=$PODIUM_CUTOVER_ACCOUNT_HOME/.config/systemd/user
    PODIUM_CUTOVER_INSTALL=$PODIUM_CUTOVER_ACCOUNT_HOME/.local/share/podium
    PODIUM_CUTOVER_BIN_DIR=$PODIUM_CUTOVER_ACCOUNT_HOME/.local/bin
    PODIUM_CUTOVER_PORT=18787
    PODIUM_CUTOVER_URL=http://127.0.0.1:$PODIUM_CUTOVER_PORT
    PODIUM_CUTOVER_LEGACY_UNITS="podium-parent.service podium-server.service podium-janitor.service podium-daemon.service podium-redeploy.service podium-health.service podium-health.timer podium-backend.service podium-daemon-system.service"
    cd "$PODIUM_CUTOVER_REPO"

If the live units set `PODIUM_STATE_DIR`, `PODIUM_INSTANCE`, or a different port, stop and adapt all
paths, names, and checks before continuing.

### Boundary 0: prove and preserve the source authority

    PODIUM_CUTOVER_CONFIG=$PODIUM_CUTOVER_CONFIG bun -e '
      const config = await Bun.file(process.env.PODIUM_CUTOVER_CONFIG).json()
      if (config.configVersion !== 2) throw new Error("expected configVersion 2")
      if (config.mode !== "server") throw new Error("expected split source mode server")
      if (Object.hasOwn(config, "persistence") && config.persistence !== "systemd") {
        throw new Error("expected persistence absent or systemd")
      }
      console.log(JSON.stringify(config, null, 2))
    '
    curl --fail --silent --show-error "$PODIUM_CUTOVER_URL/readiness"
    curl --fail --silent --show-error "$PODIUM_CUTOVER_URL/version"
    systemctl --user is-active podium-server.service podium-daemon.service

Require readiness `ready` with both planes available, version `installKind: source`, and
`daemonConnected: true`. Repair the source authority first if any check fails.

Capture rollback truth before building. The healthy parent eventually removes legacy definitions.

    PODIUM_CUTOVER_RECOVERY=$PODIUM_CUTOVER_STATE/recovery/source-to-installed-$(date -u +%Y%m%dT%H%M%SZ)
    mkdir -m 700 -p "$PODIUM_CUTOVER_RECOVERY/units"
    cp -a "$PODIUM_CUTOVER_CONFIG" "$PODIUM_CUTOVER_RECOVERY/config.json"
    : > "$PODIUM_CUTOVER_RECOVERY/enabled-units"
    : > "$PODIUM_CUTOVER_RECOVERY/active-units"
    for unit in $PODIUM_CUTOVER_LEGACY_UNITS; do
      if [ -e "$PODIUM_CUTOVER_UNIT_DIR/$unit" ] || [ -L "$PODIUM_CUTOVER_UNIT_DIR/$unit" ]; then
        cp -a "$PODIUM_CUTOVER_UNIT_DIR/$unit" "$PODIUM_CUTOVER_RECOVERY/units/$unit"
      fi
      systemctl --user is-enabled --quiet "$unit" 2>/dev/null &&
        printf '%s\n' "$unit" >> "$PODIUM_CUTOVER_RECOVERY/enabled-units" || true
      systemctl --user is-active --quiet "$unit" 2>/dev/null &&
        printf '%s\n' "$unit" >> "$PODIUM_CUTOVER_RECOVERY/active-units" || true
    done
    test -s "$PODIUM_CUTOVER_RECOVERY/active-units"

### Boundary 1: stage the installed build while source remains ready

    test -z "$(git status --porcelain)"
    bun run package:headless
    test -x dist-bun/headless/podium
    PODIUM_CUTOVER_VERSION=$(tr -d '\n' < dist-bun/headless/VERSION)
    case "$PODIUM_CUTOVER_VERSION" in
      dev+*) echo "refusing unordered version $PODIUM_CUTOVER_VERSION" >&2; exit 1 ;;
    esac
    mkdir -p "$PODIUM_CUTOVER_BIN_DIR" "$(dirname "$PODIUM_CUTOVER_INSTALL")"
    if [ -e "$PODIUM_CUTOVER_INSTALL" ] || [ -L "$PODIUM_CUTOVER_INSTALL" ]; then
      mv "$PODIUM_CUTOVER_INSTALL" "$PODIUM_CUTOVER_RECOVERY/pre-cutover-install"
    fi
    if [ -e "$PODIUM_CUTOVER_BIN_DIR/podium" ] || [ -L "$PODIUM_CUTOVER_BIN_DIR/podium" ]; then
      cp -a "$PODIUM_CUTOVER_BIN_DIR/podium" "$PODIUM_CUTOVER_RECOVERY/pre-cutover-command"
    fi
    PODIUM_CUTOVER_STAGE=$(mktemp -d "$PODIUM_CUTOVER_ACCOUNT_HOME/.local/share/.podium-cutover.XXXXXX")
    cp -a dist-bun/headless/. "$PODIUM_CUTOVER_STAGE/"
    mv "$PODIUM_CUTOVER_STAGE" "$PODIUM_CUTOVER_INSTALL"
    ln -sfn "$PODIUM_CUTOVER_INSTALL/podium" "$PODIUM_CUTOVER_BIN_DIR/podium"

Pre-render the **dev** parent. Bare reconciliation would otherwise render the packaged profile,
which omits `PODIUM_DEV_SOURCE_ROOT` and cannot publish later development releases.

    PODIUM_CUTOVER_PARENT=$PODIUM_CUTOVER_RECOVERY/podium.service
    PODIUM_CUTOVER_ACCOUNT_HOME=$PODIUM_CUTOVER_ACCOUNT_HOME \
    PODIUM_CUTOVER_REPO=$PODIUM_CUTOVER_REPO \
    PODIUM_CUTOVER_PORT=$PODIUM_CUTOVER_PORT \
    PODIUM_CUTOVER_PARENT=$PODIUM_CUTOVER_PARENT \
    bun --conditions=@podium/source -e '
      import { writeFileSync } from "node:fs"
      import { renderParentUnit } from "./apps/cli/src/cli-systemd.ts"
      writeFileSync(process.env.PODIUM_CUTOVER_PARENT, renderParentUnit({
        profile: "dev", instanceId: "default",
        home: process.env.PODIUM_CUTOVER_ACCOUNT_HOME,
        repoRoot: process.env.PODIUM_CUTOVER_REPO,
        port: Number(process.env.PODIUM_CUTOVER_PORT),
      }))
    '
    grep -F "PODIUM_DEV_SOURCE_ROOT=$PODIUM_CUTOVER_REPO" "$PODIUM_CUTOVER_PARENT"
    if [ -e "$PODIUM_CUTOVER_UNIT_DIR/podium.service" ]; then
      cp -a "$PODIUM_CUTOVER_UNIT_DIR/podium.service" "$PODIUM_CUTOVER_RECOVERY/pre-cutover-podium.service"
    fi
    install -m 0644 "$PODIUM_CUTOVER_PARENT" "$PODIUM_CUTOVER_UNIT_DIR/podium.service"
    systemctl --user daemon-reload
    test "$(systemctl --user is-active podium.service 2>/dev/null || true)" != active

Repeat Boundary 0's HTTP checks. Source must remain ready; the staged version must match
`PODIUM_CUTOVER_VERSION`; `podium.service` must be inactive. Before the next boundary, abort by
restoring staged files only: the running source authority is untouched.

### Boundary 2: stop source cleanly

Runtime-mask the legacy names so systemd cannot restart them during the handover, then stop the exact
active source set. Do not write config until all of it is inactive.

    systemctl --user mask --runtime $PODIUM_CUTOVER_LEGACY_UNITS
    while IFS= read -r unit; do systemctl --user stop "$unit"; done < "$PODIUM_CUTOVER_RECOVERY/active-units"
    while IFS= read -r unit; do systemctl --user is-active --quiet "$unit" && exit 1 || true; done < "$PODIUM_CUTOVER_RECOVERY/active-units"
    curl --fail --silent "$PODIUM_CUTOVER_URL/readiness" && exit 1 || true

Checkpoint: the exact prior active set is inactive and the endpoint is unreachable. If either is
false, stop and run rollback without changing config.

### Boundary 3: establish installed topology

Atomically change process topology. For Ludovico this changes only `mode`; for the rehearsed older
shape it also establishes `persistence`.

    PODIUM_CUTOVER_CONFIG=$PODIUM_CUTOVER_CONFIG bun -e '
      import { chmodSync, renameSync, writeFileSync } from "node:fs"
      const path = process.env.PODIUM_CUTOVER_CONFIG
      const config = await Bun.file(path).json()
      const next = path + ".source-to-installed-next"
      writeFileSync(next, JSON.stringify({
        ...config, configVersion: 2, mode: "all-in-one", persistence: "systemd",
      }, null, 2) + "\n", { mode: 0o600 })
      chmodSync(next, 0o600)
      renameSync(next, path)
    '

Checkpoint: config says `mode: all-in-one` and `persistence: systemd`, the source set remains
inactive, `podium.service` is inactive, and the endpoint remains unreachable. If any condition is
false, do not start the parent; run rollback.

### Boundary 4: reconcile and accept the installed authority

Invoke the installed CLI once. Because the old units are stopped and the correct dev parent is
already present, reconciliation can safely enable the parent, runtime-mask legacy units, and start
it. It must not be invoked before the stop boundary.

    "$PODIUM_CUTOVER_BIN_DIR/podium"

Wait up to 120 seconds, then require readiness `ready`, both planes available, the staged installed
version, and its daemon connection:

    PODIUM_CUTOVER_URL=$PODIUM_CUTOVER_URL PODIUM_CUTOVER_VERSION=$PODIUM_CUTOVER_VERSION bun -e '
      const deadline = Date.now() + 120000
      let last = ""
      while (Date.now() < deadline) {
        try {
          const readiness = await fetch(process.env.PODIUM_CUTOVER_URL + "/readiness").then(r => r.json())
          const version = await fetch(process.env.PODIUM_CUTOVER_URL + "/version").then(r => r.json())
          last = JSON.stringify({ readiness, version })
          if (readiness.state === "ready" && readiness.dataPlane === "available" &&
              version.installKind === "installed" &&
              version.appVersion === process.env.PODIUM_CUTOVER_VERSION &&
              version.daemonConnected === true) process.exit(0)
        } catch (error) { last = String(error) }
        await Bun.sleep(250)
      }
      throw new Error("installed parent did not prove ready: " + last)
    '
    systemctl --user is-active podium.service
    systemctl --user is-enabled podium.service

The healthy parent may now retire legacy definitions. If any checkpoint fails, use host-local
rollback before returning control to operators.

## Rollback after the source stop

Stop every contender before restoring boot config and old units:

    systemctl --user disable --now podium.service 2>/dev/null || true
    for unit in $PODIUM_CUTOVER_LEGACY_UNITS; do systemctl --user stop "$unit" 2>/dev/null || true; done
    cp -a "$PODIUM_CUTOVER_RECOVERY/config.json" "$PODIUM_CUTOVER_CONFIG.rollback-next"
    mv "$PODIUM_CUTOVER_CONFIG.rollback-next" "$PODIUM_CUTOVER_CONFIG"
    if [ -e "$PODIUM_CUTOVER_RECOVERY/pre-cutover-podium.service" ]; then
      cp -a "$PODIUM_CUTOVER_RECOVERY/pre-cutover-podium.service" "$PODIUM_CUTOVER_UNIT_DIR/podium.service"
    else
      rm -f "$PODIUM_CUTOVER_UNIT_DIR/podium.service"
    fi
    for saved in "$PODIUM_CUTOVER_RECOVERY"/units/*; do
      test -e "$saved" || continue
      cp -a "$saved" "$PODIUM_CUTOVER_UNIT_DIR/$(basename "$saved")"
    done
    systemctl --user daemon-reload
    systemctl --user unmask $PODIUM_CUTOVER_LEGACY_UNITS 2>/dev/null || true
    while IFS= read -r unit; do systemctl --user enable "$unit"; done < "$PODIUM_CUTOVER_RECOVERY/enabled-units"
    while IFS= read -r unit; do systemctl --user start "$unit"; done < "$PODIUM_CUTOVER_RECOVERY/active-units"

Require source readiness `ready`, `installKind: source`, `daemonConnected: true`, and the exact prior
active set. Restoring config before stopping contenders can recreate `activation_pending`; preserve
the order above.

## Why ordinary reconciliation is not the live-overlap path

`scripts/server.ts` and `scripts/daemon.ts` never register run-registry roles. Reconciliation
runtime-masks their systemd units, but masking does not stop an already-active process. The new
parent's `podium server --takeover` therefore cannot signal the old server, hits `EADDRINUSE`, and
the Type=notify parent eventually times out. With `mode: server`, it would also omit the daemon.

Stopping the direct source units first removes both defects. Reconciliation is safe after that
boundary, and its health-gated retirement remains useful.

An absent boot-relevant field must still count as divergence. In config version 2, absent
`persistence` means unmanaged supervision; writing `systemd` changes restart authority. Treating it
as unchanged would let an old process report ready while the file names a different supervisor.

The isolated rehearsal started from missing persistence and proved the dangerous write produced
`activation_pending` with a blocked data plane, forced a failed-parent rollback, and then reached an
installed `0.1.1-edge.2` authority in 3.63 seconds through stop-write-start. Ludovico's current
systemd-persistence shape removes the persistence change, but not the required stop or mode change.

## Three things that stop later updates

**A dirty checkout publishes nothing.** Untracked files count; check `git status`.

**A detached HEAD offers nothing.** Keep the protected checkout on its branch.

**Going backwards is refused.** After newer migrations run, recover from a database backup or roll
forward; see [Data and upgrades](data-and-upgrades.md).
