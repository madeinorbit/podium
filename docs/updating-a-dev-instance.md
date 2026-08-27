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
