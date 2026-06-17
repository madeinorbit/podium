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

/**
 * Best-effort idle verdict from the agent's last message. A trailing question
 * mark reads as "needs answer"; otherwise the turn is done. Codex's rollout has
 * no reliable approval/plan-ready signal (approvals happen in the TUI before any
 * record is written), so we never fabricate one.
 */
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
      return [
        { kind: 'turn_completed', verdict: classifyCodexVerdict(strField(payload, 'last_agent_message')) },
      ]
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
        const last = lastTaskComplete(await readFile(rollout, 'utf8'))
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
  // Codex has no hook system; state is observed from its rollout file instead, so
  // no argv or settings-file injection is needed.
  instrumentation() {
    return { args: [] }
  },
  translate: translateCodexEvent,
  bootEvents: codexBootEvents,
}

/**
 * Discover the live rollout file for a freshly-spawned (or resumed) Codex session
 * and tail its `event_msg` records into normalized state events. Mirrors
 * `observeGrokState`. `onSession` fires once with the rollout id (the `codex-thread`
 * resume value) and the rollout path, so the daemon can mark the session resumable
 * and start the transcript tail directly — no state-DB round-trip on the hot path.
 */
export function observeCodexState(opts: {
  cwd: string
  resumeValue?: string
  homeDir?: string
  startedAtMs?: number
  pollMs?: number
  onSession?: (sessionId: string, rolloutPath: string) => void
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
          opts.onSession?.(found.id, found.path)
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

/**
 * Newest `*.jsonl` under `~/.codex/sessions` whose `session_meta.cwd` matches and
 * whose mtime is at/after the spawn (with a small grace window). Returns its path
 * plus the `session_meta.id` (used as the resume value).
 */
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
          // skip unreadable entry
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
      // skip unreadable / non-matching candidate
    }
  }
  return undefined
}
