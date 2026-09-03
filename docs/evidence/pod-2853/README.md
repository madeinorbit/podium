# POD-2853 — a named instance could not start any terminal session

Two defects, one on top of the other, both measured on a real named instance
driven through the product's own API. Neither is visible on the default
instance, which is why nobody had hit them.

## The instance this was measured on

`PODIUM_INSTANCE=p2853`, state root `~/.local/state/podium/p2853` — the layout
`docs/multi-instance.md` documents for a named instance, not a short scratch
path. **`ABDUCO_SOCKET_DIR` is deliberately not set**: every other rig on this
box exports a short one by hand, and that export is the workaround this issue
exists to remove.

Control arm: a detached checkout of the epic tip (`f6a6c8625`) carrying nothing
but these rig files. Fixed arm: the issue branch. Both drives create one
`claude-code` session over `sessions.create` and read the row's `spawnFailure`
out of the server's own sqlite, alongside a walk of every directory abduco could
have chosen — done directly, so the reading does not depend on the resolver
under suspicion.

## Defect 1 — the socket path is longer than the OS allows

A durable session is a unix socket, and `sun_path` is 108 bytes on Linux. abduco
composes `<root>/abduco/<user>/<label>@<hostname>` and refuses the whole create
past that, with a one-line `create-session: File name too long` that names
neither the path nor the limit.

Three things composed the overflow:

| part | value | bytes |
|---|---|---|
| `applyInstanceRuntimeEnv` pinned | `<state>/runtime/abduco` | 50 |
| abduco appended | `abduco/mgw/` — note the **doubled** segment | 12 |
| the instance-prefixed label | `podium-p2853-<uuid>` | 49 |
| abduco's host suffix | `@flatblock` | 10 |
| **total** | | **121** vs **108** |

`readings/before-nopin.log` — control arm, nothing hand-set:

```
  spawnFailure   "/home/mgw/.local/state/podium/p2853/bin/abduco exited 1: create-session: File name too long"
  OVER   121B  /home/mgw/.local/state/podium/p2853/runtime/abduco/abduco/mgw/
```

**De-duplicating `abduco/abduco` would not have fixed it.** It buys 7 bytes and
lands on 114 — still over. The same drive prints that line too. A named
instance's state root simply cannot be the socket root, so the fix moves the
root to the runtime directory rather than tidying the old one.

`readings/after-nopin.log` — fixed arm, same instance, same state root:

```
  status         live
  spawnFailure   <none>
  PASS: the named instance started a terminal session and the socket is live.
        socket /run/user/1001/podium-p2853/abduco/mgw/podium-p2853-<uuid>@flatblock
        98 bytes, against a 108-byte limit
        1 harness process(es) running under …
```

## Defect 2 — the creator and the prober looked in different directories

abduco does not resolve one socket directory. It walks four in order —
`ABDUCO_SOCKET_DIR`, `HOME`, `TMPDIR`, `/tmp` (`vendor/abduco/config.h`) — and
moves to the next on **any** failure of the current one: a missing parent (its
`mkdir` is not recursive), a refused `mkdir`, a per-user subdirectory owned by
someone else, a name that truncates, a failed probe bind. It says nothing when
it does. The create *succeeds*, at a different root.

`abducoSocketDirs` mirrored only the first rung. So a master that fell through
was invisible to every caller that asks whether a label is alive, and the error
is one-sided toward "absent" — the expensive direction on all of them.

Measured directly against the real binary, before any product was involved: an
abduco master created with `ABDUCO_SOCKET_DIR` pointing at a directory whose
parent did not exist put its socket in `/tmp/abduco/mgw/` and stayed alive
there, while `abducoSocketPath` called with **that same environment** answered
`undefined`.

`readings/before-fallthrough.log` — control arm, the operator's own workaround
(a hand-set root) in the state where abduco cannot use it:

```
  status         starting
  spawnFailure   "abduco session podium-p2853-<uuid> did not publish a live socket within 5000ms"
  LIVE      /tmp/p2853-ah/.abduco/podium-p2853-<uuid>@flatblock
             81 bytes   (agent HOME/.abduco (abduco's HOME fallback))
  DEFECT 2: the row says no live socket, and a LIVE socket is on disk.
```

The agent was genuinely running — a real `claude` process under a live master —
while the row reported a failed spawn. That is the orphan the report describes.

`readings/after-fallthrough.log` — fixed arm, identical configuration:

```
  status         live
  spawnFailure   <none>
  PASS: the named instance started a terminal session and the socket is live.
        socket /tmp/p2853-ah/.abduco/podium-p2853-<uuid>@flatblock
        3 harness process(es) running under /tmp/p2853-ah
```

It is the **spawn** path, and it was not covered by POD-2761: that fix corrected
the *environment* the attach path probed with. This is the same class by the
other road — right environment, wrong half of abduco's directory chain.

## What changed

- `packages/runtime/src/abduco-socket.ts` (new) — the 108-byte budget, abduco's
  composition rules, and the ladder of roots a named instance can pin.
- `applyInstanceRuntimeEnv` pins the first root that both **fits** and can be
  **created**: `$XDG_RUNTIME_DIR/podium-<instance>`, then
  `$XDG_RUNTIME_DIR/podium`, then `<TMPDIR|/tmp>/podium-<uid>`. Creation is
  tried rather than assumed — under the old state-directory pin the daemon
  always owned the path, and an unhandled `mkdir` here would throw out of
  instance bootstrap.
- `abducoSocketDirs` mirrors all four of abduco's rungs, in abduco's order, so
  the probe looks everywhere the create could have landed.
- A create that fails on length now reports the composed path, its byte count
  and the limit instead of relaying abduco's eight words.

## Running it

```bash
bash docs/evidence/pod-2853/drive-up.sh     # the fixed arm
bun  docs/evidence/pod-2853/drive.ts
bash docs/evidence/pod-2853/drive-down.sh
```

Arms are environment variables, so a control run is not an edit:

| variable | what it selects |
|---|---|
| `P2853_REPO` | the checkout under test (default: this worktree) |
| `P2853_ABDUCO_SOCKET_DIR` | hand-set a socket root, as an operator working around defect 1 would |
| `P2853_ABDUCO_SOCKET_DIR_NOMKDIR` | leave that root uncreated, so abduco must fall through — the defect 2 arm |
| `P2853_AGENT_HOME` | the agent home, which is abduco's `HOME` rung (the abduco child runs under `ctx.homeDir`, not the daemon's `HOME`) |

## Residual limit, not fixed here

The budget is shared with the user name and the hostname, so where it runs out
depends on the host. On `mgw@flatblock` an instance id past ~14 characters gives
up its private socket root for a shared one, and past ~24 no root fits at all —
the label alone (`podium-<id>-<uuid>`) is 44 bytes plus the id, and
`INSTANCE_ID_PATTERN` allows 32. Shortening the label would break durable
session identity, so that case now fails with the measured path and limit in the
message rather than silently.
