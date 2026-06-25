import type { Dirent } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  cleanCodexTitle,
  codexPromptTitle,
  isInteractiveCodexSource,
} from '../discovery/providers/codex.js'
import {
  createCodexStateMetadataReader,
  readCodexStateMetadata,
} from '../discovery/providers/codex-state.js'
import { LineDecoder } from '../jsonl-stream.js'
import { fileMtimeIso } from './boot-time.js'
import { withEventTime } from './reducer.js'
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
export function classifyCodexVerdict(lastAgentMessage: string | undefined): {
  kind: 'done' | 'question'
  summary?: string
} {
  const summary = lastAgentMessage?.trim()
  const kind = summary?.endsWith('?') ? 'question' : 'done'
  return summary ? { kind, summary } : { kind }
}

/** One Codex rollout record (`{type:'event_msg', payload:{type,…}}`) → state events. */
export async function translateCodexEvent(record: unknown): Promise<AgentStateEvent[]> {
  if (!isRecord(record) || strField(record, 'type') !== 'event_msg') return []
  const payload = isRecord(record.payload) ? record.payload : undefined
  if (!payload) return []
  // The rollout record's own timestamp is the event-time. The state observer seeks
  // to the tail on reattach and replays the recent records — stamping `at` keeps
  // those replays carrying their original time so recency isn't restamped to "now".
  const at = strField(record, 'timestamp')
  switch (strField(payload, 'type')) {
    case 'user_message':
    case 'task_started':
      return withEventTime([{ kind: 'prompt_submitted' }], at)
    case 'agent_message':
    case 'token_count':
    case 'patch_apply_end':
      return withEventTime([{ kind: 'activity' }], at)
    case 'task_complete':
      return withEventTime(
        [
          {
            kind: 'turn_completed',
            verdict: classifyCodexVerdict(strField(payload, 'last_agent_message')),
          },
        ],
        at,
      )
    case 'turn_aborted':
      return withEventTime(
        [
          {
            kind: 'turn_completed',
            verdict: { kind: 'interrupted', summary: 'turn aborted' },
          },
        ],
        at,
      )
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
        if (last !== undefined) {
          // Stamp the rollout mtime so re-seeding this idle session on reattach
          // restores its real last-active time, not the reattach moment.
          const at = await fileMtimeIso(rollout)
          return [
            { kind: 'turn_completed', verdict: classifyCodexVerdict(last), ...(at ? { at } : {}) },
          ]
        }
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
      if (p && strField(p, 'type') === 'task_complete')
        return strField(p, 'last_agent_message') ?? ''
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
  // Fires with a human-readable title whenever it changes (deduped on the last
  // value, never re-emitting an unchanged one). Codex's own OSC terminal title is
  // just the cwd basename (+ spinner glyph), so the daemon suppresses it for Codex
  // and relies on this: the native thread title (a `/rename` done inside Codex,
  // re-read from the state DB each poll so a live rename propagates) wins, else the
  // first typed prompt — the same heuristic the history list uses.
  onTitle?: (title: string) => void
  onEvents: (events: AgentStateEvent[]) => void
}): { stop(): void } {
  const codexHome = join(opts.homeDir ?? homedir(), '.codex')
  const root = join(codexHome, 'sessions')
  const startedAtMs = opts.startedAtMs ?? 0
  // Only a FRESH SPAWN passes a start floor (the daemon omits it on reattach). With
  // no resumeValue AND no start floor we're reattaching a session that never had a
  // rollout — discovering by cwd would grab a sibling's, so we stay idle instead.
  const canDiscoverByCwd = opts.startedAtMs !== undefined
  let stopped = false
  let rolloutPath: string | undefined
  let announced = false
  // The thread id of the live rollout, learned at discovery. Kept so every later
  // tick can re-read the native (state-DB) title and pick up an in-session `/rename`.
  let threadId: string | undefined
  // Last title actually pushed to `onTitle`. A "last value" (not a one-shot boolean)
  // so a title that changes during the session — a `/rename` Codex writes to the
  // state DB — is re-emitted, while an unchanged value is suppressed (no spam, and
  // the daemon forwards every emit verbatim). Also lets a native title that arrives
  // after the first-prompt fallback override it.
  let lastEmittedTitle: string | undefined
  // Once the first typed prompt has supplied a fallback title we stop deriving one
  // from the prompt stream — only a native (state-DB) title may change it after that.
  let firstPromptTitled = false
  // True only when this tick read the rollout from byte 0 (a fresh session). The
  // "first user_message" is the real title only when we've seen the file's start;
  // a resumed session seeds from the tail, so its native title is used instead.
  let readFromStart = false
  // Incremental, bounded tail (mirrors the transcript tailer): read only the
  // bytes appended since the last poll, buffering partial lines across reads so a
  // record split across a chunk boundary isn't dropped.
  let offset = 0
  let first = true
  let dropLeadingPartial = false
  const decoder = new LineDecoder()
  let reading = false
  // The hot path: re-read the native (state-DB) title on every ~700ms tick. The
  // reader skips the SQLite open+`SELECT *` while the state DB's mtime is unchanged,
  // returning the prior metadata, so an idle session no longer hits sqlite per tick.
  const readState = createCodexStateMetadataReader()

  // Emit only on an actual change to a non-empty title — dedups identical values
  // (the daemon forwards every `onTitle` call straight to a `title` frame) while
  // still letting a later title (a native `/rename`) supersede an earlier one.
  const sendTitle = (title: string | undefined): void => {
    if (!title || title === lastEmittedTitle) return
    lastEmittedTitle = title
    opts.onTitle?.(title)
  }

  // The title Codex maintains in its state DB — set when a user runs `/rename`, and
  // the title a resumed session needs (its first prompt sits above our tail window).
  // Re-read on every tick (not once at discovery) so an in-session `/rename` is
  // picked up; `sendTitle` suppresses re-emits while the value is unchanged. A
  // present native title wins over the first-prompt fallback. Missing DB → the live
  // tail still titles fresh sessions from their first prompt.
  const pollNativeTitle = async (): Promise<void> => {
    if (!threadId) return
    try {
      const meta = await readState(codexHome)
      sendTitle(cleanCodexTitle(meta.byThreadId.get(threadId)?.title))
    } catch {
      // no/unreadable state DB — fall back to the first-prompt tail
    }
  }

  const tick = async (): Promise<void> => {
    if (stopped || reading) return
    reading = true
    try {
      if (!rolloutPath) {
        // A reattach/resume already knows the session's own thread id — pin the
        // rollout to THAT (state DB → filename), never re-discover by cwd+mtime.
        // Several Codex sessions commonly share a repo cwd; resolving by newest
        // mtime would collapse them all onto the single most-recent rollout, so
        // every session's chat showed one transcript and the rest "disappeared"
        // into one conversation identity. Only a FRESH spawn (no resumeValue, no
        // rollout yet) discovers by cwd.
        const found = opts.resumeValue
          ? await resolvePinnedCodexRollout(opts.resumeValue, opts.homeDir)
          : canDiscoverByCwd
            ? await findLiveCodexRollout(root, opts.cwd, startedAtMs)
            : undefined
        if (!found) return
        rolloutPath = found.path
        if (!announced && found.id) {
          announced = true
          threadId = found.id
          opts.onSession?.(found.id, found.path)
        }
      }
      // Re-read the native (state-DB) title every tick so an in-session `/rename`
      // propagates; the first read also seeds a resumed session's title. No-op
      // until the thread is known; sendTitle suppresses unchanged values.
      await pollNativeTitle()
      const handle = await open(rolloutPath, 'r')
      try {
        const { size } = await handle.stat()
        if (first) {
          // Seed from the recent tail only — state cares about the latest event,
          // and bootEvents already classified the resumed turn.
          const start = Math.max(0, size - TAIL_BYTES)
          offset = start
          dropLeadingPartial = start > 0
          readFromStart = start === 0
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
          let record: unknown
          try {
            record = JSON.parse(trimmed)
          } catch {
            continue // torn line — skip
          }
          events.push(...(await translateCodexEvent(record)))
          // A fresh session's first typed prompt becomes its title — a one-time
          // fallback (only until the prompt fires). A native title still wins: the
          // state-DB poll above runs each tick and overrides this via sendTitle's
          // change check, so a later `/rename` replaces the first-prompt title.
          if (readFromStart && !firstPromptTitled) {
            const promptTitle = codexPromptTitle(record)
            if (promptTitle) {
              firstPromptTitled = true
              // Don't clobber a native title already emitted this session.
              if (lastEmittedTitle === undefined) sendTitle(promptTitle)
            }
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
 * Newest INTERACTIVE `*.jsonl` under `~/.codex/sessions` whose `session_meta.cwd`
 * matches and whose mtime is at/after the spawn (with a small grace window).
 * Returns its path plus the `session_meta.id` (used as the resume value).
 *
 * "Interactive" (`isInteractiveCodexSource`) is load-bearing: Codex ≥0.142 writes
 * a second, newer rollout per session for its internal "guardian" subagent. Sorting
 * by mtime alone would latch onto the guardian and bind the chat view to its
 * "judging one planned action" transcript instead of the live session's.
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
      if (
        payload &&
        strField(meta, 'type') === 'session_meta' &&
        strField(payload, 'cwd') === cwd &&
        isInteractiveCodexSource(payload.source)
      ) {
        return { path: c.path, id: strField(payload, 'id') }
      }
    } catch {
      // skip unreadable / non-matching candidate
    }
  }
  return undefined
}

/**
 * The live-observer counterpart to `findCodexRolloutPath`: resolve a known
 * thread id to `{ path, id }` so a reattached session pins to ITS OWN rollout
 * instead of re-discovering by cwd+mtime. Returns undefined until the rollout
 * exists (the poller retries), so a just-resumed session that hasn't written
 * its file yet keeps waiting rather than latching onto a sibling.
 */
async function resolvePinnedCodexRollout(
  resumeValue: string,
  homeDir: string | undefined,
): Promise<{ path: string; id: string } | undefined> {
  const path = await findCodexRolloutPath({ resumeValue, ...(homeDir ? { homeDir } : {}) })
  return path ? { path, id: resumeValue } : undefined
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
