import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentKind } from '@podium/protocol'
import { codexStateProvider } from './codex.js'
import { grokStateProvider } from './grok.js'
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
        // Fire on *every* tool start, not just AskUserQuestion: a tool starting
        // (especially a long Bash command) is the agent affirmatively working, so
        // "waiting on shell output" reads as working from the moment the tool
        // begins rather than only when it completes. translate() still routes
        // AskUserQuestion → needs_user and every other tool → activity (working).
        PreToolUse: [h],
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
  translate: translateClaudeHookPayload,
  bootEvents: claudeBootEvents,
}

/** Claude's per-project transcript dir name: the cwd with every non-alphanumeric
 *  character flattened to '-' (verified against real hook payloads, CLI 2.1.173). */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export async function claudeBootEvents(opts: {
  cwd: string
  resumeValue?: string
  homeDir?: string
}): Promise<AgentStateEvent[]> {
  if (opts.resumeValue) {
    const transcript = join(
      opts.homeDir ?? homedir(),
      '.claude',
      'projects',
      claudeProjectSlug(opts.cwd),
      `${opts.resumeValue}.jsonl`,
    )
    try {
      const verdict = classifyIdleTranscript(await readTranscriptTail(transcript), 'default')
      if (verdict) return [{ kind: 'turn_completed', verdict }]
    } catch {
      // transcript missing or unreadable — fall through to the bare boot event
    }
  }
  return [{ kind: 'session_started' }]
}

// Transient harness/API failures where a blind "continue" plausibly succeeds.
// billing/auth/config failures would just fail again — those need a human.
const RETRYABLE = new Set([
  'rate_limit',
  'overloaded',
  'server_error',
  'max_output_tokens',
  'unknown',
])

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
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text',
      )
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!text) continue
    if (QUESTIONISH.test(text.slice(-400))) {
      const lastLine =
        text
          .split('\n')
          .filter((l) => l.trim())
          .at(-1) ?? text
      return { kind: 'question', summary: lastLine.trim().slice(0, 140) }
    }
    return { kind: 'done' }
  }
  return undefined
}

async function classifyIdleFromStop(
  p: Record<string, unknown>,
): Promise<IdleClassification | undefined> {
  const planVerdict: IdleClassification | undefined =
    p.permission_mode === 'plan'
      ? { kind: 'approval', summary: 'plan awaiting approval' }
      : undefined
  const transcriptPath = typeof p.transcript_path === 'string' ? p.transcript_path : undefined
  if (!transcriptPath) return planVerdict
  try {
    return classifyIdleTranscript(await readTranscriptTail(transcriptPath), p.permission_mode)
  } catch {
    // unreadable transcript (rotated, perms) — Stop still means idle, just unclassified
    return planVerdict
  }
}

/** The provider registry. Uninstrumented kinds return undefined → phase stays 'unknown'. */
export function agentStateProviderFor(kind: AgentKind): AgentStateProvider | undefined {
  if (kind === 'claude-code') return claudeCodeStateProvider
  if (kind === 'grok') return grokStateProvider
  if (kind === 'codex') return codexStateProvider
  return undefined
}
