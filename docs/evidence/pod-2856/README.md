# Named rig audit

Audit date: 2026-08-26.

Every evidence launcher now starts with a named `PODIUM_INSTANCE`, claims its state root through the shared runtime config writer used by `podium setup`, and leaves `ABDUCO_SOCKET_DIR` and `TMUX_TMPDIR` unset. The per-rig state root, agent home, ports, and driver-arm variables remain because they isolate concurrent rigs or select the behavior being measured; they do not relocate the product's durable-terminal paths.

## Sweep

The override removal covers these setup entry points:

- `pod-2290/drive-env.sh` and `pod-2290/pd`
- `pod-2753/drive-env.sh`
- `pod-2761/drive-env.sh`
- `pod-2773/drive-env.sh`
- `pod-2775/drive-env.sh`
- `pod-2777/drive-env.sh`
- `pod-2792/drive-env.sh`
- `pod-2801/drive-env.sh`
- `pod-2819/drive-env-main.sh`
- `pod-2843/drive-env.sh`

The shared `../claim-instance.sh` helper calls `saveConfig()` from `@podium/runtime/config`; that writer claims the state identity and writes the minimal `all-in-one` config. No evidence launcher fabricates `instance.json` or `config.json` now.

## Actual breakage with product paths

With the short socket-dir overrides removed, the POD-2761 Codex probe started its server and daemon, then failed the first client-terminal spawn. The daemon recorded `systemd-run exited 1: create-session: File name too long` and `/tmp/pod-2761/state/bin/abduco exited 1: create-session: File name too long`; the probe saw no client PID or output bytes and exited `NO MEASUREMENT`.

This is POD-2853, deliberately not fixed here. The short-path workaround is not retained, so a future drive must continue to show this red result until POD-2853 lands.

The `PODIUM_ABDUCO` setting retained by POD-2753 deliberately selects the SDK-child path by making abduco unavailable; it is a driver choice for that rig's subject, not a socket or temporary-directory relocation and not a workaround for POD-2853.

The per-port directories in `tests/e2e/harness-env.ts` remain a lower-level hermetic test fixture for ownership and cleanup, not an installation/evidence rig. This audit does not change that fixture contract.
