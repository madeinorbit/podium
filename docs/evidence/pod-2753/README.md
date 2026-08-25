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

Re-run on 2026-08-25 against `badd8a9c350e6aa2f72a676548eb944f66bad2f3` — after the
round-2 fixes changed timeout and shutdown behaviour, so the drive is evidence about
the code that ships rather than about an earlier commit. Verified by
`drive-verify.sh` before any measurement was taken.

```
PASS  CONTROL a Claude turn completes through the child host — the assistant replied "ALIVE"
PASS  TOPOLOGY the SDK runs in an OS child of the daemon — host pid 2879184, parent 2876993
      host argv: bun --conditions=@podium/source .../apps/daemon/src/claude-sdk-host.ts
PASS  the daemon survived the kill — pid 2876993
PASS  the instance still serves after the kill
PASS  the killed turn ended rather than hanging — 2.1s after the kill
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

## Which path the drive exercised — the claim everything else rests on

The SDK driver is the NON-durable path, so "the drive passed" is worthless
unless the drive went through it. Stated plainly: **the drive exercised the SDK
child, and the kill test killed the SDK child. The durable driver did not run at
all.** Four independent confirmations and one negative, rather than one
assertion:

1. **The process.** The observed child's argv was
   `bun --conditions=@podium/source .../apps/daemon/src/claude-sdk-host.ts`, and
   that module is spawned by exactly one thing in product code —
   `claude-sdk-client.ts`. The durable driver spawns the claude CLI under abduco
   and never spawns this.
2. **The pid.** The pid killed (`2879184`) is the same pid observed as a child of
   the daemon (`2876993`), not a different process that happened to die nearby.
3. **The message.** What the human was shown —
   "the Claude model host process exited on SIGKILL before the turn finished" —
   is emitted at exactly one place in product code, `claude-sdk-client.ts:159`.
   A failure through the durable driver reads `durable turn failed`
   (`durable-headless.ts:557,630`). The text itself identifies the seam.
4. **The log namespace.** The daemon's own record of the death came from
   `daemon:claude-sdk`, a logger constructed only in `claude-sdk-client.ts`.

And the negative, from the instance's own state after the run:

```
daemon:durable log lines .............. 0
daemon:claude-sdk log lines ........... 2
durable per-turn state dirs created ... 0   (state/headless-turns)
abduco sockets created ................ 0
```

The durable driver leaves per-turn directories under `state/headless-turns` and
an abduco socket for every turn it runs. There are none. It never ran.

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

## What an adversarial review broke, over three rounds

An independent reviewer in its own checkout broke this change four ways. All four
are fixed and every fix is mutation-checked. They are recorded here rather than
quietly repaired, because the shape they share is the point.

**Every one was a guard whose coverage was an inventory rather than a property.**

1. **`createRequire` is an import edge and the walker could not see it.**
   `const req = createRequire(import.meta.url)` then `req('pkg')` loads into this
   process's heap, and the walker needs a literal after a `require`/`import`
   token. Two lines at module scope in `headless-drivers.ts` put a callable
   `query` in the daemon's heap with the suite **7/7 green**. Worse: the idiom is
   already live in three files in this graph, and **node-pty — a native addon in
   the daemon's address space — was visible to the walk only because an unrelated
   `typeof import('node-pty')` type annotation sat beside it.** Deleting that
   annotation as a tidy-up would have removed a native addon from the walk in
   silence. The walker now follows `createRequire` aliases and *refuses* a call
   whose specifier it cannot resolve.

2. **The roots were a hand-written list.** `scripts/cli.ts` and `scripts/host.ts`
   each host a daemon in-process and were in nobody's list, so a static SDK import
   in either left the suite green. Roots are now **derived** from what a module
   does — calls `startDaemon`, imports the daemon module, or reads `parentPort`.

3. **The compiled-binary pin was a spelling check**, defeated by one hop: a new
   `scripts/` module re-exporting the host, statically imported by
   `cli-compiled.ts`. Zero name-grep matches, 59.8 MB of heap, suite green. The
   compiled entry is now *walked*; only its direct, dynamic, sentinel-guarded edge
   is dropped.

4. **A timed-out turn reported SUCCESS with truncated output.** `interrupt` ends
   the SDK stream gracefully, so the host sends `done`, and the client resolved
   it. A 30-second superagent budget was enough to show a human half a sentence as
   the assistant's complete reply. The driver this replaced ended with
   `if (interrupted) fail('turn timed out')`; losing that was a regression.

Plus one the reviewer found in the host: **it did not wind down when its daemon
died mid-turn**, though its own comment said it did — the EOF branch only handled
the no-turn-yet case, so an orphaned host kept a live model session running.

### Round 3: the defeat battery, and my first fix failing it

The reviewer then derived, **before this fix was written**, the full set of ways
to get a module into the daemon's heap past an import-graph walk. Two results
matter more than the rest.

**A0 — one character.** `extractImports`'s specifier group is `['"]`, so
``await import(`@anthropic-ai/claude-agent-sdk`)`` is invisible to it. No
indirection, no new idiom: a backtick instead of a quote, which is what a
half-finished interpolation or an argument about autoformatting leaves behind.
Nothing else in the repo caught it either.

**And my first fix for the `createRequire` finding failed its own battery.** It
followed `const req = createRequire(…)` and was defeated by
`createRequire as cr` — a guard pinned to one spelling of the thing it guards,
which is the same defect a third time, in the fix for the second one. I found
that by building the reviewer's battery and running it against my own work,
which is the only reason it is not still there.

So the fix is a **ban, not a parser**. Three of the thirteen shapes
(`require(a + b)`, `await import(r.resolve(x))`, a requirer exported across a
module boundary) cannot be resolved by any static walker, and the rest differ
only in where the requirer is parked — a const, an alias, a property, a rebound
binding. Chasing them is an arms race the walker loses. The daemon's graph may
not hold the capability at all: `createRequire` must be obtained before it can
be hidden, so banning the token bans every spelling of every shape at once.
Files that need it are listed with the exact specifiers they may load, and that
list is checked — an allowance that does not pin its own specifiers is a hole
with a comment on it.

Measured after the fix, all fourteen shapes red including the three controls:

```
S0   RED  quoted static import          A3   RED  alias of the requirer
S0b  RED  quoted await import()         A4   RED  requirer on a property
S0c  RED  quoted require()              A5   RED  resolve then import
A0   RED  template-literal import       A6   RED  concatenated specifier
A0b  RED  template-literal requirer     A7   RED  requirer exported across modules
A1   RED  direct createRequire call     A8   RED  rebound requirer
A2   RED  the house idiom               A2b  RED  house idiom under an import alias
```

Before the fix: **3 controls red, 10 defeats green.** The shapes now live as a
table in `claude-sdk-isolation.test.ts` so they run in CI, plus
`defeat-battery.sh` here which drives the whole test against a really-modified
file. Removing the ban turns nine of the table entries red. There is also a
false-positive control on ordinary code, because a ban that fires on everything
is not a guard — it is noise that gets deleted.

### A claim I overstated, corrected

Commit `4cef94ec1` says the isolation test was "proven to go red four ways,
including a two-hop re-export on which a grep scores zero matches". **The fourth
way did not test that.** Its chain was a plain two-hop *import*; blinding
re-export edges entirely left the suite green — a vacuity control that was itself
vacuous. The control now builds a real `export … from` chain on disk. The
capability was never unguarded (the boundary suite catches it 16 ways), but the
sentence in that commit message was wrong and this is the correction.

## Five wrong observables, recorded because the next person will reach for them

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
4. **`drive-verify.sh`'s own check 4 could not fail** — the worst one, because it
   was in the script whose stated job is refusing unproven measurements. It
   grepped `/proc/<daemon>/map_files` and `/proc/<daemon>/fd` for the package
   name. A JS module is `read()` and closed, never mmapped, so a process holding a
   **callable `query()`** shows:

   ```
   /proc/<pid>/maps      matching claude-agent-sdk : 0
   /proc/<pid>/map_files matching                  : 0
   /proc/<pid>/fd        matching                  : 0
   /proc/<pid>/maps      mentioning anthropic      : 0
   ```

   Measured directly, not argued. There is no external detector for "this process
   has a JS module loaded", so the script stopped pretending: the property is
   static, and check 4 now runs the isolation walk against the commit the running
   processes were started from — which checks 1 and 2 have already tied to those
   processes. Side by side on the same live daemon with the SDK reintroduced
   through `createRequire`: the old check printed `map_files=0 fd=0 → VERIFIED`;
   the new one exits non-zero with *the SDK is reachable from a daemon-hosting
   entry point*.
5. A vacuity control that was itself vacuous — see the round-2 section above. If
   you write a control to prove a walker can see mechanism X, break X and watch
   the control go red, or you have tested nothing.
