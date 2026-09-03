# Named rig audit

Audit date: 2026-08-26.

Every evidence launcher selects PODIUM_INSTANCE explicitly, derives its state
root from the same HOME/XDG rule as the runtime, and claims that named root
through the shared runtime config writer used by podium setup. The default arm
of each rig sees no PODIUM_STATE_DIR, PODIUM_AGENT_HOME, ABDUCO_SOCKET_DIR, or
TMUX_TMPDIR from these launchers.

## Sweep

The audited setup entry points are:

- pod-2290/drive-env.sh and pod-2290/pd
- pod-2753/drive-env.sh
- pod-2761/drive-env.sh
- pod-2773/drive-env.sh
- pod-2775/drive-env.sh
- pod-2777/drive-env.sh
- pod-2792/drive-env.sh
- pod-2801/drive-env.sh
- pod-2811/drive-env.sh, which sources the p2777 rig with its own identity
- pod-2819/drive-env-main.sh
- pod-2843/drive-env.sh
- pod-2853/drive-env.sh

The shared rig-path-guard.sh records inherited direct path overrides, removes
them, and exposes the product-derived root only as PODIUM_RIG_STATE_ROOT.
state-root-check.ts compares that value with instanceStateDir(), prints the
durable paths applyInstanceRuntimeEnv() would choose, and refuses both an
inherited override and a value that survives the scrub on the default arms. The
p2777-specific check applies the same inherited-override rule to its
P2777_STATE_ROOT.

All daemon launchers now retain the real HOME. A named instance already makes
the product resolve the agent home below its state root, so setting HOME to an
agent-home directory was both unnecessary and a second state-root derivation.
The launchers seed credentials into that product-derived agent home without
making it the daemon's HOME.

No launcher fabricates instance.json or config.json. They all call
docs/evidence/claim-instance.sh, whose saveConfig() call claims the identity
through the runtime setup path.

## Actual breakage with product paths

With the short socket-dir overrides removed, the POD-2761 Codex probe started
its server and daemon, then failed the first client-terminal spawn. The daemon
recorded create-session: File name too long; the probe saw no client PID or
output bytes and exited NO MEASUREMENT. This is POD-2853 and is deliberately
not fixed here.

The supplied p2777 drive, after losing both its state-path and daemon-HOME
overrides, measured eight of eighty Tier-A cells: A1a codex/headless PASS, A7a
codex/headless PASS, A4b opencode/headless PASS, A4a opencode/headless PARTIAL
because its terminal half was blocked, and A6a BLOCKED on both arms. The
headless A6a arm was silent even though the session was live and attach
answered; the cause appeared only in a daemon warning. This is evidence from
the real configuration, not a release verdict.

The grep counter sweep found the no-match double-zero bug in the p2843 and
p2853 daemon readiness helpers. Both now retain grep's printed zero with
fallback true; no grep-c counter still uses fallback echo 0.

## Deliberate exception

Only the POD-2853 control arms may set a product path: P2853_ABDUCO_SOCKET_DIR
reinstates the short socket root, and P2853_AGENT_HOME changes the abduco HOME
rung so the second defect can be reached. Those settings are optional arms of
POD-2853, not the default rig configuration, and the default p2853 arm leaves
all product-selected paths unset. POD-2853 owns the path defect and this issue
does not repair it.

POD-2753's PODIUM_ABDUCO setting remains because it selects the SDK-child
backend under test; it does not shorten or relocate a product path. The
PODIUM_WEB_DIR values remain build-artifact pins, and PODIUM_DRIVE_BASE remains
rig bookkeeping for logs, pidfiles, and results.
