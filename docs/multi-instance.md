# Multiple independent instances

A Podium instance is an operational identity, not just a display name. The identity selects
the state, native-agent home, endpoints, durable terminal namespace, installed bundle, CLI
command, and supervisor units used by every process in that deployment.

Instance IDs must match `[a-z][a-z0-9-]{0,31}`. `default` preserves all pre-instance paths,
ports, command names, durable labels, and service names.

## Install two named instances

Install each release under an explicit identity:

```bash
curl -fsSL https://github.com/madeinorbit/podium/releases/download/edge/install.sh \
  | sh -s -- --channel edge --instance blue
curl -fsSL https://github.com/madeinorbit/podium/releases/download/edge/install.sh \
  | sh -s -- --channel edge --instance green

podium-blue setup
podium-green setup
```

The installer creates identity-bound commands. `podium-blue` always exports
`PODIUM_INSTANCE=blue` before entering the blue bundle; the green command does the same for
green. Installing or updating one named instance never replaces the other instance's bundle
or command.

For source runs or an unbound `podium` binary, select the identity in either form:

```bash
podium --instance blue status
PODIUM_INSTANCE=green podium status
```

`--instance` may appear anywhere in the argument list and wins over `PODIUM_INSTANCE`.
Duplicate selectors and invalid IDs are rejected.

## Namespace map

| Resource | Compatibility instance (`default`) | Named instance (`blue`) | Explicit override |
|---|---|---|---|
| State | `~/.podium` | `${XDG_STATE_HOME:-$HOME/.local/state}/podium/blue` | `PODIUM_STATE_DIR` |
| Installed bundle | `${XDG_DATA_HOME:-$HOME/.local/share}/podium` | `${XDG_DATA_HOME:-$HOME/.local/share}/podium-instances/blue` | `XDG_DATA_HOME` at install time |
| Command | `podium` | `podium-blue` | run an unbound binary with `--instance` |
| Native-agent `HOME` | the operator's `HOME` | `<state>/agent-home` | `PODIUM_AGENT_HOME` or config `agentHome` |
| Server port | `18787` | stable ID-derived port | `PODIUM_PORT` or config `port` |
| Hook port | `45777` | next port in the ID-derived triplet | `PODIUM_HOOK_PORT` or config `hookPort` |
| Agent relay port | `45778` | final port in the ID-derived triplet | `PODIUM_AGENT_RELAY_PORT` or config `agentRelayPort` |
| Durable terminal label | `podium-<session>` | `podium-blue-<session>` | none |
| Server unit | `podium-server.service` | `podium-blue-server.service` | none |
| Janitor unit | `podium-janitor.service` | `podium-blue-janitor.service` | none |
| Daemon unit | `podium-daemon.service` | `podium-blue-daemon.service` | none |
| Update timer | `podium-update-user.timer` | `podium-blue-update.timer` | none |

Named endpoint triplets are deterministic and non-overlapping for ordinary IDs. A rare hash
collision, or any explicit collision, fails during bind; Podium does not silently move to an
ephemeral port. Set all three port overrides when an operator needs a fixed allocation.

Each state root contains `instance.json`. A process refuses a root already marked for another
identity. A named instance also refuses to adopt a non-empty unmarked directory unless
`PODIUM_ADOPT_STATE=1` is set for an intentional migration.

## Operate one instance

Use the bound command for every lifecycle action:

```bash
podium-blue status
podium-blue logs
podium-blue stop
podium-blue channel edge
podium-blue update
```

Status and logs consult only blue's state and units. Stop addresses only
`podium-blue-daemon.service`, `podium-blue-janitor.service`, and
`podium-blue-server.service`. The blue update service runs only `podium-blue update`, swaps
only blue's bundle, and restarts only blue's managed siblings.

The same commands for `podium-green` operate green. For deterministic automation, set explicit
server, hook, and relay ports rather than relying on derived ports.

## Route commands from an agent session

A spawned agent receives `PODIUM_INSTANCE`, `PODIUM_SESSION_INSTANCE`,
`PODIUM_SESSION_ID`, and an instance-owned relay URL. This keeps its issue, spec, workflow,
mail, session, and agent CLI calls attached to the runtime that owns the process.

Selecting a different instance while an inherited relay belongs to the current session fails
instead of silently sending the command to the wrong server. Crossing that boundary must be
explicit:

```bash
PODIUM_NO_RELAY=1 podium-green issue ready
# equivalent with an unbound binary:
PODIUM_NO_RELAY=1 podium --instance green issue ready
```

`PODIUM_NO_RELAY=1` discards the inherited session relay and uses the selected instance's
direct server endpoint. It is the intentional operator escape hatch, not a sharing default.

## Explicit sharing

Independence is the default. These configurations deliberately relax parts of it:

- Give two identities the same `PODIUM_AGENT_HOME` (or config `agentHome`) to share native
  agent credentials and history while leaving Podium databases and endpoints separate.
- Set the same `ABDUCO_SOCKET_DIR` or `TMUX_TMPDIR` to share a durable-backend storage
  location. Podium still uses instance-qualified durable labels.
- Configure a daemon's `serverUrl`, or join it with a token, to attach that daemon to a
  different coordinating server.
- Select the same instance ID and state root when multiple processes are intentionally parts
  of one deployment. Two different IDs cannot share a marked state root.

Record shared paths and endpoints as operator configuration; they are outside the isolation
guarantees below.

## Runtime acceptance proof

From a dependency-complete source checkout, run:

```bash
bun run test:multi-instance
```

The command combines three layers:

1. `multi-instance-runtime.integration.bun.test.ts` starts blue and green as concurrent real
   all-in-one processes. It proves distinct state markers and endpoints; disjoint issue
   reads and writes; rejected inherited cross-instance routing; disjoint session ownership;
   and that stopping blue leaves green's server, hook, and relay alive.
2. `managed-account-spawn.integration.test.ts` drives the real Node PTY spawn path and proves
   the child receives blue's instance/session identity and exact durable label.
3. `install-sh.test.sh` installs default and named bundles into a temporary home and proves a
   named install/update target cannot overwrite the default bundle, command, or units.

The process test uses explicit temporary roots and six reserved ports, so it can run alongside
an operator's normal Podium instance without reading or stopping it.

## Security boundary

These guarantees prevent Podium processes, CLIs, session relays, lifecycle commands, and
updates from accidentally reading, mutating, stopping, updating, or routing into another
identity. They are not a hostile-process sandbox. Instances running as the same OS user can
still deliberately open one another's files or loopback ports with ordinary shell tools.

For mutually untrusted operators or agents, run each instance under a different OS account,
container, or VM and apply filesystem and network policy at that boundary.
