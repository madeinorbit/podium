# POD-3059 — the named instance's SDK transcript, and the home it was written in

On a named instance `sessions.read` answered `items: []` for a Claude SDK
session that had really talked — every item type, the user's own prompt
included. The record existed; the reader was looking somewhere else.

Based on the POD-1761 coordinator root `3abaaee18`, and the defect is live
there: the tip already carries the POD-2296/POD-2692 isolation work, but that
work redirects a harness's *state selector* into the instance home
(`harnessInstanceEnv` → `CODEX_HOME`, `GROK_HOME`). `claude-code` declares no
`instanceHome` selector, so for that harness `HOME` alone decides where the
record lands — and `HOME` was the key being reverted.

## The split, exactly

| | path it used |
|---|---|
| reader | `ctx.homeDir` → `<state>/<instance>/agent-home/.claude/projects/<slug>/<resume>.jsonl` |
| child (before) | `commandEnvironment.machineHome` → `$HOME/.claude/projects/<slug>/<resume>.jsonl` |

`apps/daemon/src/control/headless.ts` builds the child environment correctly:
the machine's recovered command environment as the base, then the
instance-owned keys — `HOME` among them — layered on top. Two places then put
the command environment back on top of that:

1. `durable-headless.ts` `prepareInvocation()` returned
   `{ ...snapshot.commandEnvironment.env }` from its `claude-sdk` branch as if
   it were adapter env. It is a duplicate of the base `spec.env` already
   carries, and at the spawn (`{ ...spec.env, ...execEnv, … }`) it won.
2. `packages/harness/src/executable-runtime.ts` `effectiveEnv()` folds the same
   command environment into EVERY adapter's exec env, so the identical
   inversion was reachable for codex — whose exec env was only ever meant to
   carry a per-turn MCP bearer (POD-1021).

Either way the child's `HOME` reverted to the operator account home, and the
harness wrote its JSONL where the reader does not look.

## Which home is authoritative

The instance's agent home. That is already what a PTY session on a named
instance runs under, what the in-process SDK driver runs under, what
`sessions.read` resolves against, and what Podium reports login state for
(`harnessLoginReadEnv`, POD-2692, whose own doc comment says a child left on
the daemon's `HOME` "reads and writes the operator's REAL auth files … from
inside a supposedly isolated instance"). The durable headless path was the one
place that quietly opted out. Aligning it closes a credential-isolation hole as
well as the empty read.

**Consequence, stated plainly:** a named instance whose agent home has no
credentials was previously served by the operator's login through this leak.
It now reports and behaves as what it is — logged out — until that home is
logged in. The `docs/evidence/pod-3050` rig asserts its isolated agent home is
credential-FREE, so that rig needs a logged-in agent home before it can drive
an SDK turn again.

## The fix

`headlessSpawnEnv()` states the rule once, for both spawn sites: the adapter
contributes the keys the instance did not decide, and never overrides the ones
it did. An instance-owned key is one whose value differs from the machine
command environment's — precisely `HOME`, the relay routing and the CLI
binding, and precisely not `PATH`, which an adapter may still resolve
differently. The tip's own `harnessInstanceEnv` layer stays last in the durable
spawn, so a harness that *does* declare a state selector still follows it.

(The name is `headlessSpawnEnv`, not `headlessChildEnv`: the tip already owns
that name for the FULL child env this overlay feeds.)

## What was measured

`apps/daemon/src/durable-headless.test.ts` — "runs the claude child under the
instance-owned HOME, not the machine home". A real durable turn: `writeRunner`
→ abduco → child. The fake harness writes `$HOME` to a receipt file and the
test reads that back. It asserts the home the child process ACTUALLY ran with,
not the merge expression.

The two halves are deliberately redundant, and the mutations say so:

| mutation | result |
|---|---|
| restore `env: { ...snapshot.commandEnvironment.env }` on the `claude-sdk` branch | GREEN — the ordering rule alone still holds `HOME` |
| make adapter env win again (`{ ...base, ...execEnv }`) | RED — `headlessSpawnEnv > keeps the instance HOME when the adapter env carries the machine HOME` |
| BOTH reverted (the pre-fix code) | RED — `expected '/tmp' to be '…/pod-hh-…/agent-home'`: the machine home is back and the original defect is reproduced |

Lanes run (`PODIUM_TEST_WORKERS` unset — with it set to 1 the repo's default
gate is red by environment, not by any change):

- `bun run typecheck` — 25/25 successful.
- `apps/daemon` package tests — 1303 passed, 5 skipped, **9 failed**. All 9
  reproduce at a clean root (the same four files checked back out to the tip:
  1300 passed / 9 failed, identical names), so none is this change; the delta
  is exactly the +3 new unit tests. That baseline was taken at `593e40ef5` and
  still holds: `git diff 593e40ef5..3abaaee18 -- ':!docs'` is empty, so every
  root advance since has been documentation alone.
- `vitest.integration.config.ts` for `durable-headless.test.ts` — 7/7.

## What this does NOT show

No live drive on a named instance. The `docs/evidence/pod-3050` rig refuses to
place credentials in its isolated agent home, and with this fix an SDK turn in
that home is genuinely logged out — so the rig cannot round-trip a real
conversation through `sessions.read` until its agent home is logged in. The
mechanism is measured at the spawn instead: the home the child ran with.

Separately, `sessions.read` still projects away `toolResult`/`toolUseId`/`id`
(POD-3061), so a transcript that now resolves still will not show a tool call
joined to its result.
