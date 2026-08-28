# POD-3057 — the SDK session that read back empty, and the home it was written in

A Claude session on the Agent SDK held a real conversation and read back as an
empty session. `sessions.read` answered `items: []`; `sessions.recap` said *"No
transcript items found for this session."* The session stream — what a viewer
watches live — had the whole thing.

Driven on `p3057n`, a rig of this issue's own, because `p3047n` was up and being
driven by the acceptance session at the same moment.

## The two arms

Same rig, same probe, one commit apart. `read-check.ts` creates a `claude-sdk`
session, sends one prompt carrying a needle, waits for the needle to come back
on the session stream, and only then reads. Both planes are reported side by
side, and so is the disk.

| | before (`90ebca7d9`) | after (`96f53857e`) |
|---|---|---|
| session stream | 2 items, needle present | 2 items, needle present |
| `sessions.read` | **0 items** | **2 items, needle present** |
| `sessions.recap` | "No transcript items found for this session." | "1 user / 1 assistant turns", both quoted |
| JSONL in the reader's home | **no project directory at all** | present, holds the needle |
| JSONL in the operator's home | present, holds the needle | **absent** |

**The before arm is a recheck at the coordinator root, not an older reading.**
`90ebca7d9` CONTAINS `ccdea1f93` — POD-3059's fix — one documentation commit
ahead of it, so the empty read above was measured with that fix in place. This
branch is now rebased onto `ff815f3d1`; the advance from the pinned tip is
documentation only, and the fix's patch-id is unchanged across the rebase.

Readings: `readings/read-check.before.json`, `readings/read-check.fix.json`.
Each carries its own pin — the commit read back out of the server and daemon
processes that actually served it, refusing the cell unless both are the
checked-out HEAD and the product tree is clean against it.

## A second, independent pre-fix arm

POD-3047's acceptance drive measured the same tip on its own rig (`p3047n`,
credential-free isolated home) and its readings are a stronger statement of the
defect than an empty session would be, because in both of them the record is
demonstrably THERE while the read cannot see it:

| reading | on the session stream | `sessions.read` at the same instant |
|---|---|---|
| `claude-sdk.a3.json` | 1 persisted interrupt record | **0 items** |
| `claude-sdk.a5.json` | tool call and its result, both present | **0 items** |

Both at pin `90ebca7d9`. That rules out "the turn never produced anything" as an
explanation without needing my needle at all — two rigs, two probes, one
boundary: the plane that watches has the record, the plane that reads does not.

## The mechanism

| | path it used |
|---|---|
| reader | `ctx.homeDir` → `<state>/<instance>/agent-home/.claude/projects/<slug>/<resume>.jsonl` |
| child (before) | the daemon's own `HOME` → `$HOME/.claude/projects/<slug>/<resume>.jsonl` |

`apps/daemon/src/control/session.ts` builds a contract session's `SessionSpec`
with `env: msg.env` — the spawn frame's server-resolved managed credentials,
which name no home, because the server does not know one. The SDK host child is
spawned with `headlessChildEnv(spec.agent, spec.env)` over `process.env`
(`claude-sdk-client.ts`), so with no `HOME` in that overlay it kept the
daemon's. `claude-code` declares no `instanceHome` state selector, so for this
harness `HOME` alone decides where the record lands.

Every other family already had this: the PTY path sets `HOME` from `ctx.homeDir`
(`control/session.ts`), the server drivers get it through `serverChildEnv`
(POD-2247), and the durable headless path was aligned by POD-3059. The embedded
SDK child was the one child nobody gave a home.

## Which home is authoritative

The instance's agent home — the same answer POD-3059 recorded, for the same
reasons, and this is the path its fix did not travel. It is what `sessions.read`
resolves against, what a PTY session on a named instance runs under, and what
Podium reports login state for. Aligning it also closes a credential-isolation
hole: a child on the daemon's `HOME` reads and writes the operator's real auth
files from inside an instance that is supposed to be isolated.

**Consequence, stated plainly:** a named instance whose agent home is not logged
in now behaves as what it is, instead of borrowing the operator's login by
accident. This rig therefore logs its agent home in — by SYMLINK to the operator
credential the pre-fix child was already using, so the two arms differ in the
home and not in the account, and the rig adds no exposure the behaviour under
test did not already have. A rig that refuses credentials in its agent home (as
`docs/evidence/pod-3050` does) cannot drive an SDK turn on this path at all.

**A symlink rather than a copy, and the reason is not tidiness** (POD-3047's
point, worth recording as a rule): a copied Claude credential can go stale, and
presenting a superseded refresh token can be treated as replay and revoke the
whole family — which would log the OPERATOR out of their own tool. A symlink
cannot diverge, so that failure mode does not exist for it.

The write-through caveat belongs with it: a refresh by the SDK child writes to
the operator's real file. That is not a regression of this rig — before the fix
the child ran IN the operator home and already wrote there — but it is the
reason the choice is a symlink to the real file rather than a second copy of it.

## What the tests assert

Two halves of one chain, so neither can pass by restating the other:

- `runtime/claude-sdk-driver.test.ts` — the instance home reaches the turn spec
  the child is built from, and OUTRANKS a spawn frame that names another home
  (the machine home arriving exactly as it really arrives). A second test holds
  the default instance still: no agent home, no invented `HOME`.
- `claude-sdk-client.test.ts` — a REAL child process spawned from that spec
  prints the `HOME` and `CLAUDE_CONFIG_DIR` it actually ran under. The claim is
  about a process's environment, and a test that re-read the merge expression
  would be asserting the fix against itself.

Mutations, each applied alone and reverted after:

| mutation | result |
|---|---|
| restore the pre-fix `env: { ...input.spec.env }` | RED — `runs the SDK child under the instance agent home, over the spawn frame env` |
| let the spawn frame win (`{ ...instanceEnv, ...input.spec.env }`) | RED — `expected { HOME: '/home/operator', … }` |
| strip `HOME` in `claudeSdkHostEnv` | RED — `expected 'undefined\|…' to be '/state/p3057/agent-home\|…'` |

## Lanes

`PODIUM_TEST_WORKERS=1` was **set** in this session's environment — stated
because the repo's default gate is red or green by that variable, so a number
taken without saying which it was is not comparable to one that was.

**Typecheck** — `bun run typecheck`: 25 successful, 25 total.

**Focused** — `runtime/claude-sdk-driver.test.ts` + `claude-sdk-client.test.ts`,
which is where all three new tests live, the real-child spawn among them
(*spawns the host under the HOME the turn spec names* runs an actual process and
reads its `HOME`/`CLAUDE_CONFIG_DIR` back off stdout):

```
 Test Files  2 passed (2)
      Tests  26 passed (26)
```

Re-run unchanged after rebasing onto the coordinator tip.

**`apps/daemon` package**, verbatim:

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 9 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  5 failed | 105 passed | 1 skipped (111)
      Tests  9 failed | 1306 passed | 5 skipped (1320)
```

**The nine are inherited, and the arithmetic is the argument.** POD-3059
recorded 1303 passed / 9 failed at this root; my commit is the only non-docs
change since (`git diff 90ebca7d9 ff815f3d1 -- . ':!docs'` is empty, and every
root advance in between is documentation); 1303 + the 3 tests added here = 1306,
with the failure count unmoved. Classified individually rather than as a
cluster, and none is in a file this change touches:

| file | n | why it fails here |
|---|---|---|
| `instance-bootstrap.test.ts` | 1 | `ABDUCO_SOCKET_DIR` inherited from the ambient session — `expected '/run/user/1001/podium-blue'` |
| `harness-exec.test.ts` | 2 | an opencode binary installed on this box resolves to an absolute path (`/home/mgw/.opencode/bin/opencode`) where the test expects the bare name |
| `headless-drivers.test.ts` | 1 | codex MCP bearer argv shape, same environmental class |
| `server-reap.test.ts` | 4 | teardown-frame suite, red at the clean root |
| `opencode-attach.test.ts` | 1 | runs opencode's own client; not present in this environment |

## What this does NOT show

`sessions.read` still projects away `toolResult` / `toolUseId` / `id`
(POD-3061), so a transcript that now resolves still will not show a tool call
joined to its result. That is a different plane and a different issue; this one
is about whether the read returns the conversation at all.

Nothing here re-scores any acceptance cell. Cells that were read on
`sessions.read` before this commit were read on a plane that could not answer,
and the direction is one-way: an empty read can only make a cell look worse, so
no passing cell is at risk. POD-3047 and POD-3036 are told.
