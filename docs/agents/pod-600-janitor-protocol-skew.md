# POD-600 — janitor protocol mismatch crashloop

## Diagnosis (2026-08-08)

`podium-janitor.service` exited `78/CONFIG` with:

```
janitor compatibility mismatch (server protocol=3, schema=maintenance-v3)
```

This was **version skew**, not a genuine multi-install incompatibility.

| Side | Protocol | Schema | How loaded |
| --- | --- | --- | --- |
| Source on disk (`~/.local/bin/podium` → root checkout `scripts/cli.ts`) | 4 | `maintenance-v4` | Current main |
| Running `podium-server.service` | 3 | `maintenance-v3` | Process started Fri 2026-08-07 17:24 CEST |

v4 landed in `5edb0fec8` (2026-08-08 00:13 CEST) for the POD-564 `worktree-gc` job kind. The long-running server still held the pre-bump constants in memory; the janitor starts fresh each attempt and therefore refused to handshake.

Same class as the "stale web build" banner: source-mode services share one checkout, but a long-lived process does not pick up protocol bumps until it is restarted.

## Fix applied on this host

```bash
systemctl --user restart podium-server.service
systemctl --user reset-failed podium-janitor.service
systemctl --user start podium-janitor.service
```

- Server came up on protocol v4.
- Janitor logged `podium janitor up → http://localhost:18787` and stayed active.
- `podium-daemon.service` kept the same MainPID and uptime (agent sessions live under the daemon, not the server).

`RestartPreventExitStatus=78` on the janitor unit correctly stops the crashloop once the mismatch is terminal; revival needs `reset-failed` + `start` (see `reviveCompatibilityBlockedJanitor` in the CLI update path).

## Not done here

No product change. A source-mode auto-heal (restart server when a same-checkout janitor sees the server behind) would prevent recurrence after every maintenance protocol bump; that is separate work if desired.
