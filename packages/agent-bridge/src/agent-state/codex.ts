import type { Dirent } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LineDecoder } from '../jsonl-stream.js'
import { readCodexStateMetadata } from '../discovery/providers/codex-state.js'
import type { AgentStateEvent, AgentStateProvider } from './types.js'

const POLL_MS = 700
// Bound the polled tail read: a long session's rollout can be many MB, but the
// state observer only needs the recent tail (the latest event wins). Matches the
// transcript tailer's seek-to-tail so a redeploy/reattach doesn't slurp the file.
const TAIL_BYTES = 128 * 1024

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
  let announced = false
  // Incremental, bounded tail (mirrors the transcript tailer): read only the
  // bytes appended since the last poll, buffering partial lines across reads so a
  // record split across a chunk boundary isn't dropped.
  let offset = 0
  let first = true
  let dropLeadingPartial = false
  const decoder = new LineDecoder()
  let reading = false

  const tick = async (): Promise<void> => {
    if (stopped || reading) return
    reading = true
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
      const handle = await open(rolloutPath, 'r')
      try {
        const { size } = await handle.stat()
        if (first) {
          // Seed from the recent tail only — state cares about the latest event,
          // and bootEvents already classified the resumed turn.
          const start = Math.max(0, size - TAIL_BYTES)
          offset = start
          dropLeadingPartial = start > 0
          first = false
        }
        if (size < offset) {
          // Truncated/rotated — start over.
          offset = 0
          decoder.reset()
          dropLeadingPartial = false
        }
        if (size === offset) return
        const chunk = Buffer.alloc(size - offset)
        await handle.read(chunk, 0, chunk.length, offset)
        offset = size
        let lines = decoder.push(chunk)
        if (dropLeadingPartial && lines.length > 0) {
          lines = lines.slice(1)
          dropLeadingPartial = false
        }
        const events: AgentStateEvent[] = []
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            events.push(...(await translateCodexEvent(JSON.parse(trimmed))))
          } catch {
            // torn line — skip
          }
        }
        if (events.length > 0) opts.onEvents(events)
      } finally {
        await handle.close()
      }
    } catch {
      // file not present yet / transient read error — keep polling
    } finally {
      reading = false
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
    let entries: Dirent<string>[]
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
      const head = await readFirstLine(c.path)
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

/**
 * Resolve the rollout file for a PARKED (hibernated/exited) session from its
 * `codex-thread` resume value. The Codex state DB is authoritative; if it's
 * absent/unreadable, fall back to the rollout filename, which embeds the id.
 */
export async function findCodexRolloutPath(opts: {
  resumeValue: string
  homeDir?: string
}): Promise<string | undefined> {
  const root = join(opts.homeDir ?? homedir(), '.codex')
  try {
    const meta = await readCodexStateMetadata(root)
    const fromDb = meta.byThreadId.get(opts.resumeValue)?.rolloutPath
    if (fromDb) return fromDb
  } catch {
    // fall through to the filename match
  }
  let match: string | undefined
  const walk = async (dir: string): Promise<void> => {
    if (match) return
    let entries: Dirent<string>[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (match) return
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.name.endsWith('.jsonl') && e.name.includes(opts.resumeValue)) match = full
    }
  }
  await walk(join(root, 'sessions'))
  return match
}

/** Read just the first line (the session_meta header) without slurping the whole
 *  rollout — the header carries `base_instructions`, so bound it generously. */
async function readFirstLine(path: string): Promise<string | undefined> {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    const text = buf.toString('utf8', 0, bytesRead)
    const nl = text.indexOf('\n')
    return nl >= 0 ? text.slice(0, nl) : text
  } finally {
    await handle.close()
  }
}
