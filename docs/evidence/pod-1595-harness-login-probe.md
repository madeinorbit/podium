# POD-1595 — "no agent can start: harnesses read logged out"

**Verdict: not a rewrite regression.** The login probe is correct and unchanged.
The `out` readings are caused by the *instance* the smoke stack was launched
under, not by the branch. `main` produces byte-identical `out` readings on this
same box under the same instance env.

Measured 2026-08-03 on `ludovico`, integration `d15983e9` vs `main`.

## Root cause

`resolveAgentHomeDir()` (`packages/runtime/src/config.ts:499`) returns the
operator's `HOME` **only for the `default` instance**. For any *named* instance
it returns `<stateDir>/agent-home`:

```ts
env.PODIUM_AGENT_HOME ||
config.agentHome ||
(resolveInstanceId(env) === 'default'
  ? home
  : join(instanceStateDir(resolveInstanceId(env), env, home), 'agent-home'))
```

The daemon passes that value straight into the inventory probe
(`apps/daemon/src/host-runtime.ts:88` → `apps/daemon/src/control/inventory.ts`
→ `buildMachineInventory({ homeDir })`), so `detectLogin()` looks for
`<stateDir>/agent-home/.claude/.credentials.json`.

The running smoke stack was:

```
PODIUM_INSTANCE=rewrite-smoke
PODIUM_STATE_DIR=/tmp/claude-1000/.../scratchpad/rewrite-state
HOME=/home/mgw            (unchanged)
```

`<stateDir>/agent-home` **did not exist**. Hence `out`.

`resolveInstanceId()` reads `PODIUM_INSTANCE` only — `PODIUM_STATE_DIR` alone
does *not* trigger this (see experiment B below). The named instance did.

## The probe is truthful, not wrong

Session spawn applies the same root as the agent's `HOME`
(`apps/daemon/src/control/session.ts:240`):

```ts
...(ctx.homeDir ? { HOME: ctx.homeDir } : {}),
```

So an agent started by the `rewrite-smoke` instance really would run with
`HOME=<stateDir>/agent-home`, where `claude` has no credentials. The probe and
the launcher agree. Reporting `in` here would be a lie, and the start would then
fail one layer deeper inside the harness.

This isolation is deliberate and documented — `docs/multi-instance.md:46`:

| Native-agent `HOME` | the operator's `HOME` | `<state>/agent-home` | `PODIUM_AGENT_HOME` or config `agentHome` |

## Experiments (all on ludovico, 2026-08-03)

| # | Checkout | Env | claude-code login |
|---|----------|-----|-------------------|
| A | rewrite `d15983e9` | none | `{"state":"in","account":"mike.wirth@gmail.com"}` |
| B | rewrite `d15983e9` | `PODIUM_STATE_DIR=<tmp>` | `{"state":"in","account":"mike.wirth@gmail.com"}` |
| C | rewrite `d15983e9` | `PODIUM_INSTANCE=rewrite-smoke` + `PODIUM_STATE_DIR=<tmp>` | `{"state":"out"}` |
| D | **`main`** | same as C (the live smoke stack's own env) | `{"state":"out"}` |
| E | rewrite `d15983e9` | C + `PODIUM_AGENT_HOME=$HOME` | `{"state":"in","account":"mike.wirth@gmail.com"}` |

C reproduces the reported inventory exactly, including `codex`/`grok` → `out`
and `opencode`/`cursor` → `unknown`, with all five versions still detected
(the bare-name `binCandidates` fallback resolves via `PATH`).

**D is the disproof of the premise.** `main`'s own
`packages/agent-bridge/src/inventory/build-inventory.ts`, run in the `main`
checkout under the smoke stack's env, reports the same three harnesses `out`.
The live `main` instance reads `ready` only because it runs as the `default`
instance.

The relevant code is identical across the two branches:

- `detectLogin` for `claude-code` — byte-identical (`main:packages/agent-bridge/src/harness/adapters/claude-code.ts` vs `packages/harness/src/manifests/claude-code.ts`)
- `resolveAgentHomeDir` — byte-identical
- daemon wiring — `main:apps/daemon/src/daemon.ts:425` and `apps/daemon/src/host-runtime.ts:88` are the same line

## Immediate unblock

Launch the smoke stack with the documented escape hatch (experiment E):

```
PODIUM_AGENT_HOME=$HOME
```

No code change, no lie in the inventory — the instance then shares the
operator's harness logins and agents start.

## The real defect this exposes

A **named instance is unusable out of the box**: its `agent-home` is never
created or provisioned, so every harness is genuinely logged out and no agent
of any kind can start until the operator finds `PODIUM_AGENT_HOME`. That is a
pre-existing product gap on `main`, not a rewrite blocker, and it needs a
product decision rather than a patch here:

1. seed a named instance's `agent-home` at bootstrap (link/copy harness
   credential files), or
2. default a named instance to the operator's `HOME` and make isolation opt-in, or
3. leave the behavior and surface the reason + the fix in the UI, instead of a
   flat `claude-code is not logged in on machine 'ludovico'`.

Option 3 is worth doing regardless: the error names the machine, which sends
every reader to the machine's real login state, and hides the instance that
actually decided the answer.
