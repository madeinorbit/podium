# Running work on another machine

For agents coordinating a fan-out. Answers: what machines exist, which can take
work, how to put work on one, and what the trust story is.

## Why you would

A loaded host does not just make work slow, it makes verdicts **unavailable**. A
latency threshold cannot be judged at load 60, and a timeout that scales with
load tells you nothing about the property under test. If you are chasing a quiet
window, stop and move the work instead.

There is a second reason that is easy to miss. Running the same commit on a
second machine is the only way to catch an instrument that measures the **host**
rather than the code. POD-1393 was found exactly this way: wire goldens gave
90/90 on one machine and 87 tests with 2 failures on another, from the same
commit, because the corpus is generated from the agent CLIs detected on the host.
That was the third such defect in one epic (POD-1343, POD-1389, POD-1393). When a
gate's result looks machine-shaped, a second machine is the experiment.

## What machines exist

```
podium machine list
podium machine show <name|id>
```

Each block tells you the four things a placement decision needs:

- **online** — a daemon is attached right now. Liveness is not stored; it is the
  live socket. An offline machine's last-seen is printed instead.
- **use granted / denied** — your own execute decision on that machine. A machine
  you cannot see is absent entirely, so "not in the list" and "does not exist" are
  deliberately the same answer.
- **harnesses** — installed *and* logged in. `installed, NOT logged in` is a real
  and common state; a spawn onto it fails.
- **repos** — the checkouts registered there. Work is placed into a checkout, so
  a machine with none cannot take work yet.

Read `repos: not available to this session` as a fact about **you**, not the
machine: you can see it but not use it, so its checkouts and inventory are
withheld. That is different from `none registered`, which is a fact about the
machine.

Both commands need a Podium-managed agent session (`PODIUM_AGENT_RELAY`).

## Putting work on one

```
podium issue start <id> --machine <name|id>
podium issue create --machine <name|id> --start …
```

`--machine` **homes** the issue on that machine: its worktree, branch and every
later agent on it live there. It is not a one-shot placement, and that is
deliberate — `issues.machine_id` is where an issue lives, and a per-start
override would let the pin and the worktree disagree, which is one issue with two
homes.

Names resolve **exactly** — id, then name, then hostname. There is no prefix or
fuzzy matching, because resolving wrongly starts real work on a host you never
named, where it looks like it worked.

**The checkout path does not have to match.** Two machines have two layouts —
`/home/a/src/podium` here, `/home/b/src/podium` there — and placement resolves by
repository *identity*, not by path. If the target has no checkout at all, one is
cloned. You do not need to pre-arrange anything.

**The branch does not have to be on a remote.** Starting from a local-only branch
(any `integration/*`) works: the target cannot fetch those from anywhere, because
they never reach `origin`, so the commits it is missing are bundled and moved to
it directly. This is a no-op when the target already resolves the start point,
which is every same-machine start and every start from a branch that *is* on
origin. If it fails, it fails there with a message about the ref rather than
surfacing later as a confusing `worktree add` error.

### Moving work that has already started

```
podium session handoff <session-id> --to <machine>
```

This moves a **live** session: worktree, branch, conversation and all. The server
refuses with a reason if the target is offline, if you lack `use`, or if the
harness cannot be exported. Do not pre-guess those refusals — "denied" and
"unreachable" are different answers and only the server can tell them apart.

### What you cannot do, and why

You cannot spawn a delegate onto a machine other than its issue's home. A
delegate shares the issue's worktree, a worktree exists on exactly one machine,
and creating a second checkout of one branch on a second machine would look like
a successful spawn while producing work that cannot be merged. Hand the session
off first, or clear the execution profile's machine.

### node_modules and dependencies

Not provisioned for you, and not different from the local case: creating a
worktree never installs dependencies on any machine. Run `bun install` in the
worktree as your first act. A worktree without its workspace links resolves
`@podium/*` against another checkout, so tests can pass while proving nothing —
verify `node_modules/@podium/model` resolves inside your own worktree.

## Trust

**Agent-initiated remote work does not use ssh.** It goes over the daemon's
authenticated WebSocket to the server, which carries a per-machine token
(`~/.podium/daemon.json`) and is gated per command by the `see` / `use` /
`manage` verbs. Nothing in this path mints an identity or widens a capability.

**ssh is an operator tool for setting a machine up, and stays that way.** If you
are an agent and `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes` fails with
`Host key verification failed`, that is a **hard stop**. Do not pass
`StrictHostKeyChecking=no`, do not write to `known_hosts`, do not use
`ssh-keyscan`. Report the host and fingerprint and let a human verify it.
Silently accepting a host key is worse than the stop it replaces.

## The fleet, as of 2026-08-02

Stated because it cost real time to rediscover.

- **The Podium server is published only on
  `https://ludovico.shetland-banjo.ts.net:55555`, which is tailnet-only.** The
  port-443 Funnel on the same name proxies `127.0.0.1:62222` — a different
  service. A 401 from it is not Podium.
- **`vmi3407763` is reachable only as `vmi3407763.contaboserver.net`.** The bare
  hostname does not resolve, and the box is **not on the tailnet**.

Those two facts together are why the second machine reads as offline: it has no
network path to the control plane at all. `tailscale` is not installed on it.

## Bringing a second machine online

Requires a human for the network step. The order matters: without step 1 the
daemon has nothing to connect to, and steps 2–3 will appear to succeed anyway.

1. **Give it a path to the server.** Either join it to the tailnet (then the
   server is reachable at `wss://ludovico.shetland-banjo.ts.net:55555`), or
   provide another private channel. Do **not** put `:18787` behind a public
   Funnel — that exposes the control plane to the internet.
2. **Point the daemon at the server.** On the machine:
   `podium set-server wss://<server-host>:<port>` (a join code also works).
   Check `~/.podium/config.json` actually carries a `serverUrl`: a daemon whose
   config lost it fails with `podium daemon mode needs a serverUrl`, and one
   started before the URL was removed keeps running against the **old** value
   with nothing in the log to say so. `vmi3407763` sat in exactly that state for
   two weeks, still aimed at an ephemeral `trycloudflare.com` tunnel that died on
   18 July.
3. **Restart it.** The unit is usually a **user** unit:
   `systemctl --user restart podium-daemon`. `systemctl status podium-daemon`
   without `--user` reports `could not be found`, which reads as "not installed".
4. **Register the repo.** The machine needs the repository registered before work
   can be placed there. Checkout paths differ per machine and that is fine —
   placement matches on repo **identity**, not on path.
5. **Verify from the coordinator**, not from the machine:
   `podium machine list` should now show it `online` with its harness inventory.
   Until it appears there, nothing can be scheduled onto it regardless of what
   `systemctl` says locally.

## Reading a test result on a loaded box

Relevant here because this is the page about offloading work, and the reason to
offload is that a saturated host stops producing verdicts.

**Report the exit code, not the summary line.** `Test Files 86 passed (87)` with
no red `×` reads as green and is not: the missing file's worker had died, and its
tests never ran. Vitest exits non-zero for this, correctly — but a report built by
grepping for `Tests`/`Test Files` strips exactly the signal that would have said
so. Measured on this box at load 82: `Worker exited unexpectedly with signal
SIGILL`, one file unaccounted for, summary all-green, exit 1.

**A single run is not a verdict under load.** Three runs of overlapping scope on
one unchanged commit gave: clean; three failures; and a dead worker. Nothing in
the tree changed between them. If a result matters, run it again, and prefer the
narrowest scope that covers what you changed — a targeted file at 20 seconds is
better evidence than a 470-second sweep whose workers are competing with sixty
other processes.

## A note on how this was missing

The server could enumerate machines and hand off sessions long before any of this
existed. The relay refused to carry either command, so no agent could ask — and
the missing CLI flag hid the missing allowlist entry. If a capability seems
absent, check whether it is absent or merely unreachable from where you stand.
