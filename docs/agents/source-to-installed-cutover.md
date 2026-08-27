# Source-to-installed development cutover

This is the one-time Linux transition for a development instance that currently runs the server
and daemon from a source checkout and whose config has no persistence field. It installs the
single-unit podium.service topology without relying on the running Podium control plane.

Use one host-local shell for the whole procedure. Do not run the critical section through a Podium
terminal: the old server is deliberately stopped during handover. Do not use this guide for a
desktop-supervised instance, a detached instance, or a named instance without first adapting every
state path, command name, and unit name as described in docs/multi-instance.md.

## Safety model

The safe order is:

1. Build and stage the installed bundle, parent unit, config backup, unit backups, and exact
   enabled/active-unit manifests while the source instance remains ready.
2. Enable, but do not start, the new parent unit.
3. In one host-local shell, stop the old units, runtime-mask them, atomically write the new
   boot-relevant config, and immediately start the parent.
4. Accept the cutover only after /readiness and /version prove the installed server and daemon.
5. If the parent does not prove ready, stop it and restore the config and source units from the
   already-local recovery directory.

Stopping the source units before writing config is intentional. Merely runtime-masking active units
does not close their Restart=always race after the installed child takes the port. Writing config
while the source server remains alive is also unsafe: it reports activation_pending and blocks the
data plane. The host-local shell and recovery directory are therefore the control path throughout.

## 1. Establish the starting shape

The commands below target the default instance. Start in the checkout that will remain the
PODIUM_DEV_SOURCE_ROOT build input.

    set -eu
    PODIUM_CUTOVER_REPO=$(git rev-parse --show-toplevel)
    PODIUM_CUTOVER_ACCOUNT_HOME=$(getent passwd "$(id -u)" | cut -d: -f6)
    PODIUM_CUTOVER_STATE=$PODIUM_CUTOVER_ACCOUNT_HOME/.podium
    PODIUM_CUTOVER_CONFIG=$PODIUM_CUTOVER_STATE/config.json
    PODIUM_CUTOVER_UNIT_DIR=$PODIUM_CUTOVER_ACCOUNT_HOME/.config/systemd/user
    PODIUM_CUTOVER_DATA=$PODIUM_CUTOVER_ACCOUNT_HOME/.local/share
    PODIUM_CUTOVER_INSTALL=$PODIUM_CUTOVER_DATA/podium
    PODIUM_CUTOVER_BIN_DIR=$PODIUM_CUTOVER_ACCOUNT_HOME/.local/bin
    cd "$PODIUM_CUTOVER_REPO"

If the units set PODIUM_STATE_DIR, use that exact directory instead of the default above. Refuse to
continue if the config is corrupt, already has persistence, or is not config version 2:

    PODIUM_CUTOVER_CONFIG=$PODIUM_CUTOVER_CONFIG bun -e '
      const path = process.env.PODIUM_CUTOVER_CONFIG
      const config = await Bun.file(path).json()
      if (config.configVersion !== 2) throw new Error("migrate and re-inspect this pre-v2 config first")
      if (Object.hasOwn(config, "persistence")) {
        throw new Error("this guide requires a source config with no persistence key")
      }
      if (!config.mode) throw new Error("the instance has no configured mode")
      console.log(JSON.stringify(config, null, 2))
    '

Record the live endpoint and verify the source stack before changing anything:

    PODIUM_CUTOVER_PORT=$(PODIUM_CUTOVER_CONFIG=$PODIUM_CUTOVER_CONFIG bun -e '
      const config = await Bun.file(process.env.PODIUM_CUTOVER_CONFIG).json()
      console.log(config.port || 18787)
    ')
    PODIUM_CUTOVER_URL=http://127.0.0.1:$PODIUM_CUTOVER_PORT
    curl --fail --silent --show-error "$PODIUM_CUTOVER_URL/readiness"
    curl --fail --silent --show-error "$PODIUM_CUTOVER_URL/version"

Choose the target mode from the processes the box must own, not just from the old mode field:

- If this box currently runs both a coordinating server and its local agent daemon, set
  PODIUM_CUTOVER_MODE=all-in-one. This is the correct transition for a development authority even
  if its old config says mode server.
- If it intentionally owns only the coordinating server, set PODIUM_CUTOVER_MODE=server.
- A daemon-only joined machine needs its serverUrl and pairing state preserved and is outside this
  default-instance guide.

For the development-authority shape:

    PODIUM_CUTOVER_MODE=all-in-one

Confirm that /version reports daemonConnected true before selecting all-in-one. If it is false,
repair the source daemon first rather than carrying an unexplained degraded state into migration.

## 2. Build and stage recovery

Build an ordinary orderable bundle from the protected development branch. Do not stamp the initial
bundle as dev+SHA; source labels are not ordered release versions and cannot seed the later dev
publisher sequence.

    test -z "$(git status --porcelain)"
    bun install --frozen-lockfile
    bun run package:headless
    test -x dist-bun/headless/podium
    PODIUM_CUTOVER_VERSION=$(tr -d '\n' < dist-bun/headless/VERSION)
    case "$PODIUM_CUTOVER_VERSION" in
      dev+*) echo "refusing unordered source version $PODIUM_CUTOVER_VERSION" >&2; exit 1 ;;
    esac

Create the recovery directory on the same host before touching config or units:

    PODIUM_CUTOVER_RECOVERY=$PODIUM_CUTOVER_STATE/recovery/source-to-installed-$(date -u +%Y%m%dT%H%M%SZ)
    mkdir -m 700 -p "$PODIUM_CUTOVER_RECOVERY/units"
    cp -a "$PODIUM_CUTOVER_CONFIG" "$PODIUM_CUTOVER_RECOVERY/config.json"
    git rev-parse HEAD > "$PODIUM_CUTOVER_RECOVERY/source-sha"
    printf '%s\n' "$PODIUM_CUTOVER_VERSION" > "$PODIUM_CUTOVER_RECOVERY/installed-version"

The complete default-instance legacy inventory is below. Back up every definition that exists, not
only the three currently active services, because the healthy parent removes all legacy
definitions.

    PODIUM_CUTOVER_LEGACY_UNITS="podium-parent.service podium-server.service podium-janitor.service podium-daemon.service podium-redeploy.service podium-health.service podium-health.timer podium-backend.service podium-daemon-system.service"
    : > "$PODIUM_CUTOVER_RECOVERY/enabled-units"
    : > "$PODIUM_CUTOVER_RECOVERY/active-units"
    for unit in $PODIUM_CUTOVER_LEGACY_UNITS; do
      if [ -e "$PODIUM_CUTOVER_UNIT_DIR/$unit" ] || [ -L "$PODIUM_CUTOVER_UNIT_DIR/$unit" ]; then
        cp -a "$PODIUM_CUTOVER_UNIT_DIR/$unit" "$PODIUM_CUTOVER_RECOVERY/units/$unit"
      fi
      if systemctl --user is-enabled --quiet "$unit" 2>/dev/null; then
        printf '%s\n' "$unit" >> "$PODIUM_CUTOVER_RECOVERY/enabled-units"
      fi
      if systemctl --user is-active --quiet "$unit" 2>/dev/null; then
        printf '%s\n' "$unit" >> "$PODIUM_CUTOVER_RECOVERY/active-units"
      fi
    done
    test -s "$PODIUM_CUTOVER_RECOVERY/active-units"

Also preserve anything already occupying the installed locations:

    if [ -e "$PODIUM_CUTOVER_INSTALL" ] || [ -L "$PODIUM_CUTOVER_INSTALL" ]; then
      mv "$PODIUM_CUTOVER_INSTALL" "$PODIUM_CUTOVER_RECOVERY/pre-cutover-install"
    fi
    mkdir -p "$PODIUM_CUTOVER_BIN_DIR" "$PODIUM_CUTOVER_DATA"
    if [ -e "$PODIUM_CUTOVER_BIN_DIR/podium" ] || [ -L "$PODIUM_CUTOVER_BIN_DIR/podium" ]; then
      cp -a "$PODIUM_CUTOVER_BIN_DIR/podium" "$PODIUM_CUTOVER_RECOVERY/pre-cutover-command"
    fi

Stage and atomically place the built bundle on the same filesystem:

    PODIUM_CUTOVER_STAGE=$(mktemp -d "$PODIUM_CUTOVER_DATA/.podium-cutover.XXXXXX")
    cp -a dist-bun/headless/. "$PODIUM_CUTOVER_STAGE/"
    test -x "$PODIUM_CUTOVER_STAGE/podium"
    test "$(tr -d '\n' < "$PODIUM_CUTOVER_STAGE/VERSION")" = "$PODIUM_CUTOVER_VERSION"
    mv "$PODIUM_CUTOVER_STAGE" "$PODIUM_CUTOVER_INSTALL"
    ln -sfn "$PODIUM_CUTOVER_INSTALL/podium" "$PODIUM_CUTOVER_BIN_DIR/podium"

Render the dev parent with this account and checkout. The checked-in generated example contains
placeholder paths, so do not copy it unchanged.

    PODIUM_CUTOVER_PARENT_STAGE=$PODIUM_CUTOVER_RECOVERY/podium.service
    PODIUM_CUTOVER_HOME=$PODIUM_CUTOVER_ACCOUNT_HOME \
    PODIUM_CUTOVER_REPO=$PODIUM_CUTOVER_REPO \
    PODIUM_CUTOVER_PORT=$PODIUM_CUTOVER_PORT \
    PODIUM_CUTOVER_PARENT_STAGE=$PODIUM_CUTOVER_PARENT_STAGE \
    bun --conditions=@podium/source -e '
      import { writeFileSync } from "node:fs"
      import { renderParentUnit } from "./apps/cli/src/cli-systemd.ts"
      writeFileSync(
        process.env.PODIUM_CUTOVER_PARENT_STAGE,
        renderParentUnit({
          profile: "dev",
          instanceId: "default",
          home: process.env.PODIUM_CUTOVER_HOME,
          repoRoot: process.env.PODIUM_CUTOVER_REPO,
          port: Number(process.env.PODIUM_CUTOVER_PORT),
        }),
      )
    '
    grep -F "ExecStart=%h/.local/bin/podium parent --takeover" "$PODIUM_CUTOVER_PARENT_STAGE"
    grep -F "PODIUM_DEV_SOURCE_ROOT=$PODIUM_CUTOVER_REPO" "$PODIUM_CUTOVER_PARENT_STAGE"

Install and arm the parent without starting it:

    if [ -e "$PODIUM_CUTOVER_UNIT_DIR/podium.service" ]; then
      cp -a "$PODIUM_CUTOVER_UNIT_DIR/podium.service" "$PODIUM_CUTOVER_RECOVERY/pre-cutover-podium.service"
    fi
    install -m 0644 "$PODIUM_CUTOVER_PARENT_STAGE" "$PODIUM_CUTOVER_UNIT_DIR/podium.service"
    systemctl --user daemon-reload
    systemctl --user enable podium.service
    test "$(systemctl --user is-active podium.service 2>/dev/null || true)" != active

At this point the source data plane must still report ready. If it does not, stop and repair it
before entering the critical section.

## 3. Perform the critical section

Keep PODIUM_CUTOVER_RECOVERY and the variables above in the same host-local shell. Stop every unit
that was active at preflight, then mask the entire legacy inventory:

    while IFS= read -r unit; do systemctl --user stop "$unit"; done < "$PODIUM_CUTOVER_RECOVERY/active-units"
    systemctl --user mask --runtime $PODIUM_CUTOVER_LEGACY_UNITS

The endpoint should now be unreachable because the old server is stopped. That is the deliberate
handover window, not activation_pending on a still-serving stale process.

Atomically write mode and persistence, preserving every other config field:

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

Start the already-armed parent immediately:

    systemctl --user --no-block start podium.service

Wait up to 120 seconds for both lifecycle and binary identity. For all-in-one, daemonConnected must
also be true:

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

If that command fails, run the rollback below immediately. Do not diagnose by repeatedly editing
config while either server is live.

## 4. Acceptance checks

All of these must hold:

    systemctl --user is-active --quiet podium.service
    systemctl --user is-enabled --quiet podium.service
    systemctl --user show podium.service --property=MainPID --value
    curl --fail --silent --show-error "$PODIUM_CUTOVER_URL/readiness"
    curl --fail --silent --show-error "$PODIUM_CUTOVER_URL/version"
    ps -o args= -p "$(systemctl --user show podium.service --property=MainPID --value)"
    systemctl --user list-unit-files 'podium*'

The parent process command must resolve inside PODIUM_CUTOVER_INSTALL, /readiness must be ready with
both planes available, /version must say installKind installed and the staged version, and
daemonConnected must be true for all-in-one. The healthy parent then disables, stops, and removes
legacy definitions. Keep PODIUM_CUTOVER_RECOVERY until at least one later dev update has completed.

## 5. Rollback

Rollback uses only the host-local recovery bundle; it does not depend on Podium's control plane.

Stop the new topology and all possible legacy contenders before restoring the old boot config:

    systemctl --user disable --now podium.service 2>/dev/null || true
    for unit in $PODIUM_CUTOVER_LEGACY_UNITS; do
      systemctl --user stop "$unit" 2>/dev/null || true
    done
    cp -a "$PODIUM_CUTOVER_RECOVERY/config.json" "$PODIUM_CUTOVER_CONFIG.rollback-next"
    mv "$PODIUM_CUTOVER_CONFIG.rollback-next" "$PODIUM_CUTOVER_CONFIG"

Restore the source unit definitions, remove runtime masks, and restore the exact enabled and active
sets captured before cutover:

    for saved in "$PODIUM_CUTOVER_RECOVERY"/units/*; do
      test -e "$saved" || continue
      cp -a "$saved" "$PODIUM_CUTOVER_UNIT_DIR/$(basename "$saved")"
    done
    systemctl --user daemon-reload
    systemctl --user unmask $PODIUM_CUTOVER_LEGACY_UNITS 2>/dev/null || true
    while IFS= read -r unit; do systemctl --user enable "$unit"; done < "$PODIUM_CUTOVER_RECOVERY/enabled-units"
    while IFS= read -r unit; do systemctl --user start "$unit"; done < "$PODIUM_CUTOVER_RECOVERY/active-units"

Wait until /readiness is ready again and /version says installKind source. Only after source service
is restored should an operator decide whether to restore the previous installed directory or
command symlink; neither is used by the source units. If needed:

    systemctl --user disable --now podium.service 2>/dev/null || true
    if [ -e "$PODIUM_CUTOVER_RECOVERY/pre-cutover-install" ]; then
      mv "$PODIUM_CUTOVER_INSTALL" "$PODIUM_CUTOVER_RECOVERY/failed-install"
      mv "$PODIUM_CUTOVER_RECOVERY/pre-cutover-install" "$PODIUM_CUTOVER_INSTALL"
    fi
    if [ -e "$PODIUM_CUTOVER_RECOVERY/pre-cutover-command" ] || [ -L "$PODIUM_CUTOVER_RECOVERY/pre-cutover-command" ]; then
      cp -a "$PODIUM_CUTOVER_RECOVERY/pre-cutover-command" "$PODIUM_CUTOVER_BIN_DIR/podium"
    fi

Restoring config while the stale source server or the new parent is still running recreates
activation_pending. The stop-before-restore order is part of the rollback safety proof.

## Tested evidence

This sequence was rehearsed on 2026-08-27 against a private systemd user manager, isolated HOME,
XDG roots, state directory, and loopback port. It used the real source server and daemon from commit
2595a904fe8c27301c9dface60fcab1ae2ff9b06 and a real compiled 0.1.1-edge.2 headless bundle.

Observed results:

- Source start: configVersion 2, mode server, no persistence key; /readiness was ready with both
  planes available; /version said installKind source and daemonConnected true.
- Armed failure: while deliberately leaving the source server running, setting mode all-in-one and
  persistence systemd changed /readiness to activation_pending, dataPlane blocked, with stale
  fields mode and persistence. The deliberately broken parent failed.
- Rollback: stopping contenders, atomically restoring config, restoring and unmasking source units,
  and starting the previously active set returned /readiness to ready and both planes available.
- Safe success: stopping legacy units before the config write made the endpoint deliberately
  unreachable; starting the installed parent returned /readiness to ready in 3.63 seconds.
  /version reported installKind installed, appVersion 0.1.1-edge.2, and daemonConnected true.
  podium.service was active and enabled, its process ran the staged podium-cli parent --takeover,
  all legacy unit files were retired, and the recovery bundle remained present.

The failed-start arm is essential evidence: it proves the recovery procedure returns an
activation-pending source instance to service instead of silently leaving the operator locked out.

## Why absent persistence remains divergent

An absent boot-relevant field must continue to count as divergence. In config v2, absence is not
unknown: persistence absent means an unmanaged foreground or desktop-supervised process. Writing
persistence systemd changes restart authority and process topology. If undefined to systemd were
ignored, the old source process could claim ready while the file says systemd, allowing work during
a supervisor transition and permitting duplicate restart owners or port takeover races.

Mode has the same boot-shape property. A source development authority whose file says server while
a separate daemon unit is active must establish all-in-one during this cutover; blindly preserving
server would make the new parent omit the daemon.

## Config shapes in the wild

| Origin | Expected shape | Meaning for this guide |
| --- | --- | --- |
| Pre-v2, pendingPersistence present | The CLI migration folds pendingPersistence into persistence and stamps configVersion 2 | Re-inspect after a CLI invocation; it is not the no-persistence case if a persistence value was recovered |
| Pre-v2, no pendingPersistence | In-memory migration produces configVersion 2 with persistence absent; the CLI persists it once | Absence means unmanaged, so use this transition only after the migrated file is inspected and backed up |
| install.sh or headless setup | Setup records systemd or detached persistence | Already on the installed path; normal topology reconciliation applies |
| Desktop app | Mode may be present while persistence is absent; PODIUM_DESKTOP_SUPERVISED identifies the supervisor | Do not use this guide |
| Plain source run | Mode present, persistence absent | This guide's target population |
| Development authority with old mode server plus active daemon unit | Config and live process shape disagree about the future parent children | Set all-in-one so the installed parent owns both server and daemon |

