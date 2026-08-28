# Two blockers found before the re-drive could start (2026-08-28, session D)

Neither is a Tier-A cell. Both are things that will bite the next session on this
host, so they are recorded here rather than in the matrix.

## 1. The installed `podium` CLI is dead on this host

Bare `podium <anything>` fails for **every** session on flatblock:

```
podium: invalid Podium instance marker at /home/mgw/.podium/instance.json
```

**Cause, established by A/B rather than inspection.** The marker at
`~/.podium/instance.json` is `version: 2` (written 2026-08-28 19:55). The
installed bundle `~/.local/share/podium/podium-cli` (built 18:11) does **not**
contain the string `version 2 requires instanceUuid`, i.e. it predates v2 markers
and takes `instance.ts`'s deliberate unknown-version refusal — the bare-message
branch, which is why the error carries no suffix.

The A/B, same binary, only the marker differing:

| marker fed to the *stale bundle* | result |
|---|---|
| `version: 1` | works — printed real lock state (positive control: the run was alive) |
| `version: 2` (a copy of the live one) | `invalid Podium instance marker` |

**Why the bundle is behind despite a newer build date.** It self-reports
`0.1.1-dev.17+6d29b8c`. `6d29b8cb7` is dated 2026-08-28 18:00 but does **not**
contain `85564b383` (2026-08-26 03:28, "an instance uuid that a reaper can
attribute by") — so it was built from a branch that never took the epic's v2
change. Meanwhile the live daemon (pid at time of writing 2331084, started 20:34)
runs **from source** out of `/home/mgw/src/podium/.worktrees/issue-1761-agent-runtime`,
which has v2, and it is that daemon that wrote the v2 marker into the shared
default state root. Newer-source daemon + older-bundle CLI over one `~/.podium`.

**Workaround used here** (no global state was touched):

```sh
cd <this worktree> && bun --conditions=@podium/source scripts/cli.ts <args>
```

This needs the worktree to have been installed — a fresh worktree has **no
`node_modules` at all**, and `bun install` links per package
(`apps/cli/node_modules/@podium/...`), not hoisted to the root, so an absent
root-level `node_modules/@podium` is not evidence of a failed install.

I did **not** reinstall or rebuild the global bundle: it is shared by every live
session on this host, and replacing it under running agents is the operator's
call, not mine.

## 2. `podium lock status` answered "free" for a lock that was held

The first status call this session returned:

```
'test:heavy' is free
```

Every later call, same wrapper, same cwd, returned the truth — a lock that had
been held continuously since 18:55:02Z:

```
'test:heavy' held by 648a0def-... on issue:#3055
  workspace /home/mgw/src/other/podium/.worktrees/issue-3055-build-ledger-in-state-dir
  [alive] (full package tests), expires in 29m25s
```

The lease was never released between those reads — the acquire timestamp is
identical across all of them, so this is a false negative, not a lock that
briefly freed.

`lock status` is **scoped by `repoPath`** (`packages/issue-client/src/lock-commands.ts:213`)
and renders an empty result as `'<name>' is free` — the same words for "nobody
holds it" and "not visible from where you asked". The holder here sits under a
**different repo root** (`/home/mgw/src/other/podium`, not `/home/mgw/src/podium`).

I could not reproduce it on demand and am not claiming the precise trigger. What
matters for this epic is the shape, and it is the shape POD-2777's own brief
names: **a zero that is indistinguishable from a dead instrument.** Acting on that
single "free" would have put a second heavy run on a host that has already been
crashed by exactly that collision.

**Operationally:** never acquire `test:heavy` on one "free" reading. Read it
twice, and treat any disagreement as held.

---

## 3. "test:heavy is now free" was not true — and `acquire` queues without `--wait`

POD-1761 mailed that `test:heavy` was free, confirmed by the coordinator, and to
acquire a lease immediately. It was **not** free. Three reads, minutes apart, all
returned the same holder with the **same acquire timestamp**
(`2026-08-28T18:55:02.844Z`), `[alive]`, `(full package tests)`, held by
`648a0def-…` on issue:#3055 under `/home/mgw/src/other/podium/.worktrees/issue-3055-build-ledger-in-state-dir`.
The countdown moved as ordinary expiry (27m52s → 24m28s → 23m39s), not as a
release and re-take.

Because §2 above means a *single* status read cannot be trusted in either
direction, I did not settle it on status alone. The acquire attempt is the
independent check, and it agrees with status:

```
$ podium lock acquire test:heavy --ttl 2m        # no --wait
exit=3
queued for 'test:heavy' at position 1; held by 648a0def-… [alive] (full package tests)
```

**You cannot queue behind a free lock.** So the lock is genuinely held, and the
"free" confirmation is wrong. This is the *opposite* direction of §2's failure
and worth noting as such: §2 was status reading free while held; here an
authority reported free while held. Both land an agent on the same rock.

**And the second finding, which is a trap in its own right:** `acquire` **queued
me at position 1 even though I passed no `--wait`.** The documented interface is
`acquire <name> [--ttl 10m] [--wait]`, which reads as "`--wait` is what makes it
queue". It is not. A caller told "acquire without `--wait`, do not queue" —
exactly my instruction — cannot satisfy that with this command, and will not know
it queued unless it reads the output.

That matters because a queue slot is not inert: a slot left behind by a session
that then goes idle or dies gets the lock **granted to it** when the holder
releases, and the grant sits there blocking everyone. I cancelled immediately:

```
$ podium lock cancel test:heavy
left the queue for 'test:heavy'
$ podium lock status                       # queue=0, holder unchanged
test:heavy: held by 648a0def-… expires in 23m39s queue=0
```

**No lease was taken and no runtime was started.** Filed as POD-3077.
