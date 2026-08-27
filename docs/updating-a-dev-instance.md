# Updating a development instance

How to move a Podium development authority forward, including the one-time transition from the old
source-run units to the installed single-unit update path. Written after moving `ludovico` onto the
update-operations work (POD-2087), and corrected after the isolated source-to-installed rehearsal
(POD-2894).

## Which first hop applies

A published `0.1.0` headless install is already an installed, persistence-managed instance. It must
take its first hop through its own updater and a release whose headless and desktop manifests have
the same version. That path is supported and proven against the real published artifact; see
[the real-release upgrade investigation](investigations/2026-08-25-real-release-upgrade.md).

The procedure below is only for the handful of development authorities that still run
`scripts/server.ts` and `scripts/daemon.ts` directly from a checkout, have config version 2 with no
`persistence` key, and need to join the installed `podium.service` path. Do not apply it to a
desktop-supervised instance, a named instance without adapting all instance-scoped paths and unit
names, or an existing installed 0.1.0 user.

## The normal path after bootstrap

The live service executes an installed, orderable build. `PODIUM_DEV_SOURCE_ROOT` points at the
protected development checkout only as publisher/build input.

1. Move that checkout forward on its branch.
2. The development publisher builds and advertises the next orderable dev release.
3. Click **Update Podium**. The installed parent performs the verified swap, child handover, health
   gate, and rollback.
4. Reload when the panel asks. That remains the one step it cannot take for you.

The old all-git `dev+<sha>` path and `podium-redeploy.service` are not the bootstrap for the
single-unit topology.

## Before the one-time cutover

Run the whole procedure in one host-local shell, never in a Podium terminal. The source server is
deliberately stopped during the critical section, so recovery must not depend on its data or control
plane. The commands below target the default instance.

    set -eu
    PODIUM_CUTOVER_REPO=$(git rev-parse --show-toplevel)
    PODIUM_CUTOVER_ACCOUNT_HOME=$(getent passwd "$(id -u)" | cut -d: -f6)
    PODIUM_CUTOVER_STATE=$PODIUM_CUTOVER_ACCOUNT_HOME/.podium
    PODIUM_CUTOVER_CONFIG=$PODIUM_CUTOVER_STATE/config.json
    PODIUM_CUTOVER_UNIT_DIR=$PODIUM_CUTOVER_ACCOUNT_HOME/.config/systemd/user
    PODIUM_CUTOVER_DATA=$PODIUM_CUTOVER_ACCOUNT_HOME/.local/share
    PODIUM_CUTOVER_INSTALL=$PODIUM_CUTOVER_DATA/podium
    PODIUM_CUTOVER_BIN_DIR=$PODIUM_CUTOVER_ACCOUNT_HOME/.local/bin
    PODIUM_CUTOVER_PORT=18787
    PODIUM_CUTOVER_URL=http://127.0.0.1:$PODIUM_CUTOVER_PORT
    PODIUM_CUTOVER_MODE=all-in-one
    cd "$PODIUM_CUTOVER_REPO"

If the live units set `PODIUM_STATE_DIR` or a non-default port, replace the defaults above with
those exact values. `all-in-one` is correct when this authority currently runs both the server and
local daemon even if the old config says `server`.

### Boundary 0: prove the source starting point

    PODIUM_CUTOVER_CONFIG=$PODIUM_CUTOVER_CONFIG bun -e '
      const config = await Bun.file(process.env.PODIUM_CUTOVER_CONFIG).json()
      if (config.configVersion !== 2) throw new Error("expected configVersion 2")
      if (Object.hasOwn(config, "persistence")) throw new Error("persistence is already set")
      if (!config.mode) throw new Error("mode is absent")
      console.log(JSON.stringify(config, null, 2))
    '
    curl --fail --silent --show-error "$PODIUM_CUTOVER_URL/readiness"
    curl --fail --silent --show-error "$PODIUM_CUTOVER_URL/version"
    systemctl --user is-active podium-server.service podium-daemon.service

Checkpoint: `/readiness` must be `ready` with both planes available. `/version` must say
`installKind: source` and, for `all-in-one`, `daemonConnected: true`.

Repair: if this checkpoint fails, do not start the cutover. Repair the source server/daemon and
repeat Boundary 0.

## Stage everything while source remains ready

Build a normal orderable bundle. Do not stamp it as `dev+SHA`: source labels cannot seed the
installed dev release sequence.

    test -z "$(git status --porcelain)"
    bun install --frozen-lockfile
    bun run package:headless
    test -x dist-bun/headless/podium
    PODIUM_CUTOVER_VERSION=$(tr -d '\n' < dist-bun/headless/VERSION)
    case "$PODIUM_CUTOVER_VERSION" in
      dev+*) echo "refusing unordered version $PODIUM_CUTOVER_VERSION" >&2; exit 1 ;;
    esac

Capture every legacy definition plus the exact enabled and active sets. The healthy parent removes
legacy files, so the backups—not the live unit directory—are rollback truth.

    PODIUM_CUTOVER_RECOVERY=$PODIUM_CUTOVER_STATE/recovery/source-to-installed-$(date -u +%Y%m%dT%H%M%SZ)
    PODIUM_CUTOVER_LEGACY_UNITS="podium-parent.service podium-server.service podium-janitor.service podium-daemon.service podium-redeploy.service podium-health.service podium-health.timer podium-backend.service podium-daemon-system.service"
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

Preserve prior installed locations, then place the bundle atomically on the same filesystem:

    if [ -e "$PODIUM_CUTOVER_INSTALL" ] || [ -L "$PODIUM_CUTOVER_INSTALL" ]; then
      mv "$PODIUM_CUTOVER_INSTALL" "$PODIUM_CUTOVER_RECOVERY/pre-cutover-install"
    fi
    mkdir -p "$PODIUM_CUTOVER_BIN_DIR" "$PODIUM_CUTOVER_DATA"
    if [ -e "$PODIUM_CUTOVER_BIN_DIR/podium" ] || [ -L "$PODIUM_CUTOVER_BIN_DIR/podium" ]; then
      cp -a "$PODIUM_CUTOVER_BIN_DIR/podium" "$PODIUM_CUTOVER_RECOVERY/pre-cutover-command"
    fi
    PODIUM_CUTOVER_STAGE=$(mktemp -d "$PODIUM_CUTOVER_DATA/.podium-cutover.XXXXXX")
    cp -a dist-bun/headless/. "$PODIUM_CUTOVER_STAGE/"
    test "$(tr -d '\n' < "$PODIUM_CUTOVER_STAGE/VERSION")" = "$PODIUM_CUTOVER_VERSION"
    mv "$PODIUM_CUTOVER_STAGE" "$PODIUM_CUTOVER_INSTALL"
    ln -sfn "$PODIUM_CUTOVER_INSTALL/podium" "$PODIUM_CUTOVER_BIN_DIR/podium"

Render the parent with the actual account and protected checkout; the checked-in generated example
contains placeholder paths.

    PODIUM_CUTOVER_PARENT_STAGE=$PODIUM_CUTOVER_RECOVERY/podium.service
    PODIUM_CUTOVER_HOME=$PODIUM_CUTOVER_ACCOUNT_HOME \
    PODIUM_CUTOVER_REPO=$PODIUM_CUTOVER_REPO \
    PODIUM_CUTOVER_PORT=$PODIUM_CUTOVER_PORT \
    PODIUM_CUTOVER_PARENT_STAGE=$PODIUM_CUTOVER_PARENT_STAGE \
    bun --conditions=@podium/source -e '
      import { writeFileSync } from "node:fs"
      import { renderParentUnit } from "./apps/cli/src/cli-systemd.ts"
      writeFileSync(process.env.PODIUM_CUTOVER_PARENT_STAGE, renderParentUnit({
        profile: "dev",
        instanceId: "default",
        home: process.env.PODIUM_CUTOVER_HOME,
        repoRoot: process.env.PODIUM_CUTOVER_REPO,
        port: Number(process.env.PODIUM_CUTOVER_PORT),
      }))
    '
    grep -F "ExecStart=%h/.local/bin/podium parent --takeover" "$PODIUM_CUTOVER_PARENT_STAGE"
    grep -F "PODIUM_DEV_SOURCE_ROOT=$PODIUM_CUTOVER_REPO" "$PODIUM_CUTOVER_PARENT_STAGE"
    if [ -e "$PODIUM_CUTOVER_UNIT_DIR/podium.service" ]; then
      cp -a "$PODIUM_CUTOVER_UNIT_DIR/podium.service" "$PODIUM_CUTOVER_RECOVERY/pre-cutover-podium.service"
    fi
    install -m 0644 "$PODIUM_CUTOVER_PARENT_STAGE" "$PODIUM_CUTOVER_UNIT_DIR/podium.service"
    systemctl --user daemon-reload
    systemctl --user enable podium.service
    test "$(systemctl --user is-active podium.service 2>/dev/null || true)" != active

### Boundary 1: staged and armed, not started

Repeat both Boundary 0 HTTP checks. The source process must still be ready, `podium.service` must be
enabled but inactive, and the staged `VERSION` must equal `PODIUM_CUTOVER_VERSION`.

Repair: before the source units stop, abort safely by disabling `podium.service`. Restore a prior
install or command from `PODIUM_CUTOVER_RECOVERY` if one existed; config and source units are still
untouched.

## Critical section: stop, write, start

Do not write config while the source server is running. Stop the exact units recorded at Boundary 0,
then runtime-mask all legacy names:

    while IFS= read -r unit; do systemctl --user stop "$unit"; done < "$PODIUM_CUTOVER_RECOVERY/active-units"
    systemctl --user mask --runtime $PODIUM_CUTOVER_LEGACY_UNITS

### Boundary 2: source stopped

The old endpoint should now be unreachable and every unit in `active-units` should be inactive.
That is a deliberate, host-local handover window.

Repair: if any old unit is still active, do not write config. Stop it or run the rollback below.

Atomically preserve every config field while establishing the installed topology:

    PODIUM_CUTOVER_CONFIG=$PODIUM_CUTOVER_CONFIG \
    PODIUM_CUTOVER_MODE=$PODIUM_CUTOVER_MODE \
    bun -e '
      import { chmodSync, renameSync, writeFileSync } from "node:fs"
      const path = process.env.PODIUM_CUTOVER_CONFIG
      const config = await Bun.file(path).json()
      const next = path + ".source-to-installed-next"
      writeFileSync(next, JSON.stringify({
        ...config,
        configVersion: 2,
        mode: process.env.PODIUM_CUTOVER_MODE,
        persistence: "systemd",
      }, null, 2) + "\n", { mode: 0o600 })
      chmodSync(next, 0o600)
      renameSync(next, path)
    '

### Boundary 3: config established, no stale process

Inspect `config.json` and confirm `mode: all-in-one` and `persistence: systemd`.
`podium.service` must still be inactive, and the endpoint must remain unreachable because no old
process is alive to report `activation_pending`.

Repair: if the config is wrong, do not start the parent. Run the rollback below.

Start the already-armed parent:

    systemctl --user --no-block start podium.service

Wait up to 120 seconds for the installed identity and complete topology:

    PODIUM_CUTOVER_URL=$PODIUM_CUTOVER_URL \
    PODIUM_CUTOVER_MODE=$PODIUM_CUTOVER_MODE \
    PODIUM_CUTOVER_VERSION=$PODIUM_CUTOVER_VERSION \
    bun -e '
      const deadline = Date.now() + 120000
      let last = ""
      while (Date.now() < deadline) {
        try {
          const readiness = await fetch(process.env.PODIUM_CUTOVER_URL + "/readiness").then(r => r.json())
          const version = await fetch(process.env.PODIUM_CUTOVER_URL + "/version").then(r => r.json())
          last = JSON.stringify({ readiness, version })
          const daemonOk = process.env.PODIUM_CUTOVER_MODE !== "all-in-one" || version.daemonConnected === true
          if (readiness.state === "ready" &&
              readiness.dataPlane === "available" &&
              version.installKind === "installed" &&
              version.appVersion === process.env.PODIUM_CUTOVER_VERSION &&
              daemonOk) {
            console.log(JSON.stringify({ readiness, version }, null, 2))
            process.exit(0)
          }
        } catch (error) {
          last = String(error)
        }
        await Bun.sleep(250)
      }
      throw new Error("installed parent did not prove ready: " + last)
    '

### Boundary 4: installed parent healthy

`/readiness` must be `ready` with both planes available. `/version` must report
`installKind: installed`, the staged version, and `daemonConnected: true` for `all-in-one`.
`podium.service` must be active and enabled, its main process must run the installed
`podium-cli parent --takeover`, and legacy definitions should be retired.

Repair: if any condition fails, do not hand control back to the data plane. Run the rollback.

## Rollback after Boundary 2

Rollback requires no Podium API. Stop every possible contender before restoring old boot config:

    systemctl --user disable --now podium.service 2>/dev/null || true
    for unit in $PODIUM_CUTOVER_LEGACY_UNITS; do
      systemctl --user stop "$unit" 2>/dev/null || true
    done
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

Rollback checkpoint: `/readiness` must return to `ready`, `/version` must say
`installKind: source`, and the exact prior active set must be active. Restoring config before
stopping the parent/source contenders recreates `activation_pending`; preserve the order above.

## Why the automatic overlap timed out

The rehearsal proved a source-specific runtime seam rather than a generic parent failure:

- `scripts/server.ts` and `scripts/daemon.ts` start through `bootProcess` and never register
  their run-registry roles. The server's fixed port makes that omission fatal during overlap.
- `maskSystemdUnitsRuntime` runtime-masks legacy names but does not stop an already-active unit.
- The installed child starts as `podium server --takeover`. Its `registerProcess` call can reclaim
  only a holder named by the run registry. With no record, it signals nobody, reaches the occupied
  port, exits on `EADDRINUSE`, and is retried.
- The parent never observes a healthy installed server, deliberately withholds `READY=1`, and the
  Type=notify start job times out.

This blocks the automatic overlap choreography for direct source units. It does **not** block the
Ludovico cutover above: Boundary 2 stops those units before config changes or the parent starts.
Published 0.1.0 installed units use the installed CLI role-registration path and retain their
separately proven first hop.

## Why absent boot fields remain divergent

Config version 2 defines absent `persistence` as unmanaged foreground/desktop supervision, not
unknown history. Writing `systemd` changes restart authority and process topology. Ignoring
`undefined -> systemd` would let the old source process claim ready while the file names a different
supervisor, allowing work during a port/restart-owner race. Mode is equally boot-relevant:
`server -> all-in-one` changes which children the parent owns.

The safe answer is therefore to keep absence divergent and ensure no stale process is serving when
the value is established.

## What the rehearsal observed

On 2026-08-27, a private systemd user manager ran the real source server and daemon from
`2595a904f` with config version 2, mode `server`, and no persistence key.

- Writing mode/persistence while source remained live produced `activation_pending`,
  `dataPlane: blocked`, stale `[mode, persistence]`. A deliberately broken parent was rolled back
  to source `ready`.
- The naive mask-and-start parent path timed out for the unregistered-source reason above.
- The stop-write-start path reached installed `0.1.1-edge.2` `ready` in 3.63 seconds, with
  `daemonConnected: true`, active/enabled `podium.service`, retired legacy definitions, and the
  recovery bundle still present.

## Three things that will stop later updates

**A dirty checkout publishes nothing.** Untracked files count. If the panel is silent, check
`git status` first.

**A detached HEAD can never offer an update.** Keep the protected checkout on its branch; remove a
redundant worktree instead of detaching the live one.

**Going backwards is refused.** Once newer migrations run, an older build may not open the database.
Moving forward is effectively one-way without a database restore; see
[Data and upgrades](data-and-upgrades.md).
