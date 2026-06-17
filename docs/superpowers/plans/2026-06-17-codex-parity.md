# Codex Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Codex sessions to Claude-Code parity in Podium — structured chat, BTW (live + parked), first-prompt titles, a best-effort phase badge, and the panel controls (BTW ✨ / hibernate 🌙 / chat↔live switcher) that follow from them.

**Architecture:** Codex writes one rollout JSONL per session at `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl` containing both the conversation (`response_item` records) and clean state signals (`event_msg` records). We clone Grok's **filesystem-observer** pattern (Grok has no hooks either): one observer discovers the live rollout, emits a resume ref, and tails the file; a transcript converter feeds the chat view; an agent-state provider folds `event_msg` records into the shared state reducer. The parked (hibernated/exited) read path resolves the rollout via Codex's state DB.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Bun workspace, Vitest, Zod (protocol), React (web). Packages: `@podium/agent-bridge`, `@podium/protocol`, `@podium/terminal-client`, `apps/daemon`, `apps/web`.

## Global Constraints

- **Imports use `.js` specifiers** even for `.ts` files (NodeNext ESM). Copy the style of the file you edit.
- **Test runner is Vitest**, never `bun test`. From repo root: `bun run test`. Per-package web tests must run from `apps/web` (happy-dom env): `cd apps/web && ../../node_modules/.bin/vitest run`.
- **`AgentKind`** = `'claude-code' | 'codex' | 'grok' | 'shell'` (already includes codex). Resume kind for codex is the existing **`codex-thread`** — do NOT invent a new kind.
- **`TranscriptItem`** fields used here: `{ id: string; role: 'user'|'assistant'|'system'|'tool'; ts?: string; text: string; toolName?: string; toolInput?: string; toolResult?: string; toolUseId?: string }`.
- **`AgentStateEvent`** union (verbatim from `agent-state/types.ts`): `session_started | prompt_submitted | activity | needs_user{need,summary?} | turn_completed{verdict?:{kind:'done'|'question'|'approval',summary?}} | turn_failed{errorClass,retryable} | compaction{phase} | task_delta{delta} | session_ended`.
- **No fabricated state.** Codex approval/plan-ready states are not reliably in the rollout — emit only what the records prove (best-effort, per the approved spec).
- **Commit after each task.** Branch is `worktree-codex-parity`; commit message footer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Pre-existing baseline: the only failing tests on this branch are 4 in `apps/web/test/shell.structure.test.ts` (stale `conn-tooltip`/`ms ping` source assertions) — unrelated, leave them.

---

## File Structure

- **Create** `packages/agent-bridge/src/transcript/codex.ts` — `codexRecordToItems` (rollout record → chat items). Mirrors `transcript/grok.ts`.
- **Create** `packages/agent-bridge/src/transcript/codex.test.ts`.
- **Create** `packages/agent-bridge/src/agent-state/codex.ts` — `codexStateProvider`, `translateCodexEvent`, `classifyCodexVerdict`, `codexBootEvents`, `observeCodexState`, `findLiveCodexRollout`. Mirrors `agent-state/grok.ts`.
- **Create** `packages/agent-bridge/src/agent-state/codex.test.ts`.
- **Modify** `packages/agent-bridge/src/agent-state/index.ts` — export codex.
- **Modify** `packages/agent-bridge/src/agent-state/claude-code.ts` — `agentStateProviderFor` returns codex provider.
- **Modify** `packages/agent-bridge/src/discovery/providers/codex.ts` — add `firstCodexPrompt`, use it in `summarizeCodexHeadRecords`.
- **Modify** `packages/agent-bridge/src/discovery/providers/codex.test.ts` — first-prompt title test.
- **Modify** `apps/daemon/src/daemon.ts` — `startCodexStateObserver`, `tailCodexTranscript`, `initSessionObservers` codex branch, `readParkedTranscript` codex branch, imports.
- **Modify** `packages/terminal-client/src/prompt-extract.ts` — `extractCodexPromptDraft`, `extractDraftFor`.
- **Modify** `packages/terminal-client/src/prompt-extract.test.ts` — codex extractor tests.
- **Modify** `apps/web/src/AgentPanel.tsx` — `chatCapable` fallback + draft-sync extractor selection.
- **Modify** `apps/web/src/ChatView.tsx` — drop the "Codex … no structured transcript" copy.

Task order respects dependencies: 1 (converter) → 2 (titles, independent) → 3 (state, independent) → 4 (daemon, needs 1+3) → 5 (extractor) → 6 (web, needs 1+5) → 7 (verify).

---

## Task 1: Codex transcript converter

**Files:**
- Create: `packages/agent-bridge/src/transcript/codex.ts`
- Test: `packages/agent-bridge/src/transcript/codex.test.ts`

**Interfaces:**
- Consumes: `contentToText`, `isRecord`, `stringField` from `../discovery/jsonl.js`; `toolInputPreview` from `./claude.js`; `TranscriptItem` from `@podium/protocol`.
- Produces: `export function codexRecordToItems(record: unknown): TranscriptItem[]` — the per-record converter the tailer calls (same signature as `grokRecordToItems`).

- [ ] **Step 1: Write the failing test**

`packages/agent-bridge/src/transcript/codex.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { codexRecordToItems } from './codex.js'

const env = (type: string, payload: unknown, ts = '2026-06-16T16:11:00.000Z') => ({
  timestamp: ts,
  type,
  payload,
})

describe('codexRecordToItems', () => {
  it('takes the clean user prompt from event_msg.user_message', () => {
    const items = codexRecordToItems(env('event_msg', { type: 'user_message', message: 'fix the chat view' }))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ role: 'user', text: 'fix the chat view' })
  })

  it('skips the injected response_item user/developer preamble', () => {
    expect(codexRecordToItems(env('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions> …' }] }))).toEqual([])
    expect(codexRecordToItems(env('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md …' }] }))).toEqual([])
  })

  it('emits assistant text from response_item.message(assistant)', () => {
    const items = codexRecordToItems(env('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }))
    expect(items).toEqual([expect.objectContaining({ role: 'assistant', text: 'Done.' })])
  })

  it('maps function_call to a tool item keyed by call_id', () => {
    const items = codexRecordToItems(env('response_item', { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"ls -la"}' }))
    expect(items[0]).toMatchObject({ role: 'tool', toolName: 'exec_command', toolUseId: 'call_1' })
    expect(items[0].toolInput).toContain('ls -la')
  })

  it('maps function_call_output to a tool-result item paired by call_id', () => {
    const items = codexRecordToItems(env('response_item', { type: 'function_call_output', call_id: 'call_1', output: 'total 0\n' }))
    expect(items[0]).toMatchObject({ role: 'tool', toolUseId: 'call_1', toolResult: 'total 0' })
  })

  it('skips reasoning, session_meta, turn_context, and other event_msg', () => {
    expect(codexRecordToItems(env('response_item', { type: 'reasoning', encrypted_content: 'x', summary: [] }))).toEqual([])
    expect(codexRecordToItems(env('session_meta', { id: 'u', cwd: '/x' }))).toEqual([])
    expect(codexRecordToItems(env('turn_context', {}))).toEqual([])
    expect(codexRecordToItems(env('event_msg', { type: 'task_started', turn_id: 't1' }))).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run src/transcript/codex.test.ts`
Expected: FAIL — `Failed to resolve import "./codex.js"` / `codexRecordToItems is not a function`.

- [ ] **Step 3: Write minimal implementation**

`packages/agent-bridge/src/transcript/codex.ts`:
```ts
import type { TranscriptItem } from '@podium/protocol'
import { contentToText, isRecord, stringField } from '../discovery/jsonl.js'
import { toolInputPreview } from './claude.js'

/**
 * Normalize one Codex rollout JSONL record (envelope `{ timestamp, type, payload }`)
 * into Podium chat items. User text is taken from the `event_msg.user_message`
 * event (clean, typed prompt) — the `response_item` user/developer records are the
 * injected AGENTS.md / permissions preamble and a duplicate, so they are skipped.
 * `function_call` / `function_call_output` are separate records paired by `call_id`.
 */
export function codexRecordToItems(record: unknown): TranscriptItem[] {
  if (!isRecord(record)) return []
  const payload = isRecord(record.payload) ? record.payload : undefined
  if (!payload) return []
  const type = stringField(record, 'type')
  const ptype = stringField(payload, 'type')
  const ts = stringField(record, 'timestamp') ?? stringField(payload, 'timestamp')

  if (type === 'event_msg') {
    if (ptype !== 'user_message') return []
    const text = userMessageText(payload)
    return text ? [{ id: stableId('codex-user', `${ts ?? ''}:${text}`), role: 'user', ...(ts ? { ts } : {}), text }] : []
  }

  if (type !== 'response_item') return []

  switch (ptype) {
    case 'message': {
      if (stringField(payload, 'role') !== 'assistant') return []
      const text = contentToText(payload.content).trim()
      return text ? [{ id: stableId('codex-assistant', `${ts ?? ''}:${text}`), role: 'assistant', ...(ts ? { ts } : {}), text }] : []
    }
    case 'function_call':
    case 'custom_tool_call':
      return [toolCallItem(payload, ts)]
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const item = toolResultItem(payload, ts)
      return item ? [item] : []
    }
    default:
      return [] // reasoning (encrypted) and anything unrecognized
  }
}

function userMessageText(payload: Record<string, unknown>): string {
  return (stringField(payload, 'message') ?? contentToText(payload.text_elements)).trim()
}

function toolCallItem(payload: Record<string, unknown>, ts: string | undefined): TranscriptItem {
  const toolName = stringField(payload, 'name') ?? 'tool'
  const callId = stringField(payload, 'call_id') ?? stringField(payload, 'id')
  return {
    id: callId ?? stableId('codex-tool', `${toolName}:${ts ?? ''}`),
    role: 'tool',
    ...(ts ? { ts } : {}),
    text: '',
    toolName,
    toolInput: toolInputPreview(parseArgs(payload.arguments ?? payload.input)),
    ...(callId ? { toolUseId: callId } : {}),
  }
}

function toolResultItem(payload: Record<string, unknown>, ts: string | undefined): TranscriptItem | undefined {
  const out = payload.output
  const text = (typeof out === 'string' ? out : contentToText(out)).trim()
  if (!text) return undefined
  const callId = stringField(payload, 'call_id') ?? stringField(payload, 'id')
  return {
    id: callId ? `${callId}:out` : stableId('codex-tool-result', `${ts ?? ''}:${text}`),
    role: 'tool',
    ...(ts ? { ts } : {}),
    text: '',
    toolResult: truncate(text, 2000),
    ...(callId ? { toolUseId: callId } : {}),
  }
}

function parseArgs(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s
}

function stableId(prefix: string, seed: string): string {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run src/transcript/codex.test.ts`
Expected: PASS (6 tests). If the `toolInput` assertion fails, inspect `toolInputPreview` in `transcript/claude.ts` and adjust the expectation to its real preview format (it returns a one-line string) — do not weaken the call.

- [ ] **Step 5: Commit**
```bash
git add packages/agent-bridge/src/transcript/codex.ts packages/agent-bridge/src/transcript/codex.test.ts
git commit -m "feat(codex): transcript converter for rollout JSONL → chat items

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Codex first-prompt title

**Files:**
- Modify: `packages/agent-bridge/src/discovery/providers/codex.ts` (add `firstCodexPrompt`, use in `summarizeCodexHeadRecords` ~line 254-255)
- Test: `packages/agent-bridge/src/discovery/providers/codex.test.ts`

**Interfaces:**
- Consumes: existing `codexPayload`, `isRecord`, `stringField`, `contentToText` already imported in this file.
- Produces: a `heuristic` `titleSource` when there is no native thread title.

- [ ] **Step 1: Write the failing test** (append to `codex.test.ts`)
```ts
// Near the other summarize tests: an untitled rollout should title from the first
// typed prompt (event_msg.user_message), not the uuid filename.
it('titles an untitled codex session from the first user prompt', async () => {
  // Build a temp rollout: session_meta + injected preamble + a real user_message.
  // (Use the suite's existing temp-dir helper / writeFile pattern.)
  // Expect: summary.title === 'add a dark mode toggle', summary.titleSource === 'heuristic'.
})
```
> Mirror the existing test harness in this file (it already builds temp `~/.codex` layouts with a `state_*.sqlite` and a rollout `.jsonl`). The rollout lines: `{"type":"session_meta","payload":{"id":"u1","cwd":"/repo"}}`, `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md …"}]}}`, `{"type":"event_msg","payload":{"type":"user_message","message":"add a dark mode toggle"}}`. Ensure NO matching `state_*.sqlite` row (so `metadata?.title` is undefined and the heuristic runs).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run src/discovery/providers/codex.test.ts`
Expected: FAIL — title equals the uuid/basename, `titleSource: 'filename'`.

- [ ] **Step 3: Write minimal implementation**

Add `firstCodexPrompt` to `codex.ts` (near `summarizeCodexHeadRecords`):
```ts
function firstCodexPrompt(records: unknown[]): string | undefined {
  for (const record of records) {
    if (!isRecord(record) || stringField(record, 'type') !== 'event_msg') continue
    const payload = codexPayload(record)
    if (stringField(payload, 'type') !== 'user_message') continue
    const text = (stringField(payload, 'message') ?? contentToText(payload.text_elements))
      .replace(/\s+/g, ' ')
      .trim()
    if (!text || text.startsWith('<')) continue
    return text.length > 100 ? `${text.slice(0, 100)}…` : text
  }
  return undefined
}
```
In `summarizeCodexHeadRecords`, replace the `title`/`titleSource` lines (currently 254-255):
```ts
  const promptTitle = metadata?.title ? undefined : firstCodexPrompt(records)

  return {
    id,
    agentKind: 'codex',
    title: metadata?.title ?? promptTitle ?? fallbackTitle(file),
    titleSource: metadata?.title ? 'native' : promptTitle ? 'heuristic' : 'filename',
    // …rest unchanged…
```
> Caveat to note in the commit body: titles are derived from the head read (`readJsonLinesHead`, 64 KB / 50 lines). A very large injected preamble could push `event_msg.user_message` past that window; the native `state_*.sqlite` title is the primary source and usually present. Acceptable for the heuristic fallback.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run src/discovery/providers/codex.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/agent-bridge/src/discovery/providers/codex.ts packages/agent-bridge/src/discovery/providers/codex.test.ts
git commit -m "feat(codex): first-prompt title fallback for untitled sessions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Codex agent-state provider

**Files:**
- Create: `packages/agent-bridge/src/agent-state/codex.ts`
- Test: `packages/agent-bridge/src/agent-state/codex.test.ts`
- Modify: `packages/agent-bridge/src/agent-state/index.ts`, `packages/agent-bridge/src/agent-state/claude-code.ts`

**Interfaces:**
- Consumes: `AgentStateEvent`, `AgentStateProvider` from `./types.js`; `readCodexStateMetadata` from `../discovery/providers/codex-state.js`; `readTranscriptTail` from `../transcript/tailer.js` (optional, for bootEvents). Model `observeCodexState` on `observeGrokState` in `agent-state/grok.ts`.
- Produces:
  - `export const codexStateProvider: AgentStateProvider`
  - `export async function translateCodexEvent(record: unknown): Promise<AgentStateEvent[]>`
  - `export function classifyCodexVerdict(lastAgentMessage: string | undefined): { kind: 'done' | 'question'; summary?: string }`
  - `export function observeCodexState(opts: { cwd: string; resumeValue?: string; homeDir?: string; startedAtMs?: number; pollMs?: number; onSession?: (sessionId: string) => void; onEvents: (events: AgentStateEvent[]) => void }): { stop(): void }`

- [ ] **Step 1: Write the failing test**

`packages/agent-bridge/src/agent-state/codex.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { classifyCodexVerdict, codexStateProvider, translateCodexEvent } from './codex.js'

const env = (ptype: string, extra: Record<string, unknown> = {}) => ({
  type: 'event_msg',
  payload: { type: ptype, ...extra },
})

describe('translateCodexEvent', () => {
  it('maps task_started / user_message to prompt_submitted', async () => {
    expect(await translateCodexEvent(env('task_started'))).toEqual([{ kind: 'prompt_submitted' }])
    expect(await translateCodexEvent(env('user_message', { message: 'hi' }))).toEqual([{ kind: 'prompt_submitted' }])
  })
  it('maps agent_message / token_count to activity', async () => {
    expect(await translateCodexEvent(env('agent_message'))).toEqual([{ kind: 'activity' }])
    expect(await translateCodexEvent(env('token_count'))).toEqual([{ kind: 'activity' }])
  })
  it('maps task_complete to turn_completed with a classified verdict', async () => {
    expect(await translateCodexEvent(env('task_complete', { last_agent_message: 'All done.' })))
      .toEqual([{ kind: 'turn_completed', verdict: { kind: 'done', summary: 'All done.' } }])
    expect(await translateCodexEvent(env('task_complete', { last_agent_message: 'Which file?' })))
      .toEqual([{ kind: 'turn_completed', verdict: { kind: 'question', summary: 'Which file?' } }])
  })
  it('maps turn_aborted to turn_completed (done)', async () => {
    expect(await translateCodexEvent(env('turn_aborted'))).toEqual([{ kind: 'turn_completed' }])
  })
  it('ignores non-event_msg and unknown events', async () => {
    expect(await translateCodexEvent({ type: 'response_item', payload: { type: 'message' } })).toEqual([])
    expect(await translateCodexEvent(env('token_count_unknownx'))).toEqual([])
  })
})

describe('classifyCodexVerdict', () => {
  it('treats a trailing question mark as a question', () => {
    expect(classifyCodexVerdict('Should I proceed?').kind).toBe('question')
    expect(classifyCodexVerdict('Done.').kind).toBe('done')
    expect(classifyCodexVerdict(undefined).kind).toBe('done')
  })
})

describe('codexStateProvider', () => {
  it('injects nothing (observer-based, no hooks)', () => {
    expect(codexStateProvider.instrumentation({ endpointUrl: 'http://x', settingsPath: '/tmp/s' })).toEqual({ args: [] })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run src/agent-state/codex.test.ts`
Expected: FAIL — cannot resolve `./codex.js`.

- [ ] **Step 3: Write minimal implementation**

`packages/agent-bridge/src/agent-state/codex.ts`:
```ts
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readCodexStateMetadata } from '../discovery/providers/codex-state.js'
import type { AgentStateEvent, AgentStateProvider } from './types.js'

const POLL_MS = 700

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function strField(v: unknown, k: string): string | undefined {
  if (!isRecord(v)) return undefined
  const f = v[k]
  return typeof f === 'string' && f.length > 0 ? f : undefined
}

export function classifyCodexVerdict(
  lastAgentMessage: string | undefined,
): { kind: 'done' | 'question'; summary?: string } {
  const summary = lastAgentMessage?.trim()
  const kind = summary?.endsWith('?') ? 'question' : 'done'
  return summary ? { kind, summary } : { kind }
}

/** One Codex rollout record (`{type:'event_msg', payload:{type,…}}`) → state events. */
export async function translateCodexEvent(record: unknown): Promise<AgentStateEvent[]> {
  if (!isRecord(record) || strField(record, 'type') !== 'event_msg') return []
  const payload = isRecord(record.payload) ? record.payload : undefined
  if (!payload) return []
  switch (strField(payload, 'type')) {
    case 'user_message':
    case 'task_started':
      return [{ kind: 'prompt_submitted' }]
    case 'agent_message':
    case 'token_count':
    case 'patch_apply_end':
      return [{ kind: 'activity' }]
    case 'task_complete':
      return [{ kind: 'turn_completed', verdict: classifyCodexVerdict(strField(payload, 'last_agent_message')) }]
    case 'turn_aborted':
      return [{ kind: 'turn_completed' }]
    default:
      return []
  }
}

async function codexBootEvents(opts: {
  cwd: string
  resumeValue?: string
  homeDir?: string
}): Promise<AgentStateEvent[]> {
  if (opts.resumeValue) {
    try {
      const root = join(opts.homeDir ?? homedir(), '.codex')
      const meta = await readCodexStateMetadata(root)
      const rollout = meta.byThreadId.get(opts.resumeValue)?.rolloutPath
      if (rollout) {
        const text = await readFile(rollout, 'utf8')
        const last = lastTaskComplete(text)
        if (last !== undefined) return [{ kind: 'turn_completed', verdict: classifyCodexVerdict(last) }]
      }
    } catch {
      // missing/unreadable → fall through to a bare boot event
    }
  }
  return [{ kind: 'session_started' }]
}

function lastTaskComplete(jsonl: string): string | undefined {
  const lines = jsonl.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (!line) continue
    try {
      const rec = JSON.parse(line)
      if (strField(rec, 'type') !== 'event_msg') continue
      const p = isRecord(rec) && isRecord(rec.payload) ? rec.payload : undefined
      if (p && strField(p, 'type') === 'task_complete') return strField(p, 'last_agent_message') ?? ''
    } catch {
      // skip torn line
    }
  }
  return undefined
}

export const codexStateProvider: AgentStateProvider = {
  // Codex has no hook system; state is observed from its rollout file.
  instrumentation() {
    return { args: [] }
  },
  translate: translateCodexEvent,
  bootEvents: codexBootEvents,
}

/**
 * Discover the live rollout file for a freshly-spawned (or resumed) Codex session
 * and tail its `event_msg` records into normalized state events. Mirrors
 * `observeGrokState`. `onSession` fires once with the rollout id (used as the
 * `codex-thread` resume value) so the daemon can mark the session resumable and
 * start the transcript tail.
 */
export function observeCodexState(opts: {
  cwd: string
  resumeValue?: string
  homeDir?: string
  startedAtMs?: number
  pollMs?: number
  onSession?: (sessionId: string) => void
  onEvents: (events: AgentStateEvent[]) => void
}): { stop(): void } {
  const root = join(opts.homeDir ?? homedir(), '.codex', 'sessions')
  const startedAtMs = opts.startedAtMs ?? 0
  let stopped = false
  let rolloutPath: string | undefined
  let offset = 0
  let announced = false

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      if (!rolloutPath) {
        const found = await findLiveCodexRollout(root, opts.cwd, startedAtMs)
        if (!found) return
        rolloutPath = found.path
        if (!announced && found.id) {
          announced = true
          opts.onSession?.(found.id)
        }
      }
      const { size } = await stat(rolloutPath)
      if (size <= offset) {
        if (size < offset) offset = 0
        return
      }
      const text = (await readFile(rolloutPath, 'utf8')).slice(offset)
      offset = size
      const events: AgentStateEvent[] = []
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          events.push(...(await translateCodexEvent(JSON.parse(trimmed))))
        } catch {
          // torn line — skip
        }
      }
      if (events.length > 0) opts.onEvents(events)
    } catch {
      // file not present yet / transient read error — keep polling
    }
  }

  const timer = setInterval(() => void tick(), opts.pollMs ?? POLL_MS)
  timer.unref?.()
  void tick()
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

/** Newest `rollout-*.jsonl` under ~/.codex/sessions whose session_meta.cwd matches
 *  and whose mtime is at/after the spawn. Returns its path + session_meta.id. */
export async function findLiveCodexRollout(
  sessionsRoot: string,
  cwd: string,
  startedAtMs: number,
): Promise<{ path: string; id: string | undefined } | undefined> {
  const candidates: { path: string; mtimeMs: number }[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.name.endsWith('.jsonl')) {
        try {
          const s = await stat(full)
          if (s.mtimeMs >= startedAtMs - 2000) candidates.push({ path: full, mtimeMs: s.mtimeMs })
        } catch {
          // skip
        }
      }
    }
  }
  await walk(sessionsRoot)
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const c of candidates) {
    try {
      const head = (await readFile(c.path, 'utf8')).split(/\r?\n/, 1)[0]
      const meta = head ? JSON.parse(head) : undefined
      const payload = isRecord(meta) && isRecord(meta.payload) ? meta.payload : undefined
      if (payload && strField(meta, 'type') === 'session_meta' && strField(payload, 'cwd') === cwd) {
        return { path: c.path, id: strField(payload, 'id') }
      }
    } catch {
      // skip unreadable/non-matching
    }
  }
  return undefined
}
```

- [ ] **Step 4: Register the provider**

In `packages/agent-bridge/src/agent-state/index.ts` add:
```ts
export * from './codex.js'
```
In `packages/agent-bridge/src/agent-state/claude-code.ts`, update `agentStateProviderFor` to add a codex branch (it currently returns claude-code, grok, else undefined). Add an import `import { codexStateProvider } from './codex.js'` and the line:
```ts
  if (kind === 'codex') return codexStateProvider
```
> If `agentStateProviderFor` lives in another file (verify with `grep -rn 'agentStateProviderFor' packages/agent-bridge/src`), edit it there. Avoid an import cycle: if `codex.ts` ends up importing from `claude-code.ts`, move `agentStateProviderFor` is NOT needed — codex.ts does not import claude-code.ts.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/agent-bridge && ../../node_modules/.bin/vitest run src/agent-state/codex.test.ts`
Expected: PASS (all describe blocks). Then `cd packages/agent-bridge && ../../node_modules/.bin/vitest run` to confirm no regression in the package.

- [ ] **Step 6: Commit**
```bash
git add packages/agent-bridge/src/agent-state/codex.ts packages/agent-bridge/src/agent-state/codex.test.ts packages/agent-bridge/src/agent-state/index.ts packages/agent-bridge/src/agent-state/claude-code.ts
git commit -m "feat(codex): filesystem-observer agent-state provider

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Daemon wiring (observer + tail + parked read)

**Files:**
- Modify: `apps/daemon/src/daemon.ts`

**Interfaces:**
- Consumes: `codexRecordToItems` from `@podium/agent-bridge` (transcript), `observeCodexState` from `@podium/agent-bridge` (agent-state), `readCodexStateMetadata` from `@podium/agent-bridge` (discovery), existing `ensureTranscriptTail`, `applyAgentStateEvents`, `readTranscriptTail`.
- Produces: live transcript frames + state events + a `codex-thread` resume ref for live Codex sessions; a working `readParkedTranscript` codex branch.

> **Read first:** the Grok analogs in this file — `startGrokStateObserver`, `tailGrokTranscript`, the `initSessionObservers` grok branch, and `readParkedTranscript`. The codex code mirrors them. Confirm the exact import paths the daemon uses for grok symbols and copy that style.

- [ ] **Step 1: Add the observer map + start/stop helpers**

Near the existing `grokStateObservers` map declaration, add:
```ts
const codexStateObservers = new Map<string, { stop(): void }>()
```
Add helpers modeled on `startGrokStateObserver`/`stopGrokStateObserver`:
```ts
const stopCodexStateObserver = (sessionId: string): void => {
  codexStateObservers.get(sessionId)?.stop()
  codexStateObservers.delete(sessionId)
}

const startCodexStateObserver = (
  sessionId: string,
  cwd: string,
  resumeValue: string | undefined,
  startedAtMs = Date.now(),
): void => {
  stopCodexStateObserver(sessionId)
  codexStateObservers.set(
    sessionId,
    observeCodexState({
      cwd,
      ...(resumeValue ? { resumeValue } : {}),
      ...(opts.discovery?.homeDir ? { homeDir: opts.discovery.homeDir } : {}),
      startedAtMs,
      onSession: (codexRolloutId) => {
        send({ type: 'sessionResumeRef', sessionId, resume: { kind: 'codex-thread', value: codexRolloutId } })
        tailCodexTranscript(sessionId, codexRolloutId)
      },
      onEvents: (events) => applyAgentStateEvents(sessionId, events),
    }),
  )
}
```
> `Date.now()` is fine in the daemon (this is NOT a workflow script). Match how `startGrokStateObserver` sources `startedAtMs`.

- [ ] **Step 2: Add `tailCodexTranscript`**

Model on `tailGrokTranscript`. Because the daemon needs the rollout *path* (not just the id) to tail, resolve it from the state DB by id, then tail with the codex converter:
```ts
const tailCodexTranscript = async (sessionId: string, codexRolloutId: string): Promise<void> => {
  try {
    const root = join(homedir(), '.codex')
    const meta = await readCodexStateMetadata(root)
    const path = meta.byThreadId.get(codexRolloutId)?.rolloutPath
    if (path) ensureTranscriptTail(sessionId, path, codexRecordToItems)
  } catch {
    // state DB not ready yet; the observer re-announces are idempotent via ensureTranscriptTail
  }
}
```
> If `readCodexStateMetadata` does not yet know the freshly-created rollout, the path is undefined for a beat. The state observer's `onSession` fires once; if the path is not resolvable immediately, have `observeCodexState` pass the rollout *path* it already discovered. SIMPLER + MORE ROBUST: extend `onSession` to also hand back the path. **Adjust `observeCodexState` so `onSession` is `(sessionId: string, rolloutPath: string) => void`** and call `ensureTranscriptTail(sessionId, rolloutPath, codexRecordToItems)` directly — no state-DB round-trip for the live tail. Update Task 3's signature and test accordingly if you take this path (recommended).

- [ ] **Step 3: Wire into `initSessionObservers`**

In the function that currently has the `if (msg.agentKind === 'grok') startGrokStateObserver(...)` branch, add:
```ts
  if (msg.agentKind === 'codex') {
    startCodexStateObserver(msg.sessionId, msg.cwd, msg.resume?.value, init.codexStartedAt ?? Date.now())
  }
```
> Use the same `init.*StartedAt` plumbing grok uses if present; otherwise `Date.now()`.

- [ ] **Step 4: Stop the observer on dispose**

Wherever `stopGrokStateObserver(sessionId)` is called (session teardown / exit), add `stopCodexStateObserver(sessionId)` alongside it.

- [ ] **Step 5: Add the parked-read branch in `readParkedTranscript`**

Current code branches `isGrok` vs Claude. Add codex before the Claude fallback:
```ts
  const isGrok = msg.agentKind === 'grok' || msg.resume.kind === 'grok-session'
  const isCodex = msg.agentKind === 'codex' || msg.resume.kind === 'codex-thread'
  if (isCodex) {
    const meta = await readCodexStateMetadata(join(homedir(), '.codex'))
    const path = meta.byThreadId.get(msg.resume.value)?.rolloutPath
    const items = path ? await readTranscriptTail(path, codexRecordToItems) : []
    send({ type: 'transcriptReadResult', requestId: msg.requestId, items })
    return
  }
  // …existing grok / claude path…
```

- [ ] **Step 6: Add imports**

At the top of `daemon.ts`, add `codexRecordToItems`, `observeCodexState`, `readCodexStateMetadata` to the existing `@podium/agent-bridge` import(s), matching how `grokRecordToItems` / `observeGrokState` are imported. Ensure `join`, `homedir` are imported (grok path already uses them).

- [ ] **Step 7: Typecheck + tests**

Run: `bun run --filter @podium/daemon typecheck` (or `bun run typecheck` from root).
Expected: no type errors. Run the daemon package tests: `cd apps/daemon && ../../node_modules/.bin/vitest run`. If there is an existing grok daemon test for `readParkedTranscript`, add a codex sibling using a temp `~/.codex` layout with a `state_*.sqlite` row pointing at a rollout `.jsonl`.

- [ ] **Step 8: Commit**
```bash
git add apps/daemon/src/daemon.ts apps/daemon/test 2>/dev/null; git add apps/daemon/src/daemon.ts
git commit -m "feat(codex): daemon observer, live transcript tail, parked read

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Codex prompt-draft extractor

**Files:**
- Modify: `packages/terminal-client/src/prompt-extract.ts`
- Test: `packages/terminal-client/src/prompt-extract.test.ts`

**Interfaces:**
- Produces:
  - `export function extractCodexPromptDraft(lines: string[]): string | null`
  - `export function extractDraftFor(agentKind: string): (lines: string[]) => string | null` — returns `extractClaudePromptDraft` for `'claude-code'`, `extractCodexPromptDraft` for `'codex'`, else `() => null`.

- [ ] **Step 1: Spike — capture Codex's real composer framing**

Codex's TUI composer box glyphs/marker are not assumed. Capture them from a live session before writing the matcher:
```bash
# In a scratch dir, run codex briefly and dump the rendered screen. Easiest: start a
# session in the running Podium host, switch the panel to NATIVE, type a few chars,
# then read the PTY screen via the e2e hook (?e2e=1 → __podium.screenText()), OR
# capture with: tmux new -d -s cxcap 'codex'; sleep 3; tmux send-keys -t cxcap 'hello'; \
#   sleep 1; tmux capture-pane -t cxcap -p | sed -n '1,40p'; tmux kill-session -t cxcap
```
Record the exact top/bottom border chars and the prompt marker (Codex uses a bordered input; confirm whether the marker is `›`, `▌`, `>` or none). Encode those into the test fixtures and the matcher below.

- [ ] **Step 2: Write the failing test** (append to `prompt-extract.test.ts`, using the captured framing)
```ts
import { extractCodexPromptDraft, extractDraftFor } from './prompt-extract'

// Replace BORDER_TOP/BORDER_BOT/MARKER with the glyphs captured in Step 1.
const cbox = (...inner: string[]): string[] => [
  'codex output above',
  '╭────────────────────────────╮',
  ...inner.map((s) => `│ ${s.padEnd(26)} │`),
  '╰────────────────────────────╯',
]

describe('extractCodexPromptDraft', () => {
  it('extracts the in-progress typed text', () => {
    expect(extractCodexPromptDraft(cbox('› add a dark mode toggle'))).toBe('add a dark mode toggle')
  })
  it('returns empty string for an empty composer', () => {
    expect(extractCodexPromptDraft(cbox('›'))).toBe('')
  })
  it('returns null when there is no composer box (no clobber)', () => {
    expect(extractCodexPromptDraft(['just output', 'no box'])).toBeNull()
  })
})

describe('extractDraftFor', () => {
  it('routes by agent kind', () => {
    expect(extractDraftFor('claude-code')(['nope'])).toBeNull()
    expect(extractDraftFor('shell')(['anything'])).toBeNull()
    expect(typeof extractDraftFor('codex')).toBe('function')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/terminal-client && ../../node_modules/.bin/vitest run src/prompt-extract.test.ts`
Expected: FAIL — `extractCodexPromptDraft` undefined.

- [ ] **Step 4: Implement** (adapt the Claude box-walker; substitute Codex's captured glyphs/marker)

Append to `prompt-extract.ts`:
```ts
/** Codex composer extractor — same contract as extractClaudePromptDraft (returns
 *  '' for empty, null when no clean box, so callers never clobber the draft on null).
 *  Glyphs/marker below are confirmed against a live Codex TUI (Task 5 Step 1). */
const CODEX_MARKER = /^\s*[›>▌]\s?/ // replace with the captured marker
export function extractCodexPromptDraft(lines: string[]): string | null {
  let bottom = -1
  let top = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] ?? '').trim()
    if (bottom === -1) {
      if (t.startsWith('╰')) bottom = i
      continue
    }
    if (t.startsWith('╭')) {
      top = i
      break
    }
    if (!t.startsWith('│') && t !== '') return null
  }
  if (top === -1 || bottom === -1 || bottom - top < 2) return null

  const parts: string[] = []
  for (let k = top + 1; k < bottom; k++) {
    const s = lines[k] ?? ''
    const li = s.indexOf('│')
    const ri = s.lastIndexOf('│')
    if (li === -1 || ri === li) return null
    let content = s.slice(li + 1, ri)
    if (k === top + 1) {
      if (!CODEX_MARKER.test(content)) return null
      content = content.replace(CODEX_MARKER, '')
    } else content = content.trimStart()
    parts.push(content.replace(/\s+$/, ''))
  }
  const text = parts.join('\n').replace(/\s+$/, '')
  return text.trim() === '' ? '' : text
}

const NO_DRAFT = (): null => null
export function extractDraftFor(agentKind: string): (lines: string[]) => string | null {
  if (agentKind === 'claude-code') return extractClaudePromptDraft
  if (agentKind === 'codex') return extractCodexPromptDraft
  return NO_DRAFT
}
```
> If Codex renders its composer WITHOUT rounded `╭/╰` borders (Step 1 may reveal a different frame — e.g. a plain prompt line), rewrite the matcher to its real shape and update the test fixtures. The contract (return `''`/`null` correctly, never a garbled partial) is non-negotiable; the glyph details follow the capture.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/terminal-client && ../../node_modules/.bin/vitest run src/prompt-extract.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add packages/terminal-client/src/prompt-extract.ts packages/terminal-client/src/prompt-extract.test.ts
git commit -m "feat(codex): TUI prompt-draft extractor + agent-kind router

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Web panel wiring

**Files:**
- Modify: `apps/web/src/AgentPanel.tsx`
- Modify: `apps/web/src/ChatView.tsx`

**Interfaces:**
- Consumes: `extractDraftFor` from `@podium/terminal-client` (replaces the direct `extractClaudePromptDraft` import).

- [ ] **Step 1: chatCapable fallback includes codex**

In `AgentPanel.tsx` (~line 69-71), change the fallback so Codex offers chat/BTW immediately on spawn (before the first transcript frame), matching Grok:
```ts
  const chatCapable =
    session?.transcriptAvailable ??
    (session?.agentKind === 'claude-code' ||
      session?.agentKind === 'grok' ||
      session?.agentKind === 'codex')
```

- [ ] **Step 2: Draft-sync uses the agent-kind router**

Replace the import (line 1-7 block) `extractClaudePromptDraft` → `extractDraftFor`. In the native-mount effect (~line 105-125), replace the `isClaude`-gated extraction:
```ts
    const extractDraft = session?.agentKind ? extractDraftFor(session.agentKind) : null
    let lastPublished: string | null = null
    let sampleTimer: ReturnType<typeof setTimeout> | null = null
    const sample = () => {
      const m = mountedRef.current
      if (!m || !extractDraft) return
      if (m.connection.state().role !== 'controller') return
      if (!termRef.current?.contains(document.activeElement)) return
      const draft = extractDraft(m.view.screenText().split('\n'))
      if (draft === null || draft === lastPublished) return
      if (draft === '' && lastPublished === null) return
      lastPublished = draft
      setSessionDraft(sessionId, draft)
    }
```
> Keep the existing effect deps; `session?.agentKind` is already a dep. The `null`-returning `NO_DRAFT` for shell means `sample()` early-returns — same behavior as before for non-Claude.

- [ ] **Step 3: Update ChatView copy**

In `ChatView.tsx` (~line 303-304), the empty-state text currently says shells and Codex have no structured transcript. Codex now does — narrow the copy to shells only (and any genuinely transcript-less kind). Example:
```tsx
        shell sessions have no structured transcript.
```
> Verify the surrounding sentence reads correctly after the edit; grep `grep -n "no structured transcript" apps/web/src/ChatView.tsx`.

- [ ] **Step 4: Build + web tests**

Run: `cd apps/web && ../../node_modules/.bin/vitest run`
Expected: the 4 pre-existing `shell.structure.test.ts` failures remain; everything else passes; no NEW failures. Also run `bun run --filter @podium/web build` (or root `bun run build`) to confirm the web bundle compiles with the new import.

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/AgentPanel.tsx apps/web/src/ChatView.tsx
git commit -m "feat(codex): panel chat/BTW/hibernate controls + draft-sync for codex

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Live verification on the host

**Files:** none (manual/e2e).

> The host runs Podium from source with redeploy-on-HEAD. Per memory, headless Chromium (/browse) crashes here; use the committed Playwright harness or manual mobile/desktop testing. Confirm a real Codex session, not a fixture.

- [ ] **Step 1:** Spawn a Codex session in Podium (a repo dir). Type a prompt; let it run a tool and finish a turn.
- [ ] **Step 2:** Confirm the panel header shows the **chat↔live switcher**, the **✨ BTW** button, and (once a turn completes) the **🌙 hibernate** button. Switch to chat — confirm user/assistant/tool messages render and tool call+output pair correctly.
- [ ] **Step 3:** Confirm the **phase badge** goes `working` during the turn and `idle` (or `needs answer` if the agent ended on a question) after.
- [ ] **Step 4:** Confirm the **session title** is the first prompt (not a uuid) for a fresh session in the sidebar/home.
- [ ] **Step 5:** Hibernate the session, then open it — confirm the chat transcript still renders (parked read), then **Resume** and confirm it reattaches.
- [ ] **Step 6:** Click **✨ BTW** on the (a) live and (b) hibernated Codex session — confirm the superagent thread seeds with a recap (parked read feeds `read_session_transcript`).
- [ ] **Step 7:** Native mode: type into the Codex composer, switch to chat — confirm the **draft pre-fills** the composer (draft-sync).
- [ ] **Step 8:** Record any gaps. If the live-rollout id emitted by the observer does NOT resume (`codex resume <id>` fails), that's the #1 risk: inspect what `state_*.sqlite` stores as the thread id vs `session_meta.id`, and emit the id the resume CLI accepts (the discovery provider's `resume.value` is the contract).

---

## Self-Review

**Spec coverage:**
- Chat view → Task 1 (converter) + Task 4 (live tail) + Task 6 (chatCapable). ✓
- BTW live → already works once `transcriptAvailable` flips (Task 4 tail). BTW parked + `read_session_transcript` → Task 4 Step 5 (parked read). ✓
- First-prompt titles → Task 2. ✓
- Phase badge (best-effort) → Task 3 + Task 4 (observer wired, events applied). ✓
- Panel BTW/hibernate/switcher controls → consequences of Task 4 (resume ref → resumable; transcript frames → transcriptAvailable) + Task 6 Step 1 (immediate fallback). ✓
- Draft-sync (required) → Task 5 + Task 6 Step 2. ✓

**Placeholder scan:** Task 5's glyph values are explicitly gated behind a capture step (Step 1) with a concrete command — a discovery step, not a TODO. Task 2's test references the file's existing temp-dir harness rather than re-deriving it — acceptable (repeating that scaffolding verbatim would be guesswork; the implementer reads the sibling tests). No "TBD"/"handle errors"/"similar to Task N" placeholders elsewhere.

**Type consistency:** `codexRecordToItems(record: unknown): TranscriptItem[]` (Tasks 1, 4). `observeCodexState({…onSession, onEvents})` (Tasks 3, 4) — Task 4 Step 2 explicitly upgrades `onSession` to also pass the rollout path and tells you to update Task 3's signature + test; apply that consistently. `extractDraftFor(agentKind): (lines)=>string|null` (Tasks 5, 6). `turn_completed.verdict.kind ∈ {'done','question','approval'}` matches `types.ts`. Resume kind `'codex-thread'` used in Tasks 3, 4 and matches the discovery provider.
