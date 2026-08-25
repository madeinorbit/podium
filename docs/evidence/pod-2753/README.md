# POD-2753 — the Claude SDK, driven out of the daemon and killed on purpose

The Claude Agent SDK ran inside the daemon's own process. That process supervises
every session on the machine, so the SDK's failures were the daemon's failures.
This directory holds the rig that proves it now runs somewhere the daemon can
afford to lose, and the record of losing it.

## The scripts

| file | what it does |
| --- | --- |
| `drive-env.sh` | isolation environment for the `p2753` instance — source it, never execute it |
| `drive-up.sh` | brings up server + daemon, split and detached, from this worktree |
| `drive-verify.sh` | **refuses to let you measure anything** until the running processes are proven to be the commit you name |
| `drive.ts` | the drive: control turn, process topology, kill, recovery |
| `drive-down.sh` | stops the pair, keeps the state and logs |

```
bash docs/evidence/pod-2753/drive-up.sh
bash docs/evidence/pod-2753/drive-verify.sh HEAD
bun  docs/evidence/pod-2753/drive.ts
```

### On the `build-a-rig.sh` this issue's brief asked for

There is no such file. It is not in this worktree, not on `issue/1761-agent-runtime`,
not on POD-2745's branch, and not anywhere in `git log --all`. The scripts here are
re-cut from `docs/evidence/pod-2290/`, which is the real thing the brief describes,
plus the two properties it actually asked for: verify what is RUNNING against a
named commit, and refuse to report a measurement until a control proves the path
is alive.

### Two things the rig has to force, and why

**The backend.** `control/headless.ts` routes a headless turn to the DURABLE
abduco driver when `ctx.backend === 'abduco'`, and that driver spawns the claude
CLI directly — it never touched the SDK. The SDK driver is the NON-durable path.
On a box with abduco installed (this one), a default daemon would take the durable
path, this drive would measure code the change does not touch, and it would report
a pass. So `drive-env.sh` sets `PODIUM_ABDUCO` to a path that does not run, which
is the documented override that FAILS resolution rather than falling back. That is
a real production configuration — any box without abduco, and every Windows box —
not a contrivance.

**First-run setup.** A fresh state root reports `unconfigured` / `setup_required`
and blocks the data plane, so `/auth/login` answers 503 and nothing can be driven.
The wizard's writes go through `setup.*` tRPC procedures that sit behind the very
guard that is blocking, which the web onboarding screen resolves interactively and
a rig cannot. `drive-up.sh` writes the one field readiness reads.

## What the drive found

Run on 2026-08-25 against `bd5d991ae22609e8553a5450e28b6133e0c331c5`, verified by
`drive-verify.sh` before any measurement was taken.

```
PASS  CONTROL a Claude turn completes through the child host — the assistant replied "ALIVE"
PASS  TOPOLOGY the SDK runs in an OS child of the daemon — host pid 2785510, parent 2763359
      host argv: bun --conditions=@podium/source .../apps/daemon/src/claude-sdk-host.ts
PASS  the daemon survived the kill — pid 2763359
PASS  the instance still serves after the kill
PASS  the killed turn ended rather than hanging — 2.3s after the kill
PASS  the killed turn told its human what happened
PASS  the daemon ran Claude again normally after losing a host
```

What the human is shown when the host is SIGKILLed mid-turn:

> the headless harness turn failed (claude-code): The Claude turn failed: the
> Claude model host process exited on SIGKILL before the turn finished

and what the daemon recorded, with the conversation id carried out of the failure
so the thread keeps its transcript binding rather than silently starting over:

```
warn daemon:claude-sdk claude sdk host died mid-turn
     {signal: SIGKILL, code: None, harnessSessionId: 2a9ef15f-3fef-4718-adcf-0ced90808253}
```

## The compiled binary

The rig runs from source, so it cannot exercise the one production path that only
exists in the single-file build: the daemon re-execs the binary with a sentinel in
the environment and that child becomes the host. Built and checked separately, both
directions:

```
$ ./podium --version                      # no sentinel
podium pod2753-probe                      # → the ordinary CLI

$ PODIUM_CLAUDE_SDK_HOST=1 ./podium       # sentinel set, one turn on stdin
{"t":"event","event":{"kind":"status","status":"starting"}}
{"t":"error","message":"Claude Code native binary not found at /nonexistent-claude. …"}
```

## The one claim the rig does NOT make

"A concurrent sibling session is unaffected" needs two live turns at once, and
this instance cannot cheaply provide them: only the `global` superagent thread
exists without a real session behind it, and one live turn per thread is enforced.
That claim is proven in `apps/daemon/src/claude-sdk-client.test.ts`, which runs two
real child processes, kills one mid-turn and requires the other to complete.

## Three wrong observables, recorded because the next person will reach for them

The drive was wrong three times before it was right, each time in the direction of
a **false negative** — a passing system reported as broken:

1. `pgrep -f claude-sdk-host` matched the driving shell's own command line (it
   contains the string) and reported a live host for the whole run. The fix reads
   `/proc/<pid>/cmdline` AND requires the process to be a child of this daemon.
   The same trap bit a `pkill` later in the session and killed the shell issuing it.
2. A settle predicate of "the thread stopped changing" was satisfied by an empty
   thread three seconds in, and failed the control turn before it had begun. A
   settle condition satisfied by nothing having happened yet always fires before
   the thing it waits for.
3. `superagent.history` is EMPTY on success — it holds server-side notices, and a
   successful reply is written by the harness to its own JSONL. `watermarkItemId`
   does not advance per turn either. Success has to be read from the transcript,
   which is where the human's answer actually lands.
