# Agent relay environment naming migration (POD-547)

**Status:** approved design, pre-implementation
**Supersedes:** POD-527 (broken/unreachable — its branch has no commits)

## Problem

`PODIUM_ISSUE_RELAY` was named when it was only the `podium issue` CLI transport. It
now does far more: the daemon injects it into every spawned agent to (a) *identify* a
Podium-managed agent session and (b) carry generic router/procedure commands for
**issues, messages, sessions, specs, workflows, locks, approvals, agent spawn/await,
and worktree reporting**. The name lies about the scope.

Two concrete harms follow from the misnaming *and* from how the value is inherited:

1. **Misleading name.** Every read/injection/guidance string says "issue relay" for
   what is really the agent session's whole command channel.

2. **Ambient inheritance leaks session identity.** The relay endpoint URL bakes the
   session id into its path, and it lives in `process.env`. Any process that inherits
   the agent's environment silently *becomes* that session:
   - **Harness subagents / forks** share the parent's process env, so a subagent that
     runs `podium issue attach` re-homes the **parent** session (observed 2026-07-13:
     an investigator dispatched onto #439 re-homed the whole session off #219). This
     cannot be auto-detected — a subagent's `Bash` calls are indistinguishable at the
     OS level from the main agent's.
   - **Test runners / isolated-instance drivers** run inside a live session and
     inherit `PODIUM_ISSUE_RELAY` (+ `PODIUM_SESSION_ID`, `PODIUM_PORT`, and a default
     `~/.podium` state dir). The CLI even warns it is "ignoring PODIUM_STATE_DIR/PORT
     and routing via this session's relay." So a test that spins up an isolated Podium
     and drives it via the CLI actually hits the **live** instance. There is no global
     test-env scrub protecting against this today.

## Goals

- Rename the env var to a truthful generic name: **`PODIUM_AGENT_RELAY`**.
- Rename the internal identifiers and loopback path to match (bandaid off): the
  daemon module, the hub/server/env helpers, the daemon↔server protocol messages, and
  the `/issue/<sessionId>` loopback path → `/agent/<sessionId>`.
- Provide a supported way to shed the inherited relay in nested/subagent/test contexts
  so they stop acting as the parent session: **`PODIUM_NO_RELAY`**.
- **Completely resolve** isolated-instance testing: a hermetic test-env harness so
  `bun run test` / `vitest` run from inside a live session can neither touch nor be
  hijacked by the live instance.

## Non-goals

- **No dual injection.** The daemon writes only the new env name and only the new
  `/agent/` path.
- **Removing** the read-side legacy tolerance (see "Compatibility") is deferred to a
  follow-up issue after one release.

## Decisions (human-approved)

| Decision | Choice |
|----------|--------|
| New env var name | `PODIUM_AGENT_RELAY` (identifies the agent session + its whole command channel; broader than "session") |
| Inheritance fix | Explicit escape hatch `PODIUM_NO_RELAY` (auto-detection is impossible — subagents share the parent env) |
| Internal + path rename | In scope — full rename incl. `/issue/`→`/agent/` path and protocol messages |
| Dual injection | **No** — write only the new name/path |
| Compatibility | **Read-side tolerance for one release**: accept the old env name and the old path on read; never write them. Removed in a follow-up. |
| Test isolation | First-class goal — hermetic test-env harness |

## Design

### 1. Central accessor — single resolution + escape hatch

`packages/runtime/src/config.ts`:

```ts
/** Daemon-injected agent-relay endpoint for a constrained agent process (env-only —
 *  set by apps/daemon per session; never configured by the operator).
 *  PODIUM_NO_RELAY forces "act as operator / not this session" — used by nested
 *  subagent contexts and the hermetic test harness to shed an inherited relay.
 *  Reads the new name, falling back to the legacy PODIUM_ISSUE_RELAY for one release
 *  (in-flight sessions spawned before the cutover still carry it). */
export function resolveAgentRelay(env: EnvSource = process.env): string | undefined {
  if (env.PODIUM_NO_RELAY) return undefined
  return env.PODIUM_AGENT_RELAY ?? env.PODIUM_ISSUE_RELAY
}
```

- `resolveIssueRelay` is removed; all importers switch to `resolveAgentRelay`.
- The five sites that read `process.env.PODIUM_ISSUE_RELAY` **directly** (`cli.ts:218`
  agent-session detection, `agent-cli`, `workflow-cli`, `mail-cli`, `session-cli`) are
  routed through `resolveAgentRelay()`. This is what makes the dual-read *and* the
  `PODIUM_NO_RELAY` escape hatch apply everywhere instead of only the accessor callers.
- Update the `PODIUM_*` inventory table in `config.ts` (add `PODIUM_AGENT_RELAY`,
  `PODIUM_NO_RELAY`; note the legacy alias is read-only for one release).

### 2. Injection — new name/path only

`apps/daemon/src/control/session.ts`: `issueRelayEnv` → `agentRelayEnv`, returning
`{ PODIUM_SESSION_ID, PODIUM_AGENT_RELAY }` (no `PODIUM_ISSUE_RELAY`).

### 3. Internal + path rename

- `apps/daemon/src/issue-relay.ts` → `apps/daemon/src/agent-relay.ts`.
- `createIssueRelayHub`→`createAgentRelayHub`, `startIssueRelayServer`→
  `startAgentRelayServer`, `IssueRelayRequest|Result|Hub`→`AgentRelay*`,
  `DEFAULT_ISSUE_RELAY_PORT`→`DEFAULT_AGENT_RELAY_PORT`,
  `issueRelayEndpointFor`→`agentRelayEndpointFor` (daemon context + daemon.ts).
- Loopback path: `endpointFor` emits `/agent/<sessionId>`.
- Daemon↔server protocol messages `issueRelayRequest`/`issueRelayResult` →
  `agentRelayRequest`/`agentRelayResult` (protocol + server dispatch + daemon hub).
  Safe to rename outright: daemon and server ship in one binary and upgrade together
  (unlike the daemon↔agent-CLI hop, which crosses process/version boundaries via env).
- Comments/strings that say "issue relay" for the transport → "agent relay".

### 4. Read-side compatibility (one release)

The daemon↔agent-CLI hop is the only place old and new can mix, because a running
agent keeps its spawn-time env and baked URL across a daemon redeploy:

- **Env name:** `resolveAgentRelay` accepts `PODIUM_ISSUE_RELAY` as a fallback (§1).
- **Loopback path:** the relay HTTP server matches `^/(?:issue|agent)/([\w.-]+)$` so an
  in-flight session still POSTing to `/issue/<sid>` is served by the new daemon.

Neither old name/path is ever *written*. A follow-up issue removes both after a release.

### 5. `PODIUM_NO_RELAY` — the guard, made concrete

With the relay shed (`PODIUM_NO_RELAY` set, or simply absent):
- Read/query commands fall back to the operator path (`http://localhost:<port>`), which
  still works for reads. This does not expand the trust boundary — the loopback relay
  is already documented as a guardrail for well-behaved agents, not a sandbox against a
  co-located process that can forge any session id.
- Identity-mutating commands — `issue attach`, `session title`, `worktree` — hit their
  existing "not in an agent session" errors instead of silently mutating the parent's
  identity. That is the guard: a subagent brief that starts with
  `export PODIUM_NO_RELAY=1` can no longer re-home the parent.

### 6. Hermetic test-env harness (completely resolve isolated testing)

Add a global setup that neutralizes the ambient Podium session env before any test:

- **vitest:** a `setupFiles` entry in `vitest.config.ts` and `vitest.unit.config.ts`.
- **bun test:** a preload for the `test:bun` scripts (`--preload` or an imported
  setup module) so `bun test` targets get the same scrub.

The setup:
```ts
for (const k of ['PODIUM_AGENT_RELAY', 'PODIUM_ISSUE_RELAY', 'PODIUM_SESSION_ID', 'PODIUM_PORT'])
  delete process.env[k]
process.env.PODIUM_NO_RELAY = '1'
// Point state at a per-run throwaway unless the suite sets its own.
process.env.PODIUM_STATE_DIR ??= <mkdtemp podium-test->
```

Net effect: a test that reads `process.env`/`stateDir()`/`resolveAgentRelay()` without
its own override lands on a throwaway instance, never `~/.podium`, `:18787`, or the
live session relay. The full suite is run under this harness and any test that was
secretly leaning on live/ambient env is fixed.

### 7. Guidance, spec, follow-up

- Update user-facing CLI strings (worktree-cli, session-cli, issue-cli, spec-cli,
  approval-cli, cli.ts help/comments).
- Record decisions in `pspec` (name, `PODIUM_NO_RELAY`, hermetic tests, read-side
  tolerance policy).
- File a `discovered-from` follow-up issue: remove read-side legacy tolerance (env
  fallback + `/issue/` path match) after one release.

## Testing strategy

- **Unit (config):** `resolveAgentRelay` — new name wins over legacy; legacy accepted
  alone; `PODIUM_NO_RELAY` forces `undefined` even when a relay is present.
- **Unit (daemon):** `agentRelayEnv` returns only `{ PODIUM_SESSION_ID,
  PODIUM_AGENT_RELAY }` (no legacy key).
- **Unit (relay server):** POST to `/agent/<sid>` works; POST to legacy `/issue/<sid>`
  still works (read-side tolerance); other paths 404.
- **CLI:** each relayed CLI resolves via the accessor; `PODIUM_NO_RELAY` routes to the
  operator client; identity-mutating commands error cleanly with the relay shed.
- **Harness:** a smoke test asserting the ambient scrub (relay/session/port unset,
  `PODIUM_NO_RELAY` set, state dir is a throwaway) is active under the test runner.
- Full `bun run test` green under the new hermetic harness.

## Rollout / risk

- Single self-hosted binary; daemon+server+CLI ship together. The only cross-version
  hop is daemon→agent-CLI, covered by §4 read-side tolerance.
- Landing + redeploy: in-flight sessions (incl. the implementing session) keep working
  via the legacy env/path fallback. New spawns use the new name/path exclusively.
- Follow-up removes the tolerance once no pre-cutover sessions remain.
