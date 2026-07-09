# Agent State Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect what state each agent session is in (working / idle / needs-user / errored / compacting / ended) from the agent harness's own structured signals, surface it in the UI, and offer a Continue button for retryable errors.

**Architecture:** A shared `AgentStateProvider` interface lives in `@podium/agent-bridge` (`src/agent-state/`); the Claude Code provider injects per-session hook config at spawn (`--settings <generated file>` with `type: "http"` hooks) so the harness POSTs lifecycle events to a small HTTP ingest server in the daemon. The provider translates harness-native payloads into normalized `AgentStateEvent`s; a pure reducer folds them into an `AgentRuntimeState` (a `@podium/protocol` type). The daemon forwards state changes over the existing daemon WS (`agentState` message); the server stores it on `Session`, includes it in `SessionMeta`, and rebroadcasts via the existing `sessionsChanged`. The web shows a phase badge per session row and a Continue button when errored+retryable (tRPC `sessions.continue` → server writes `continue\r` into the PTY).

**Tech Stack:** zod (protocol schemas), node:http (ingest), node-pty spawn path (existing), vitest, tRPC, React.

**Key background for the implementer (verified against Claude Code docs 2026-06):**
- Claude Code hooks support `"type": "http"`: POSTs the same JSON a command hook gets on stdin to a URL; the response body is the hook output. Returning `200` with `{}` = observe-only, never alters agent behavior.
- Every hook payload carries `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`.
- Events we use: `SessionStart`, `UserPromptSubmit`, `PreToolUse` (matcher `AskUserQuestion`), `PostToolUse` (activity heartbeat), `PermissionRequest`, `Notification` (matcher `permission_prompt`), `Stop`, `StopFailure` (error class as matcher: `rate_limit`, `overloaded`, `server_error`, `billing_error`, `authentication_failed`, …), `TaskCreated`/`TaskCompleted`, `PreCompact`/`PostCompact`, `SessionEnd`.
- `claude --settings <path>` layers an extra settings file (where we put the hooks) without touching the user's or repo's settings.
- Transcript JSONL lines look like `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"…"},{"type":"tool_use","name":"TodoWrite","input":{…}}]}}`.

**Risk notes (handle, don't skip):**
- Exact field names in `StopFailure`/`Notification` payloads are not fully documented — translate defensively (try several keys, fall back to `'unknown'`) and `console.warn` once per unknown shape. Task 10 verifies against the real CLI.
- The hook endpoint URL is baked into a settings file at spawn; durable (abduco) sessions outlive daemon restarts, so the ingest port must be **stable**: default fixed port `45777`, ephemeral fallback only if taken.
- After the protocol change, the long-lived dev Vite server serves a stale `@podium/protocol` — restart `podium-web` when deploying (see memory `podium-web-stale-vite`); deploy web + backend together.

**Execution context:** Create an isolated worktree from `main` at execution start (superpowers:using-git-worktrees). The main checkout is dirty with another feature branch — do not work there. Re-check where local `main` points before branching (sibling worktrees move it). Run `bun install` once in the fresh worktree with output redirected to a file.

Run tests with `bun run vitest run <file>` from the repo root (vitest workspace picks up all packages/apps).

---

### Task 1: Protocol — `AgentRuntimeState`, `SessionMeta.agentState`, `agentState` daemon message

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Test: `packages/protocol/src/messages.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/protocol/src/messages.test.ts` (follow the file's existing describe style):

```ts
describe('agent runtime state', () => {
  const state = {
    phase: 'errored',
    since: '2026-06-12T10:00:00.000Z',
    openTaskCount: 2,
    error: { class: 'rate_limit', retryable: true },
  }

  it('round-trips an agentState daemon message', () => {
    const msg = { type: 'agentState', sessionId: 's1', state }
    expect(parseDaemonMessage(encode(msg as never))).toEqual(msg)
  })

  it('rejects an unknown phase', () => {
    const bad = { type: 'agentState', sessionId: 's1', state: { ...state, phase: 'napping' } }
    expect(() => parseDaemonMessage(JSON.stringify(bad))).toThrow()
  })

  it('SessionMeta accepts an optional agentState', () => {
    const meta = SessionMeta.parse({
      sessionId: 's1',
      agentKind: 'claude-code',
      title: 't',
      cwd: '/tmp',
      status: 'live',
      controllerId: null,
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 0,
      createdAt: '2026-06-12T10:00:00.000Z',
      origin: { kind: 'spawn' },
      agentState: { phase: 'idle', since: '2026-06-12T10:00:00.000Z', openTaskCount: 0, idle: { kind: 'question', summary: 'Should I migrate?' } },
    })
    expect(meta.agentState?.phase).toBe('idle')
  })
})
```

Import `SessionMeta` in the test file's existing import from `./messages` if not already there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run vitest run packages/protocol/src/messages.test.ts`
Expected: FAIL (unknown message type `agentState`, `agentState` key stripped/unknown).

- [ ] **Step 3: Implement the schemas**

In `packages/protocol/src/messages.ts`, insert after the `SessionStatus` block (line ~22):

```ts
// ---- Agent runtime state (harness-observed, distinct from SessionStatus) ----
// SessionStatus says whether the PTY/process is alive (starting/live/hibernated/…).
// AgentRuntimeState says what the agent inside it is doing, derived from harness
// side-channels (hooks). `unknown` = uninstrumented agent kind or no events yet.
export const AgentPhase = z.enum([
  'unknown',
  'working',
  'idle',
  'needs_user',
  'errored',
  'compacting',
  'ended',
])
export type AgentPhase = z.infer<typeof AgentPhase>

// Why did the agent go idle? `open_todos` = stopped with unfinished task list;
// `question` = last message reads like it wants an answer; `approval` = stopped
// while in plan mode. Tier-3 (LLM classification) will refine this later.
export const IdleVerdict = z.object({
  kind: z.enum(['done', 'question', 'approval', 'open_todos']),
  summary: z.string().optional(),
})
export type IdleVerdict = z.infer<typeof IdleVerdict>

export const AgentNeed = z.object({
  kind: z.enum(['question', 'permission']),
  summary: z.string().optional(),
})
export type AgentNeed = z.infer<typeof AgentNeed>

export const AgentError = z.object({
  class: z.string(), // harness error class, e.g. rate_limit / server_error / billing_error
  retryable: z.boolean(), // true → a blind "continue" is worth offering
})
export type AgentError = z.infer<typeof AgentError>

export const AgentRuntimeState = z.object({
  phase: AgentPhase,
  since: z.string(), // ISO 8601 of the last phase change
  openTaskCount: z.number().int().nonnegative(),
  idle: IdleVerdict.optional(), // present when phase === 'idle'
  need: AgentNeed.optional(), // present when phase === 'needs_user'
  error: AgentError.optional(), // present when phase === 'errored'
})
export type AgentRuntimeState = z.infer<typeof AgentRuntimeState>
```

In `SessionMeta`, after `origin: SessionOrigin,` add:

```ts
  agentState: AgentRuntimeState.optional(),
```

In the daemon→server section (near `TitleMessage`), add:

```ts
// Harness-observed agent state changed (hooks-driven). Low-frequency: phase
// transitions only, never per-frame.
export const AgentStateMessage = z.object({
  type: z.literal('agentState'),
  sessionId: z.string(),
  state: AgentRuntimeState,
})
```

Add `AgentStateMessage,` to the `DaemonMessage` discriminated union.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run vitest run packages/protocol/src/messages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(protocol): AgentRuntimeState, SessionMeta.agentState, agentState daemon message"
```

---

### Task 2: agent-bridge — event types + pure state reducer

**Files:**
- Create: `packages/agent-bridge/src/agent-state/types.ts`
- Create: `packages/agent-bridge/src/agent-state/reducer.ts`
- Create: `packages/agent-bridge/src/agent-state/index.ts`
- Modify: `packages/agent-bridge/src/index.ts`
- Test: `packages/agent-bridge/src/agent-state/reducer.test.ts`

- [ ] **Step 1: Create `types.ts`**

```ts
import type { AgentRuntimeState } from '@podium/protocol'

/**
 * Normalized cross-agent lifecycle events. Providers translate harness-native
 * payloads (e.g. a Claude Code hook POST body) into these; one shared reducer
 * folds them into AgentRuntimeState. A provider that can only emit a subset
 * degrades to coarser states instead of breaking the model.
 */
export type AgentStateEvent =
  | { kind: 'session_started' }
  | { kind: 'prompt_submitted' }
  /** Liveness heartbeat (tool use etc.) — anything that proves the agent is computing. */
  | { kind: 'activity' }
  | { kind: 'needs_user'; need: 'question' | 'permission'; summary?: string }
  /** Turn ended cleanly. Verdict (when the provider can classify) excludes
   *  'open_todos' — that upgrade is reducer-owned (it tracks the task counter). */
  | { kind: 'turn_completed'; verdict?: { kind: 'done' | 'question' | 'approval'; summary?: string } }
  | { kind: 'turn_failed'; errorClass: string; retryable: boolean }
  | { kind: 'compaction'; phase: 'start' | 'end' }
  | { kind: 'task_delta'; delta: 1 | -1 }
  | { kind: 'session_ended' }

/** What a provider injects at spawn so the harness reports events. */
export interface AgentInstrumentation {
  /** Extra argv appended to the agent CLI. */
  args: string[]
  /** File the daemon must write before spawning (hook/settings config). */
  file?: { path: string; contents: string }
}

export interface AgentStateProvider {
  /** Spawn-time injection wiring the harness's event bus to `endpointUrl`. */
  instrumentation(opts: { endpointUrl: string; settingsPath: string }): AgentInstrumentation
  /** Translate one harness-native payload into zero or more normalized events.
   *  Async because some translations read the transcript (idle classification). */
  translate(payload: unknown): Promise<AgentStateEvent[]>
}

export type { AgentRuntimeState }
```

- [ ] **Step 2: Write the failing reducer tests**

`packages/agent-bridge/src/agent-state/reducer.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { initialAgentState, reduceAgentState } from './reducer'

const T0 = '2026-06-12T10:00:00.000Z'
const T1 = '2026-06-12T10:00:01.000Z'

describe('reduceAgentState', () => {
  it('starts unknown, goes idle on session_started', () => {
    const s0 = initialAgentState(T0)
    expect(s0.phase).toBe('unknown')
    const s1 = reduceAgentState(s0, { kind: 'session_started' }, T1)
    expect(s1).toMatchObject({ phase: 'idle', since: T1, openTaskCount: 0 })
  })

  it('prompt_submitted → working, clearing idle/need/error detail', () => {
    let s = initialAgentState(T0)
    s = reduceAgentState(s, { kind: 'turn_failed', errorClass: 'rate_limit', retryable: true }, T0)
    s = reduceAgentState(s, { kind: 'prompt_submitted' }, T1)
    expect(s.phase).toBe('working')
    expect(s.error).toBeUndefined()
  })

  it('activity while already working is a no-op (same reference)', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    const again = reduceAgentState(s, { kind: 'activity' }, T1)
    expect(again).toBe(s)
  })

  it('activity clears needs_user (the user answered)', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'needs_user', need: 'question', summary: 'pick one' }, T0)
    expect(s).toMatchObject({ phase: 'needs_user', need: { kind: 'question', summary: 'pick one' } })
    s = reduceAgentState(s, { kind: 'activity' }, T1)
    expect(s.phase).toBe('working')
    expect(s.need).toBeUndefined()
  })

  it('turn_completed defaults to done, upgrades to open_todos when tasks remain', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    expect(reduceAgentState(s, { kind: 'turn_completed' }, T1).idle).toEqual({ kind: 'done' })
    s = reduceAgentState(s, { kind: 'task_delta', delta: 1 }, T0)
    s = reduceAgentState(s, { kind: 'task_delta', delta: 1 }, T0)
    s = reduceAgentState(s, { kind: 'task_delta', delta: -1 }, T0)
    const idle = reduceAgentState(s, { kind: 'turn_completed' }, T1)
    expect(idle.idle?.kind).toBe('open_todos')
    expect(idle.openTaskCount).toBe(1)
  })

  it('a provider verdict (question/approval) outranks open todos', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'task_delta', delta: 1 }, T0)
    const idle = reduceAgentState(s, { kind: 'turn_completed', verdict: { kind: 'question', summary: 'A or B?' } }, T1)
    expect(idle.idle).toEqual({ kind: 'question', summary: 'A or B?' })
  })

  it('task_delta floors at zero and never changes phase', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'prompt_submitted' }, T0)
    const next = reduceAgentState(s, { kind: 'task_delta', delta: -1 }, T1)
    expect(next).toBe(s) // 0 → 0 is a no-op
  })

  it('turn_failed → errored with class + retryable', () => {
    const s = reduceAgentState(initialAgentState(T0), { kind: 'turn_failed', errorClass: 'billing_error', retryable: false }, T1)
    expect(s).toMatchObject({ phase: 'errored', error: { class: 'billing_error', retryable: false } })
  })

  it('compaction start/end → compacting → working', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'compaction', phase: 'start' }, T0)
    expect(s.phase).toBe('compacting')
    s = reduceAgentState(s, { kind: 'compaction', phase: 'end' }, T1)
    expect(s.phase).toBe('working')
  })

  it('session_ended → ended', () => {
    expect(reduceAgentState(initialAgentState(T0), { kind: 'session_ended' }, T1).phase).toBe('ended')
  })

  it('openTaskCount survives phase transitions', () => {
    let s = reduceAgentState(initialAgentState(T0), { kind: 'task_delta', delta: 1 }, T0)
    s = reduceAgentState(s, { kind: 'prompt_submitted' }, T1)
    expect(s.openTaskCount).toBe(1)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun run vitest run packages/agent-bridge/src/agent-state/reducer.test.ts`
Expected: FAIL — `./reducer` does not exist.

- [ ] **Step 4: Implement `reducer.ts`**

```ts
import type { AgentRuntimeState } from '@podium/protocol'
import type { AgentStateEvent } from './types.js'

export function initialAgentState(now: string): AgentRuntimeState {
  return { phase: 'unknown', since: now, openTaskCount: 0 }
}

/**
 * Pure transition. Returns `prev` (same reference) when the event changes
 * nothing, so callers can dedupe wire sends by identity. Detail fields
 * (idle/need/error) never leak across phases: each transition rebuilds the
 * state from scratch.
 */
export function reduceAgentState(
  prev: AgentRuntimeState,
  event: AgentStateEvent,
  now: string,
): AgentRuntimeState {
  const base = { since: now, openTaskCount: prev.openTaskCount }
  switch (event.kind) {
    case 'session_started':
      return { phase: 'idle', ...base }
    case 'prompt_submitted':
      return { phase: 'working', ...base }
    case 'activity':
      return prev.phase === 'working' ? prev : { phase: 'working', ...base }
    case 'needs_user':
      return {
        phase: 'needs_user',
        ...base,
        need: { kind: event.need, ...(event.summary !== undefined ? { summary: event.summary } : {}) },
      }
    case 'turn_completed': {
      const verdict = event.verdict ?? { kind: 'done' as const }
      // Open todos outrank a bare "done" — the agent stopped mid-list. They do
      // NOT outrank question/approval: those already say why it stopped.
      const idle =
        verdict.kind === 'done' && prev.openTaskCount > 0 ? { kind: 'open_todos' as const } : verdict
      return { phase: 'idle', ...base, idle }
    }
    case 'turn_failed':
      return {
        phase: 'errored',
        ...base,
        error: { class: event.errorClass, retryable: event.retryable },
      }
    case 'compaction':
      return event.phase === 'start' ? { phase: 'compacting', ...base } : { phase: 'working', ...base }
    case 'task_delta': {
      const openTaskCount = Math.max(0, prev.openTaskCount + event.delta)
      if (openTaskCount === prev.openTaskCount) return prev
      return { ...prev, openTaskCount }
    }
    case 'session_ended':
      return { phase: 'ended', ...base }
  }
}
```

- [ ] **Step 5: Create `agent-state/index.ts` and export from the package**

`packages/agent-bridge/src/agent-state/index.ts`:

```ts
export * from './reducer.js'
export * from './types.js'
```

In `packages/agent-bridge/src/index.ts` add (alphabetical position, first line of the export block):

```ts
export * from './agent-state/index.js'
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun run vitest run packages/agent-bridge/src/agent-state/reducer.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 7: Commit**

```bash
git add packages/agent-bridge/src/agent-state packages/agent-bridge/src/index.ts
git commit -m "feat(agent-bridge): agent-state event types and pure reducer"
```

---

### Task 3: Claude Code provider — spawn instrumentation (hook settings)

**Files:**
- Create: `packages/agent-bridge/src/agent-state/claude-code.ts`
- Modify: `packages/agent-bridge/src/agent-state/index.ts`
- Test: `packages/agent-bridge/src/agent-state/claude-code.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/agent-bridge/src/agent-state/claude-code.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { agentStateProviderFor, claudeCodeStateProvider } from './claude-code'

const URL = 'http://127.0.0.1:45777/hooks/s1'

describe('claude-code instrumentation', () => {
  it('injects --settings pointing at the generated file', () => {
    const instr = claudeCodeStateProvider.instrumentation({
      endpointUrl: URL,
      settingsPath: '/tmp/podium/hooks/s1.json',
    })
    expect(instr.args).toEqual(['--settings', '/tmp/podium/hooks/s1.json'])
    expect(instr.file?.path).toBe('/tmp/podium/hooks/s1.json')
  })

  it('settings file is valid JSON wiring every lifecycle event to the http endpoint', () => {
    const instr = claudeCodeStateProvider.instrumentation({ endpointUrl: URL, settingsPath: '/x.json' })
    const settings = JSON.parse(instr.file?.contents ?? '') as {
      hooks: Record<string, { matcher?: string; hooks: { type: string; url: string }[] }[]>
    }
    for (const event of [
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest',
      'Notification', 'Stop', 'StopFailure', 'TaskCreated', 'TaskCompleted',
      'PreCompact', 'PostCompact', 'SessionEnd',
    ]) {
      const groups = settings.hooks[event]
      expect(groups, `missing hooks for ${event}`).toBeDefined()
      for (const g of groups ?? []) {
        expect(g.hooks).toEqual([{ type: 'http', url: URL }])
      }
    }
    // PreToolUse only watches the question tool; Notification only permission prompts.
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe('AskUserQuestion')
    expect(settings.hooks.Notification?.[0]?.matcher).toBe('permission_prompt')
  })
})

describe('agentStateProviderFor', () => {
  it('claude-code gets a provider; codex and shell do not (yet)', () => {
    expect(agentStateProviderFor('claude-code')).toBe(claudeCodeStateProvider)
    expect(agentStateProviderFor('codex')).toBeUndefined()
    expect(agentStateProviderFor('shell')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run vitest run packages/agent-bridge/src/agent-state/claude-code.test.ts`
Expected: FAIL — `./claude-code` does not exist.

- [ ] **Step 3: Implement instrumentation in `claude-code.ts`**

```ts
import type { AgentKind } from '@podium/protocol'
import type { AgentInstrumentation, AgentStateEvent, AgentStateProvider } from './types.js'

// Observation only: every hook replies 200 {} immediately (see the daemon's
// ingest server), so injecting these can never block or steer the agent.
function httpHook(url: string): { hooks: { type: 'http'; url: string }[] } {
  return { hooks: [{ type: 'http', url }] }
}

export function claudeHookSettings(endpointUrl: string): string {
  const h = httpHook(endpointUrl)
  return JSON.stringify(
    {
      hooks: {
        SessionStart: [h],
        UserPromptSubmit: [h],
        // Only the explicit ask-user tool; all other tool use arrives via PostToolUse.
        PreToolUse: [{ matcher: 'AskUserQuestion', ...h }],
        PostToolUse: [h],
        PermissionRequest: [h],
        // idle_prompt etc. are redundant with Stop; permission prompts are the signal.
        Notification: [{ matcher: 'permission_prompt', ...h }],
        Stop: [h],
        StopFailure: [h],
        TaskCreated: [h],
        TaskCompleted: [h],
        PreCompact: [h],
        PostCompact: [h],
        SessionEnd: [h],
      },
    },
    null,
    2,
  )
}

export const claudeCodeStateProvider: AgentStateProvider = {
  instrumentation({ endpointUrl, settingsPath }): AgentInstrumentation {
    return {
      args: ['--settings', settingsPath],
      file: { path: settingsPath, contents: claudeHookSettings(endpointUrl) },
    }
  },
  async translate(_payload: unknown): Promise<AgentStateEvent[]> {
    return [] // implemented in the next task
  },
}

/** The provider registry. Uninstrumented kinds return undefined → phase stays 'unknown'. */
export function agentStateProviderFor(kind: AgentKind): AgentStateProvider | undefined {
  return kind === 'claude-code' ? claudeCodeStateProvider : undefined
}
```

Add to `packages/agent-bridge/src/agent-state/index.ts`:

```ts
export * from './claude-code.js'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run vitest run packages/agent-bridge/src/agent-state/claude-code.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/agent-state
git commit -m "feat(agent-bridge): claude-code provider spawn instrumentation (http hooks settings)"
```

---

### Task 4: Claude Code provider — hook payload translation (no transcript)

**Files:**
- Modify: `packages/agent-bridge/src/agent-state/claude-code.ts`
- Test: `packages/agent-bridge/src/agent-state/claude-code.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `claude-code.test.ts`:

```ts
import { translateClaudeHookPayload } from './claude-code'

const base = { session_id: 'cc1', transcript_path: '/nonexistent.jsonl', cwd: '/tmp' }

describe('translateClaudeHookPayload', () => {
  const t = (extra: Record<string, unknown>) => translateClaudeHookPayload({ ...base, ...extra })

  it('maps lifecycle events', async () => {
    expect(await t({ hook_event_name: 'SessionStart', source: 'startup' })).toEqual([{ kind: 'session_started' }])
    expect(await t({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })).toEqual([{ kind: 'prompt_submitted' }])
    expect(await t({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })).toEqual([{ kind: 'activity' }])
    expect(await t({ hook_event_name: 'SessionEnd', reason: 'other' })).toEqual([{ kind: 'session_ended' }])
    expect(await t({ hook_event_name: 'PreCompact', trigger: 'auto' })).toEqual([{ kind: 'compaction', phase: 'start' }])
    expect(await t({ hook_event_name: 'PostCompact', trigger: 'auto' })).toEqual([{ kind: 'compaction', phase: 'end' }])
    expect(await t({ hook_event_name: 'TaskCreated' })).toEqual([{ kind: 'task_delta', delta: 1 }])
    expect(await t({ hook_event_name: 'TaskCompleted' })).toEqual([{ kind: 'task_delta', delta: -1 }])
  })

  it('AskUserQuestion PreToolUse → needs_user question with the question text', async () => {
    const events = await t({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which auth method?', header: 'Auth' }] },
    })
    expect(events).toEqual([{ kind: 'needs_user', need: 'question', summary: 'Which auth method?' }])
  })

  it('non-question PreToolUse is just activity', async () => {
    expect(await t({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toEqual([{ kind: 'activity' }])
  })

  it('PermissionRequest / Notification → needs_user permission', async () => {
    expect(await t({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })).toEqual([
      { kind: 'needs_user', need: 'permission', summary: 'Bash' },
    ])
    expect(await t({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })).toEqual([
      { kind: 'needs_user', need: 'permission', summary: 'Claude needs your permission to use Bash' },
    ])
  })

  it('StopFailure → turn_failed; retryable only for transient classes', async () => {
    expect(await t({ hook_event_name: 'StopFailure', error_type: 'rate_limit' })).toEqual([
      { kind: 'turn_failed', errorClass: 'rate_limit', retryable: true },
    ])
    expect(await t({ hook_event_name: 'StopFailure', error_type: 'billing_error' })).toEqual([
      { kind: 'turn_failed', errorClass: 'billing_error', retryable: false },
    ])
    // unknown payload shape → still errored, conservatively retryable
    expect(await t({ hook_event_name: 'StopFailure' })).toEqual([
      { kind: 'turn_failed', errorClass: 'unknown', retryable: true },
    ])
  })

  it('Stop (unreadable transcript) → turn_completed without verdict', async () => {
    expect(await t({ hook_event_name: 'Stop', stop_hook_active: false })).toEqual([{ kind: 'turn_completed' }])
  })

  it('garbage payloads translate to nothing', async () => {
    expect(await translateClaudeHookPayload(null)).toEqual([])
    expect(await translateClaudeHookPayload('x')).toEqual([])
    expect(await translateClaudeHookPayload({ hook_event_name: 'SomethingNew' })).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run vitest run packages/agent-bridge/src/agent-state/claude-code.test.ts`
Expected: FAIL — `translateClaudeHookPayload` is not exported.

- [ ] **Step 3: Implement translation**

In `claude-code.ts`, add and wire into the provider (`translate: translateClaudeHookPayload`):

```ts
// Transient harness/API failures where a blind "continue" plausibly succeeds.
// billing/auth/config failures would just fail again — those need a human.
const RETRYABLE = new Set(['rate_limit', 'overloaded', 'server_error', 'max_output_tokens', 'unknown'])

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export async function translateClaudeHookPayload(payload: unknown): Promise<AgentStateEvent[]> {
  if (typeof payload !== 'object' || payload === null) return []
  const p = payload as Record<string, unknown>
  switch (p.hook_event_name) {
    case 'SessionStart':
      return [{ kind: 'session_started' }]
    case 'UserPromptSubmit':
      return [{ kind: 'prompt_submitted' }]
    case 'PreToolUse': {
      if (p.tool_name === 'AskUserQuestion') {
        const input = p.tool_input as { questions?: { question?: unknown }[] } | undefined
        const q = str(input?.questions?.[0]?.question)
        return [{ kind: 'needs_user', need: 'question', ...(q ? { summary: q } : {}) }]
      }
      return [{ kind: 'activity' }]
    }
    case 'PostToolUse':
      return [{ kind: 'activity' }]
    case 'PermissionRequest': {
      const summary = str(p.tool_name)
      return [{ kind: 'needs_user', need: 'permission', ...(summary ? { summary } : {}) }]
    }
    case 'Notification': {
      // Settings subscribe matcher=permission_prompt only, so anything arriving is one.
      const summary = str(p.message)
      return [{ kind: 'needs_user', need: 'permission', ...(summary ? { summary } : {}) }]
    }
    case 'Stop': {
      const verdict = await classifyIdleFromStop(p)
      return [{ kind: 'turn_completed', ...(verdict ? { verdict } : {}) }]
    }
    case 'StopFailure': {
      // Field name not pinned by docs — accept the plausible spellings, then give up
      // to 'unknown' (still errored, still retryable) rather than dropping the event.
      const errorClass = str(p.error_type) ?? str(p.errorType) ?? str(p.matcher) ?? 'unknown'
      return [{ kind: 'turn_failed', errorClass, retryable: RETRYABLE.has(errorClass) }]
    }
    case 'TaskCreated':
      return [{ kind: 'task_delta', delta: 1 }]
    case 'TaskCompleted':
      return [{ kind: 'task_delta', delta: -1 }]
    case 'PreCompact':
      return [{ kind: 'compaction', phase: 'start' }]
    case 'PostCompact':
      return [{ kind: 'compaction', phase: 'end' }]
    case 'SessionEnd':
      return [{ kind: 'session_ended' }]
    default:
      return []
  }
}
```

For this task, stub the classifier at the bottom of the file (Task 5 replaces it):

```ts
async function classifyIdleFromStop(
  _p: Record<string, unknown>,
): Promise<{ kind: 'done' | 'question' | 'approval'; summary?: string } | undefined> {
  return undefined
}
```

Replace the provider's `translate` placeholder: `translate: translateClaudeHookPayload,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run vitest run packages/agent-bridge/src/agent-state/claude-code.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/agent-state
git commit -m "feat(agent-bridge): translate claude-code hook payloads to agent-state events"
```

---

### Task 5: Claude Code provider — Tier 1+2 idle classification from the transcript tail

**Files:**
- Modify: `packages/agent-bridge/src/agent-state/claude-code.ts`
- Test: `packages/agent-bridge/src/agent-state/claude-code.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `claude-code.test.ts` (add the node imports at the top of the file):

```ts
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyIdleTranscript } from './claude-code'

const assistantLine = (blocks: unknown[]) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } })
const text = (t: string) => ({ type: 'text', text: t })

describe('classifyIdleTranscript', () => {
  const parse = (lines: string[]) => lines.map((l) => JSON.parse(l) as unknown)

  it('plan mode at stop → approval, regardless of text', () => {
    const records = parse([assistantLine([text('All tests pass.')])])
    expect(classifyIdleTranscript(records, 'plan')).toEqual({
      kind: 'approval',
      summary: 'plan awaiting approval',
    })
  })

  it('trailing question → question with the asking line as summary', () => {
    const records = parse([
      assistantLine([text('Done with part one.')]),
      assistantLine([text('I can use JWT or sessions.\nWhich approach do you prefer?')]),
    ])
    expect(classifyIdleTranscript(records, 'default')).toEqual({
      kind: 'question',
      summary: 'Which approach do you prefer?',
    })
  })

  it('question-phrase without question mark still counts', () => {
    const records = parse([assistantLine([text('Let me know if you want me to also update the docs')])])
    expect(classifyIdleTranscript(records, 'default')?.kind).toBe('question')
  })

  it('declarative ending → done', () => {
    const records = parse([assistantLine([text('Committed. All 42 tests pass.')])])
    expect(classifyIdleTranscript(records, 'default')).toEqual({ kind: 'done' })
  })

  it('skips trailing tool-use-only assistant records to find the last text', () => {
    const records = parse([
      assistantLine([text('Should I delete the legacy table?')]),
      assistantLine([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
    ])
    expect(classifyIdleTranscript(records, 'default')?.kind).toBe('question')
  })

  it('no assistant text at all → undefined', () => {
    expect(classifyIdleTranscript(parse(['{"type":"summary"}']), 'default')).toBeUndefined()
    expect(classifyIdleTranscript([], 'default')).toBeUndefined()
  })
})

describe('Stop payload end-to-end with a real transcript file', () => {
  it('reads the tail and classifies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'podium-agent-state-'))
    const transcript = join(dir, 't.jsonl')
    await writeFile(
      transcript,
      ['{"type":"user","message":{"role":"user","content":"hi"}}', assistantLine([text('Want me to proceed with the migration?')])].join('\n'),
    )
    const events = await translateClaudeHookPayload({
      hook_event_name: 'Stop',
      transcript_path: transcript,
      permission_mode: 'default',
      stop_hook_active: false,
    })
    expect(events).toEqual([
      { kind: 'turn_completed', verdict: { kind: 'question', summary: 'Want me to proceed with the migration?' } },
    ])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run vitest run packages/agent-bridge/src/agent-state/claude-code.test.ts`
Expected: FAIL — `classifyIdleTranscript` not exported; end-to-end Stop returns no verdict.

- [ ] **Step 3: Implement the classifier and transcript tail reader**

In `claude-code.ts`, replace the `classifyIdleFromStop` stub with:

```ts
import { open } from 'node:fs/promises'

const TAIL_BYTES = 128 * 1024
// Tier-2 heuristic: does the last assistant message read like it wants an answer?
// Intentionally cheap and English-biased — Tier 3 (LLM classification) refines later.
const QUESTIONISH =
  /(\?\s*$)|\b(should i|shall i|want me to|would you like|let me know|which (one|option|approach)|do you want)\b/i

type IdleClassification = { kind: 'done' | 'question' | 'approval'; summary?: string }

/** Last `maxBytes` of a JSONL file as parsed records (first partial line dropped). */
async function readTranscriptTail(path: string, maxBytes = TAIL_BYTES): Promise<unknown[]> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(Math.min(size, maxBytes))
    await handle.read(buffer, 0, buffer.length, start)
    let text = buffer.toString('utf8')
    if (start > 0) {
      const firstBreak = text.indexOf('\n')
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : ''
    }
    const records: unknown[] = []
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        records.push(JSON.parse(trimmed) as unknown)
      } catch {
        // torn write mid-line — skip
      }
    }
    return records
  } finally {
    await handle.close()
  }
}

export function classifyIdleTranscript(
  records: unknown[],
  permissionMode: unknown,
): IdleClassification | undefined {
  // Tier 1: stopping while still in plan mode means a plan is waiting for sign-off.
  if (permissionMode === 'plan') return { kind: 'approval', summary: 'plan awaiting approval' }
  // Walk backward to the last assistant record that actually contains text
  // (the final record is often tool-use-only).
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i] as { type?: unknown; message?: { content?: unknown } } | null
    if (r?.type !== 'assistant') continue
    const content = r.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((b): b is { type: string; text: string } =>
        typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text',
      )
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!text) continue
    if (QUESTIONISH.test(text.slice(-400))) {
      const lastLine = text.split('\n').filter((l) => l.trim()).at(-1) ?? text
      return { kind: 'question', summary: lastLine.trim().slice(0, 140) }
    }
    return { kind: 'done' }
  }
  return undefined
}

async function classifyIdleFromStop(
  p: Record<string, unknown>,
): Promise<IdleClassification | undefined> {
  const transcriptPath = typeof p.transcript_path === 'string' ? p.transcript_path : undefined
  if (!transcriptPath) {
    return p.permission_mode === 'plan' ? { kind: 'approval', summary: 'plan awaiting approval' } : undefined
  }
  try {
    return classifyIdleTranscript(await readTranscriptTail(transcriptPath), p.permission_mode)
  } catch {
    // unreadable transcript (rotated, perms) — Stop still means idle, just unclassified
    return p.permission_mode === 'plan' ? { kind: 'approval', summary: 'plan awaiting approval' } : undefined
  }
}
```

(Move the `import { open } from 'node:fs/promises'` line to the top of the file with the other imports.)

- [ ] **Step 4: Run the full agent-bridge suite**

Run: `bun run vitest run packages/agent-bridge`
Expected: PASS — new tests green, no regressions.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bridge/src/agent-state
git commit -m "feat(agent-bridge): tier-1/2 idle classification from transcript tail + plan mode"
```

---

### Task 6: Daemon — HTTP hook ingest server

**Files:**
- Create: `apps/daemon/src/hook-ingest.ts`
- Test: `apps/daemon/src/hook-ingest.test.ts`

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/hook-ingest.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { type HookIngest, startHookIngest } from './hook-ingest'

describe('hook ingest', () => {
  let ingest: HookIngest

  afterEach(async () => {
    await ingest.close()
  })

  it('accepts a POST and hands the payload to the callback, replying 200 {}', async () => {
    const got: { sessionId: string; payload: unknown }[] = []
    ingest = await startHookIngest({ port: 0, onPayload: (sessionId, payload) => got.push({ sessionId, payload }) })
    const res = await fetch(ingest.endpointFor('s1'), {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'Stop' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual([{ sessionId: 's1', payload: { hook_event_name: 'Stop' } }])
  })

  it('endpointFor embeds the session id and the actual port', async () => {
    ingest = await startHookIngest({ port: 0, onPayload: () => {} })
    expect(ingest.endpointFor('abc-123')).toBe(`http://127.0.0.1:${ingest.port}/hooks/abc-123`)
  })

  it('rejects non-POST and unknown paths with 404, malformed JSON is acked but dropped', async () => {
    const got: unknown[] = []
    ingest = await startHookIngest({ port: 0, onPayload: (_sid, p) => got.push(p) })
    expect((await fetch(ingest.endpointFor('s1'), { method: 'GET' })).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${ingest.port}/other`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(ingest.endpointFor('s1'), { method: 'POST', body: 'not json' })).status).toBe(200)
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual([])
  })

  it('falls back to an ephemeral port when the preferred port is taken', async () => {
    ingest = await startHookIngest({ port: 0, onPayload: () => {} })
    const second = await startHookIngest({ port: ingest.port, onPayload: () => {} })
    expect(second.port).not.toBe(ingest.port)
    expect(second.port).toBeGreaterThan(0)
    await second.close()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run vitest run apps/daemon/src/hook-ingest.test.ts`
Expected: FAIL — `./hook-ingest` does not exist.

- [ ] **Step 3: Implement `hook-ingest.ts`**

```ts
import { createServer, type Server } from 'node:http'

/**
 * Receives Claude Code `type: "http"` hook POSTs at /hooks/<podiumSessionId>.
 * The path segment is OUR session id (baked into the per-session settings file
 * at spawn), which is how harness events correlate to Podium sessions without
 * trusting the payload.
 *
 * Always acks 200 {} immediately, before the payload is even parsed: hooks run
 * inline in the agent's lifecycle, and Podium must observe, never delay or steer.
 */
export interface HookIngest {
  port: number
  endpointFor(sessionId: string): string
  close(): Promise<void>
}

/**
 * Default is a FIXED port, not ephemeral: hook URLs live in settings files of
 * durable (abduco/tmux) sessions that outlive this process. A daemon restart
 * must come back on the same port or surviving agents post into the void.
 */
export const DEFAULT_HOOK_PORT = 45777

export function startHookIngest(opts: {
  onPayload: (sessionId: string, payload: unknown) => void
  /** Preferred port; pass 0 for ephemeral (tests). Defaults to DEFAULT_HOOK_PORT. */
  port?: number
}): Promise<HookIngest> {
  const server: Server = createServer((req, res) => {
    const match = /^\/hooks\/([\w.-]+)$/.exec(req.url ?? '')
    if (!match || req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }
    const sessionId = match[1] as string
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      try {
        opts.onPayload(sessionId, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        // malformed body — already acked; drop
      }
    })
  })

  const preferred = opts.port ?? DEFAULT_HOOK_PORT
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('hook ingest: no port'))
        return
      }
      resolve({
        port: addr.port,
        endpointFor: (sessionId) => `http://127.0.0.1:${addr.port}/hooks/${sessionId}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    }
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && preferred !== 0) {
        // Degraded mode: pre-restart durable sessions keep posting to the old
        // port and lose state reporting, but new spawns work.
        console.warn(`[podium] hook port ${preferred} in use — falling back to an ephemeral port`)
        server.removeAllListeners('error')
        server.once('error', reject)
        server.listen(0, '127.0.0.1', finish)
        return
      }
      reject(err)
    })
    server.listen(preferred, '127.0.0.1', finish)
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run vitest run apps/daemon/src/hook-ingest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/hook-ingest.ts apps/daemon/src/hook-ingest.test.ts
git commit -m "feat(daemon): localhost HTTP ingest for agent harness hooks"
```

---

### Task 7: Daemon — wire ingest + provider into spawn/reattach, send `agentState`

**Files:**
- Modify: `apps/daemon/src/daemon.ts`
- Test: `apps/daemon/src/daemon.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a new describe block to `apps/daemon/src/daemon.test.ts`. It needs its own daemon instance because it injects a `launch` fixture that records args and uses a temp settings dir (reuse the file's existing `FIXTURE`, `G`, and `waitFor` patterns — copy `waitFor` into the block or hoist it to module scope):

```ts
describe('agent state instrumentation', () => {
  let wss: WebSocketServer
  let serverSocket: WS
  let received: DaemonMessage[]
  let daemon: DaemonHandle
  let settingsDir: string

  beforeEach(async () => {
    received = []
    settingsDir = await mkdtemp(join(tmpdir(), 'podium-hooks-'))
    wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port
    const connected = new Promise<void>((r) => {
      wss.once('connection', (ws) => {
        serverSocket = ws
        ws.on('message', (raw) => received.push(parseDaemonMessage(raw.toString())))
        r()
      })
    })
    daemon = await startDaemon({
      serverUrl: `ws://localhost:${port}`,
      tmux: false,
      discovery: { background: false, cachePath: ':memory:' },
      metrics: { background: false },
      hooks: { port: 0, settingsDir },
      launch: (_kind, opts) => ({ cmd: process.execPath, args: [FIXTURE], cwd: opts.cwd }),
    })
    await connected
  })

  afterEach(async () => {
    await daemon.close()
    await new Promise<void>((r) => wss.close(() => r()))
  })

  const send = (msg: unknown): void => serverSocket.send(encode(msg as never))
  async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
    const start = Date.now()
    while (!fn()) {
      if (Date.now() - start > timeout) throw new Error('waitFor timed out')
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  const states = () =>
    received.filter((m): m is Extract<DaemonMessage, { type: 'agentState' }> => m.type === 'agentState')

  it('writes the hook settings file and appends --settings for claude-code spawns', async () => {
    send({ type: 'spawn', sessionId: 'sA', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 'sA'))
    const settingsPath = join(settingsDir, 'sA.json')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks: Record<string, { hooks: { type: string; url: string }[] }[]>
    }
    const url = settings.hooks.Stop?.[0]?.hooks[0]?.url ?? ''
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${daemon.hookPort}/hooks/sA$`))
  })

  it('does not instrument shell sessions', async () => {
    send({ type: 'spawn', sessionId: 'sh1', agentKind: 'shell', cwd: '/tmp', geometry: G })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 'sh1'))
    await expect(readFile(join(settingsDir, 'sh1.json'), 'utf8')).rejects.toThrow()
  })

  it('hook POSTs flow through translate+reduce and out as agentState messages', async () => {
    send({ type: 'spawn', sessionId: 'sB', agentKind: 'claude-code', cwd: '/tmp', geometry: G })
    await waitFor(() => received.some((m) => m.type === 'bind' && m.sessionId === 'sB'))
    const post = (payload: unknown) =>
      fetch(`http://127.0.0.1:${daemon.hookPort}/hooks/sB`, { method: 'POST', body: JSON.stringify(payload) })
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await waitFor(() => states().some((s) => s.sessionId === 'sB' && s.state.phase === 'working'))
    await post({ hook_event_name: 'StopFailure', error_type: 'rate_limit' })
    await waitFor(() => states().some((s) => s.state.phase === 'errored'))
    const errored = states().find((s) => s.state.phase === 'errored')
    expect(errored?.state.error).toEqual({ class: 'rate_limit', retryable: true })
    // True no-ops are deduped by reducer reference identity: working → working
    // emits nothing. (Re-entries like a repeated StopFailure DO re-broadcast,
    // because they stamp a new `since` — that's intended.)
    await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }) // errored → working
    await waitFor(() => states().at(-1)?.state.phase === 'working')
    const count = states().length
    await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }) // working → working: no-op
    await new Promise((r) => setTimeout(r, 50))
    expect(states().length).toBe(count)
  })

  it('hook POSTs for unknown sessions are ignored', async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.hookPort}/hooks/nope`, {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'Stop' }),
    })
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    expect(states().filter((s) => s.sessionId === 'nope')).toEqual([])
  })
})
```

Add the missing imports at the top of `daemon.test.ts`: `readFile` from `node:fs/promises` (extend the existing import).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run vitest run apps/daemon/src/daemon.test.ts`
Expected: New describe FAILS — `hooks` option and `hookPort` don't exist, no `agentState` messages. Pre-existing tests still PASS.

- [ ] **Step 3: Implement daemon wiring**

In `apps/daemon/src/daemon.ts`:

1. Extend imports:

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  // …existing agent-bridge imports…
  type AgentRuntimeState,
  type AgentStateProvider,
  agentStateProviderFor,
  initialAgentState,
  reduceAgentState,
} from '@podium/agent-bridge'
import { startHookIngest } from './hook-ingest'
```

(`AgentRuntimeState` is re-exported by agent-bridge's agent-state module via `types.ts`; if tsc complains, import it from `@podium/protocol` instead.)

2. Extend `DaemonOptions`:

```ts
export interface DaemonHooksOptions {
  /** Ingest port. Fixed by default (DEFAULT_HOOK_PORT) so durable sessions survive restarts; 0 = ephemeral (tests). */
  port?: number
  /** Where per-session hook settings files are written. Defaults to $PODIUM_STATE_DIR/hooks else ~/.podium/hooks. */
  settingsDir?: string
}
```

Add `hooks?: DaemonHooksOptions` to `DaemonOptions`, and `readonly hookPort: number` to `DaemonHandle`.

3. Make `startDaemon` async and start the ingest first. Change the signature to `export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle>` and at the top of the body (before `const ws = …`):

```ts
  const settingsDir =
    opts.hooks?.settingsDir ??
    join(process.env.PODIUM_STATE_DIR ?? join(homedir(), '.podium'), 'hooks')
  const trackers = new Map<string, { provider: AgentStateProvider; state: AgentRuntimeState }>()
  const ingest = await startHookIngest({
    ...(opts.hooks?.port !== undefined ? { port: opts.hooks.port } : {}),
    onPayload: (sessionId, payload) => {
      const tracker = trackers.get(sessionId)
      if (!tracker) return
      void tracker.provider
        .translate(payload)
        .then((events) => {
          for (const event of events) {
            const next = reduceAgentState(tracker.state, event, new Date().toISOString())
            if (next === tracker.state) continue
            tracker.state = next
            send({ type: 'agentState', sessionId, state: next })
          }
        })
        .catch((err) => console.warn(`[podium] hook translate failed for ${sessionId}:`, err))
    },
  })
```

(The existing function body already builds `send` before `ws` handlers run; keep `send` defined before the ingest block — move the `const send = …` declaration above it.)

**Ordering caveat:** `send` checks `ws.readyState === OPEN`, and `ws` must exist before `send` is called. Since hooks only fire after a spawn, and spawns only arrive over the open WS, declaring `ingest` after `const ws`/`const send` is safest — put the trackers/ingest block right after `const send = …`.

4. Instrument spawns. In `spawn()`, replace the `spawnOpts` construction:

```ts
      const provider = agentStateProviderFor(msg.agentKind)
      let extraArgs: string[] = []
      if (provider) {
        mkdirSync(settingsDir, { recursive: true })
        const instr = provider.instrumentation({
          endpointUrl: ingest.endpointFor(msg.sessionId),
          settingsPath: join(settingsDir, `${msg.sessionId}.json`),
        })
        if (instr.file) writeFileSync(instr.file.path, instr.file.contents)
        extraArgs = instr.args
        trackers.set(msg.sessionId, { provider, state: initialAgentState(new Date().toISOString()) })
      }
      const spawnOpts = {
        label,
        cmd: cmd.cmd,
        args: [...cmd.args, ...extraArgs],
        cwd: cmd.cwd,
        cols: msg.geometry.cols,
        rows: msg.geometry.rows,
      }
```

5. Track reattaches too. In the `reattach` case, after `wireBridge(msg.sessionId, found.session)`:

```ts
        // The settings file from the original spawn still points at our fixed
        // port, so a reattached agent keeps reporting — re-arm the tracker.
        const provider = agentStateProviderFor(msg.agentKind)
        if (provider) {
          trackers.set(msg.sessionId, { provider, state: initialAgentState(new Date().toISOString()) })
        }
```

6. Clean up trackers: add `trackers.delete(msg.sessionId)` in the `kill` case, inside `session.onExit` in `wireBridge` (next to `bridges.delete(sessionId)`), and `trackers.clear()` in `disposeAll`.

7. Close the ingest and expose the port: in `handle.close()`, before resolving, `await ingest.close()` (make the close callback async or chain the promise); add `hookPort: ingest.port` to the `handle` object. The final `return new Promise<DaemonHandle>(…)` stays as-is (it's now inside an async function — return `await` of it or just return the promise).

- [ ] **Step 4: Run the daemon suite**

Run: `bun run vitest run apps/daemon`
Expected: PASS — new describe green, existing daemon tests unaffected (they don't pass `hooks` and get the fixed-port default; if `45777` collides across parallel test files, set `hooks: { port: 0 }` in the older describes' `startDaemon` calls too).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/daemon.ts apps/daemon/src/daemon.test.ts
git commit -m "feat(daemon): inject hook instrumentation at spawn and emit agentState over the control socket"
```

---

### Task 8: Server — store agent state on Session, rebroadcast, `sessions.continue`

**Files:**
- Modify: `apps/server/src/session.ts`
- Modify: `apps/server/src/relay.ts`
- Modify: `apps/server/src/router.ts`
- Test: `apps/server/src/relay.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/relay.test.ts`, following the file's existing harness (it constructs a `SessionRegistry` with a fake `toDaemon` collector and fake clients — mirror the nearest existing describe's setup):

```ts
describe('agent state', () => {
  const STATE = {
    phase: 'errored' as const,
    since: '2026-06-12T10:00:00.000Z',
    openTaskCount: 0,
    error: { class: 'rate_limit', retryable: true },
  }

  it('agentState from the daemon lands on SessionMeta and rebroadcasts sessions', () => {
    const { registry, daemonMsgs, client } = makeRegistryWithClient() // use/extract the file's existing helper pattern
    const { sessionId } = registry.createSession({ agentKind: 'claude-code', cwd: '/tmp' })
    client.received.length = 0
    registry.onDaemonMessage({ type: 'agentState', sessionId, state: STATE })
    const update = client.received.find((m) => m.type === 'sessionsChanged')
    expect(update).toBeDefined()
    const meta = (update as Extract<ServerMessage, { type: 'sessionsChanged' }>).sessions.find(
      (s) => s.sessionId === sessionId,
    )
    expect(meta?.agentState).toEqual(STATE)
    void daemonMsgs
  })

  it('agentState for an unknown session is ignored', () => {
    const { registry } = makeRegistryWithClient()
    expect(() =>
      registry.onDaemonMessage({ type: 'agentState', sessionId: 'ghost', state: STATE }),
    ).not.toThrow()
  })

  it('continueSession writes "continue\\r" to the PTY only while errored', () => {
    const { registry, daemonMsgs } = makeRegistryWithClient()
    const { sessionId } = registry.createSession({ agentKind: 'claude-code', cwd: '/tmp' })
    // not errored yet → refused
    expect(registry.continueSession({ sessionId })).toEqual({ ok: false })
    registry.onDaemonMessage({ type: 'agentState', sessionId, state: STATE })
    expect(registry.continueSession({ sessionId })).toEqual({ ok: true })
    const input = daemonMsgs.find((m) => m.type === 'input' && m.sessionId === sessionId)
    expect(input).toBeDefined()
    expect(Buffer.from((input as Extract<ControlMessage, { type: 'input' }>).data, 'base64').toString('utf8')).toBe(
      'continue\r',
    )
    expect(registry.continueSession({ sessionId: 'ghost' })).toEqual({ ok: false })
  })
})
```

Adapt `makeRegistryWithClient` to whatever helper the existing tests use (the file already has a pattern for collecting `toDaemon` ControlMessages and fake client `send`s — reuse it verbatim; if there is no shared helper, copy the setup from the nearest describe).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run vitest run apps/server/src/relay.test.ts`
Expected: New describe FAILS (`agentState` unhandled, `continueSession` missing). Existing tests PASS.

- [ ] **Step 3: Implement**

`apps/server/src/session.ts`:
- Add `AgentRuntimeState` to the type-only import from `@podium/protocol`.
- Add a field after `exitCode`: `agentState: AgentRuntimeState | undefined`.
- Add a method next to `setTitle`:

```ts
  /** Harness-observed runtime state (hooks-driven). Not persisted — it's live-only. */
  setAgentState(state: AgentRuntimeState): void {
    this.lastActiveAt = new Date().toISOString()
    this.agentState = state
  }
```

- In `toMeta()`, after the `exitCode` spread:

```ts
      ...(this.agentState ? { agentState: this.agentState } : {}),
```

`apps/server/src/relay.ts`:
- In `onDaemonMessage`, add a case (next to `title`):

```ts
      case 'agentState': {
        const session = this.sessions.get(msg.sessionId)
        if (!session) break
        session.setAgentState(msg.state)
        // Phase transitions are low-frequency (seconds apart, never per-frame),
        // so reusing the full sessions broadcast keeps the client protocol unchanged.
        this.broadcastSessions()
        break
      }
```

- Add a public method near `killSession`:

```ts
  /**
   * The overview "Continue" button: nudge an errored agent to retry by typing
   * `continue⏎` into its PTY. Guarded to the errored phase so a stray click
   * can't inject text into a healthy prompt.
   */
  continueSession({ sessionId }: { sessionId: string }): { ok: boolean } {
    const session = this.sessions.get(sessionId)
    if (!session || session.agentState?.phase !== 'errored') return { ok: false }
    this.toDaemon({
      type: 'input',
      sessionId,
      data: Buffer.from('continue\r').toString('base64'),
    })
    return { ok: true }
  }
```

`apps/server/src/router.ts` — in the `sessions` router after `kill`:

```ts
    continue: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.continueSession(input)),
```

- [ ] **Step 4: Run the server suite**

Run: `bun run vitest run apps/server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/session.ts apps/server/src/relay.ts apps/server/src/router.ts apps/server/src/relay.test.ts
git commit -m "feat(server): carry agentState on SessionMeta and add sessions.continue"
```

---

### Task 9: Web — phase badge + Continue button

**Files:**
- Modify: `apps/web/src/derive.ts`
- Modify: `apps/web/src/store.tsx`
- Modify: `apps/web/src/Sidebar.tsx` (the `PanelRow` component)
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/test/derive.test.ts`

- [ ] **Step 1: Write the failing tests for the pure badge helper**

Append to `apps/web/test/derive.test.ts`:

```ts
import type { SessionMeta } from '@podium/protocol'
import { agentBadge } from '../src/derive'

const meta = (agentState?: SessionMeta['agentState']): SessionMeta => ({
  sessionId: 's1',
  agentKind: 'claude-code',
  title: 't',
  cwd: '/tmp',
  status: 'live',
  controllerId: null,
  geometry: { cols: 80, rows: 24 },
  epoch: 0,
  clientCount: 0,
  createdAt: '2026-06-12T10:00:00.000Z',
  origin: { kind: 'spawn' },
  ...(agentState ? { agentState } : {}),
})
const at = (phase: NonNullable<SessionMeta['agentState']>['phase'], extra = {}) =>
  ({ phase, since: '2026-06-12T10:00:00.000Z', openTaskCount: 0, ...extra }) as NonNullable<
    SessionMeta['agentState']
  >

describe('agentBadge', () => {
  it('hides for uninstrumented or unknown sessions', () => {
    expect(agentBadge(meta())).toBeNull()
    expect(agentBadge(meta(at('unknown')))).toBeNull()
  })

  it('working / compacting are calm working tones', () => {
    expect(agentBadge(meta(at('working')))).toEqual({ label: 'working', tone: 'working', showContinue: false })
    expect(agentBadge(meta(at('compacting')))).toEqual({ label: 'compacting', tone: 'working', showContinue: false })
  })

  it('idle verdicts: done is calm, the rest want attention', () => {
    expect(agentBadge(meta(at('idle', { idle: { kind: 'done' } })))).toEqual({
      label: 'idle',
      tone: 'idle',
      showContinue: false,
    })
    expect(agentBadge(meta(at('idle', { idle: { kind: 'question', summary: 'A or B?' } })))?.tone).toBe('attention')
    expect(agentBadge(meta(at('idle', { idle: { kind: 'approval' } })))?.label).toBe('plan ready')
    expect(agentBadge(meta(at('idle', { idle: { kind: 'open_todos' } })))?.label).toBe('todos open')
  })

  it('needs_user is attention with the need spelled out', () => {
    expect(agentBadge(meta(at('needs_user', { need: { kind: 'permission' } })))).toEqual({
      label: 'needs permission',
      tone: 'attention',
      showContinue: false,
    })
    expect(agentBadge(meta(at('needs_user', { need: { kind: 'question' } })))?.label).toBe('needs answer')
  })

  it('errored shows the class; Continue only when retryable', () => {
    expect(agentBadge(meta(at('errored', { error: { class: 'rate_limit', retryable: true } })))).toEqual({
      label: 'error: rate_limit',
      tone: 'error',
      showContinue: true,
    })
    expect(
      agentBadge(meta(at('errored', { error: { class: 'billing_error', retryable: false } })))?.showContinue,
    ).toBe(false)
  })

  it('ended is muted', () => {
    expect(agentBadge(meta(at('ended')))).toEqual({ label: 'ended', tone: 'muted', showContinue: false })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run vitest run apps/web/test/derive.test.ts`
Expected: FAIL — `agentBadge` not exported.

- [ ] **Step 3: Implement `agentBadge` in `apps/web/src/derive.ts`**

```ts
import type { SessionMeta } from '@podium/protocol'

export interface AgentBadge {
  label: string
  tone: 'working' | 'idle' | 'attention' | 'error' | 'muted'
  showContinue: boolean
}

/** Map harness-observed runtime state to the little badge on a session row.
 *  Null = nothing to show (uninstrumented agent kinds stay clean). */
export function agentBadge(meta: SessionMeta): AgentBadge | null {
  const s = meta.agentState
  if (!s || s.phase === 'unknown') return null
  switch (s.phase) {
    case 'working':
      return { label: 'working', tone: 'working', showContinue: false }
    case 'compacting':
      return { label: 'compacting', tone: 'working', showContinue: false }
    case 'idle': {
      switch (s.idle?.kind) {
        case 'question':
          return { label: 'needs answer', tone: 'attention', showContinue: false }
        case 'approval':
          return { label: 'plan ready', tone: 'attention', showContinue: false }
        case 'open_todos':
          return { label: 'todos open', tone: 'attention', showContinue: false }
        default:
          return { label: 'idle', tone: 'idle', showContinue: false }
      }
    }
    case 'needs_user':
      return {
        label: s.need?.kind === 'question' ? 'needs answer' : 'needs permission',
        tone: 'attention',
        showContinue: false,
      }
    case 'errored':
      return {
        label: `error: ${s.error?.class ?? 'unknown'}`,
        tone: 'error',
        showContinue: s.error?.retryable ?? false,
      }
    case 'ended':
      return { label: 'ended', tone: 'muted', showContinue: false }
  }
}
```

(If `derive.ts` already imports `SessionMeta`, merge the import.)

- [ ] **Step 4: Run the badge tests**

Run: `bun run vitest run apps/web/test/derive.test.ts`
Expected: PASS

- [ ] **Step 5: Wire store + Sidebar UI**

`apps/web/src/store.tsx`:
- Add to the `Store` interface, after `killSession`:

```ts
  /** Nudge an errored agent to retry ("continue⏎" into its PTY). */
  continueSession: (sessionId: string) => Promise<void>
```

- Implement next to `killSession`:

```ts
  const continueSession = useMemo(
    () => async (sessionId: string) => {
      await trpc.sessions.continue.mutate({ sessionId }).catch(() => {})
    },
    [trpc],
  )
```

- Add `continueSession,` to the `value: Store = { … }` object.

`apps/web/src/Sidebar.tsx` — in `PanelRow`, render the badge and the Continue affordance. Import `agentBadge` from `./derive` and `useStore` from `./store` (check the file head — `useStore` may already be imported; `PanelRow` receives props only, so pull `continueSession` via the hook inside `PanelRow`):

```tsx
function PanelRow({ session, pinned, active, onSelect, onPinned }: { /* unchanged */ }): JSX.Element {
  const { continueSession } = useStore()
  const badge = agentBadge(session)
  return (
    <div className="panel-row-wrap">
      <button type="button" className={active ? 'panel-row active' : 'panel-row'} onClick={onSelect}>
        <span className={`dot ${session.status}`} /> <WorkerLabel session={session} />
        {badge && <span className={`agent-badge ${badge.tone}`}>{badge.label}</span>}
      </button>
      {badge?.showContinue && (
        <button
          type="button"
          className="continue-button"
          title="Send 'continue' to the errored agent"
          onClick={(e) => {
            e.stopPropagation()
            void continueSession(session.sessionId)
          }}
        >
          Continue
        </button>
      )}
      {/* existing pin button unchanged */}
    </div>
  )
}
```

`apps/web/src/styles.css` — append (match the file's existing custom-property palette if one exists; otherwise these literals):

```css
/* Harness-observed agent state on a session row */
.agent-badge {
  margin-left: auto;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10px;
  line-height: 16px;
  white-space: nowrap;
}
.agent-badge.working { color: #9aa4b2; background: rgba(154, 164, 178, 0.12); }
.agent-badge.idle { color: #6f7a89; background: rgba(111, 122, 137, 0.10); }
.agent-badge.attention { color: #e8b341; background: rgba(232, 179, 65, 0.14); }
.agent-badge.error { color: #e0604f; background: rgba(224, 96, 79, 0.14); }
.agent-badge.muted { color: #5d6673; background: transparent; }

.continue-button {
  border: 1px solid rgba(224, 96, 79, 0.5);
  background: transparent;
  color: #e0604f;
  border-radius: 6px;
  font-size: 11px;
  padding: 1px 8px;
  cursor: pointer;
}
.continue-button:hover { background: rgba(224, 96, 79, 0.12); }
```

- [ ] **Step 6: Run web tests + typecheck + build**

Run: `bun run vitest run apps/web && bun run --filter @podium/web typecheck 2>/dev/null || npx tsc -p apps/web --noEmit`
(Use the repo's actual typecheck script — check `apps/web/package.json` scripts; if there's a root `bun run check` / biome+tsc combo, run that.)
Expected: PASS / no type errors. Also run the structure test file explicitly if it asserts the sidebar DOM: `bun run vitest run apps/web/test/shell.structure.test.ts` — if it snapshots `PanelRow`, update expectations for the badge span.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/derive.ts apps/web/src/store.tsx apps/web/src/Sidebar.tsx apps/web/src/styles.css apps/web/test/derive.test.ts
git commit -m "feat(web): agent phase badge on session rows with Continue for retryable errors"
```

---

### Task 10: Full-suite gate, docs, and live verification against the real CLI

**Files:**
- Modify: `ARCHITECTURE.md` (the "What goes where" table)
- No other code changes expected — this task verifies the doc-level risks.

- [ ] **Step 1: Run everything**

Run: `bun run vitest run` (root) plus the repo's lint/typecheck (`bunx biome check .` and the tsconfig builds — match whatever CI runs, see `package.json` scripts).
Expected: PASS clean.

- [ ] **Step 2: Document the new subsystem**

In `ARCHITECTURE.md`, add a row to the "What goes where" table:

```markdown
| Agent state detection (hook ingest, providers, reducer) | `@podium/agent-bridge` `src/agent-state/` (shared interface + per-agent providers), `apps/daemon` (HTTP ingest + spawn injection) |
```

- [ ] **Step 3: Live verification with the real Claude Code CLI (manual checklist)**

Start a local stack from the worktree (server + daemon + web; see scripts/ or the e2e serve harness). Then:

1. Spawn a `claude-code` session from the UI in some scratch repo. Verify `~/.podium/hooks/<sessionId>.json` exists and `ps` shows `claude --settings …` in the argv.
2. Type a prompt → badge flips to **working**; let it finish → **idle**.
3. Ask it something that makes it ask back (e.g. "ask me which of two options I prefer using your question tool") → **needs answer**.
4. `/compact` mid-session → **compacting**, then **working/idle**.
5. Simulate the error path without burning quota: `curl -s -X POST http://127.0.0.1:45777/hooks/<sessionId> -d '{"hook_event_name":"StopFailure","error_type":"rate_limit"}'` → badge **error: rate_limit** + Continue button; click Continue → "continue" lands in the agent's prompt and submits; badge returns to **working**.
6. **Verify the StopFailure payload field name against reality**: add a temporary `console.log(JSON.stringify(payload))` in the ingest `onPayload` (or run the daemon with it), trigger a real failure if convenient (e.g. briefly break networking), and confirm which key carries the error class. If it isn't `error_type`/`errorType`/`matcher`, extend the defensive chain in `translateClaudeHookPayload` and add the real spelling to the test.
7. Restart the daemon while the session survives in abduco → badge keeps updating after reattach (fixed port + re-armed tracker).
8. Confirm the agent's own behavior is unchanged: hooks reply instantly, no visible latency, no extra output in the PTY.

- [ ] **Step 4: Note the deploy coupling**

Deployment to podium-host must restart **both** backend and `podium-web` (protocol changed; stale Vite serves old schemas that silently drop the new field — memory `podium-web-stale-vite`).

- [ ] **Step 5: Commit docs**

```bash
git add ARCHITECTURE.md
git commit -m "docs: agent state detection subsystem in architecture map"
```

---

## Out of scope (explicitly deferred)

- **Tier 3 LLM idle classification** — waits for the app-wide "LLM-driven features" calling convention.
- **Codex provider** — interface is ready (`agentStateProviderFor` returns undefined → `unknown` phase); implement when codex instrumentation is researched.
- **User-layered states** (needs-testing / completed / archived) — Podium-store labels orthogonal to `AgentRuntimeState`, separate feature.
- **Usage-limit reset-time parsing** ("retries at 3pm" on the Continue button) — needs transcript error-text parsing; follow-up.
- **Statusline tap** (cost/context%) — separate signal, separate feature.
- **Strict event ordering in the ingest path** — each hook POST is translated independently; a slow `Stop` translation (transcript read) could in theory land after a faster subsequent event. In practice hooks arrive seconds apart and the reducer self-corrects on the next event; add a per-session promise queue only if it ever shows up.
