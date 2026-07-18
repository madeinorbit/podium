import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { open, readdir, readFile, readlink, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { type StatTick, scheduleStatPoll } from '@podium/transcript'
import {
  cleanCodexTitle,
  codexPromptTitle,
  isInteractiveCodexSource,
} from '../discovery/providers/codex.js'
import {
  sharedCodexStateMetadataReaders,
  readCodexStateMetadata,
} from '../discovery/providers/codex-state.js'
import { LineDecoder } from '../jsonl-stream.js'
import { fileMtimeIso } from './boot-time.js'
import { withEventTime } from './reducer.js'
import type { AgentStateEvent, AgentStateProvider } from './types.js'

const POLL_MS = 700
// This is a fallback for disabled/untrusted hooks, not the primary binding path.
// Share one host scan across all observers and keep it deliberately slow: live
// pane routing is already P-keyed, so native resumability may safely lag a few
// seconds without taxing the daemon on a large process table.
const PROCESS_ROLLOUT_POLL_MS = 10_000
const PROCESS_SCAN_CACHE_MS = 9_000
const PROCESS_SCAN_BATCH = 64
// Bound the polled tail read: a long session's rollout can be many MB, but the
// state observer only needs the recent tail (the latest event wins). Matches the
// transcript tailer's seek-to-tail so a redeploy/reattach doesn't slurp the file.
const TAIL_BYTES = 128 * 1024
// PermissionRequest hooks do not say whether the request is routed to the user
// or Codex's automatic reviewer. The effective reviewer lives in the rollout.
// Bound the one-off prefix + tail reads so a long-running session never gets
// slurped just to classify an approval.
const SESSION_CONTEXT_BYTES = 1024 * 1024
const PODIUM_SESSION_MARKER_RE = /<podium-session-id>([0-9a-f-]{36})<\/podium-session-id>/i

/** Legacy correlation metadata persisted in Codex's developer-context record. It is
 *  deliberately not a resume id: the Podium row exists before Codex creates a
 *  native thread. New launches use native hooks and never inject this marker. */
export function codexPodiumSessionMarker(sessionId: string): string {
  return `<podium-session-id>${sessionId}</podium-session-id>`
}

type CodexApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function strField(v: unknown, k: string): string | undefined {
  if (!isRecord(v)) return undefined
  const f = v[k]
  return typeof f === 'string' && f.length > 0 ? f : undefined
}

function approvalsReviewerField(value: unknown, key: string): CodexApprovalsReviewer | undefined {
  const reviewer = strField(value, key)
  return reviewer === 'user' || reviewer === 'auto_review' || reviewer === 'guardian_subagent'
    ? reviewer
    : undefined
}

function codexToolName(payload: Record<string, unknown>): string | undefined {
  return strField(payload, 'tool_name') ?? strField(payload, 'name')
}

function isCodexQuestionTool(payload: Record<string, unknown>): boolean {
  return codexToolName(payload) === 'request_user_input'
}

function parseCodexToolInput(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const raw = payload.tool_input ?? payload.arguments ?? payload.input
  if (isRecord(raw)) return raw
  if (typeof raw !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function codexQuestionSummary(payload: Record<string, unknown>): string | undefined {
  const input = parseCodexToolInput(payload)
  if (!input) return undefined
  if (Array.isArray(input.questions)) {
    for (const question of input.questions) {
      const text = strField(question, 'question')
      if (text) return text
    }
  }
  return strField(input, 'question') ?? strField(input, 'prompt')
}

function codexQuestionEvent(payload: Record<string, unknown>, at?: string): AgentStateEvent[] {
  const summary = codexQuestionSummary(payload)
  return withEventTime(
    [{ kind: 'needs_user', need: 'question', ...(summary ? { summary } : {}) }],
    at,
  )
}

function codexCallId(payload: Record<string, unknown>): string | undefined {
  return strField(payload, 'call_id') ?? strField(payload, 'id')
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

/** Read the latest effective approval reviewer from Codex's structured
 * `turn_context`, with the generated permissions developer message as a
 * backwards-compatible fallback. User/tool text can legitimately discuss this
 * setting and must not change live state classification. */
export function codexApprovalsReviewerFromTranscript(
  jsonl: string,
): CodexApprovalsReviewer | undefined {
  let reviewer: CodexApprovalsReviewer | undefined
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(record)) continue
    if (strField(record, 'type') === 'turn_context') {
      const current = approvalsReviewerField(record.payload, 'approvals_reviewer')
      if (current) reviewer = current
      continue
    }
    if (strField(record, 'type') !== 'response_item') continue
    const payload = isRecord(record.payload) ? record.payload : undefined
    if (
      !payload ||
      strField(payload, 'type') !== 'message' ||
      strField(payload, 'role') !== 'developer' ||
      !Array.isArray(payload.content)
    ) {
      continue
    }
    for (const block of payload.content) {
      const text = strField(block, 'text')
      if (!text?.includes('<permissions instructions>')) continue
      const match = /`approvals_reviewer`\s+is\s+`(user|auto_review|guardian_subagent)`/.exec(text)
      if (match?.[1]) reviewer = match[1] as CodexApprovalsReviewer
    }
  }
  return reviewer
}

async function permissionRequestIsAutoReviewed(payload: Record<string, unknown>): Promise<boolean> {
  const transcriptPath = strField(payload, 'transcript_path')
  if (!transcriptPath) return false
  try {
    const handle = await open(transcriptPath, 'r')
    try {
      const { size } = await handle.stat()
      const prefix = Buffer.alloc(Math.min(size, SESSION_CONTEXT_BYTES))
      const { bytesRead: prefixBytes } = await handle.read(prefix, 0, prefix.length, 0)
      let context = prefix.toString('utf8', 0, prefixBytes)
      if (size > SESSION_CONTEXT_BYTES) {
        const tail = Buffer.alloc(SESSION_CONTEXT_BYTES)
        const { bytesRead: tailBytes } = await handle.read(
          tail,
          0,
          tail.length,
          size - SESSION_CONTEXT_BYTES,
        )
        // The first tail line can be partial JSON; the parser deliberately
        // ignores it. A later per-turn context overrides the prefix fallback.
        context += `\n${tail.toString('utf8', 0, tailBytes)}`
      }
      const reviewer = codexApprovalsReviewerFromTranscript(context)
      return reviewer === 'auto_review' || reviewer === 'guardian_subagent'
    } finally {
      await handle.close()
    }
  } catch {
    // Missing/unreadable/old transcript: conservatively preserve the manual
    // approval signal rather than hiding a real prompt from the user.
    return false
  }
}

/**
 * One Codex native-hook POST (payload carries `hook_event_name`, Claude-style) →
 * state events. Codex ≥0.142 fires shell-command hooks with a JSON payload on
 * stdin carrying session_id + transcript_path + event fields; the daemon's hook
 * ingest forwards the parsed payload here. Hooks are the only source for
 * PermissionRequest — codex pauses WITHOUT writing to the rollout while waiting
 * for approval, so the file observer can never see that state.
 */
async function translateCodexHookEvent(
  payload: Record<string, unknown>,
): Promise<AgentStateEvent[]> {
  switch (strField(payload, 'hook_event_name')) {
    case 'SessionStart':
      return [{ kind: 'session_started' }]
    case 'UserPromptSubmit':
      return [{ kind: 'prompt_submitted' }]
    case 'PreToolUse':
      if (isCodexQuestionTool(payload)) return codexQuestionEvent(payload)
      return [{ kind: 'activity' }]
    case 'PostToolUse':
      return [{ kind: 'activity' }]
    case 'PermissionRequest': {
      // Codex fires this before routing the request. With auto-review, the
      // guardian is actively computing and the user has no prompt to answer.
      // Explicit user review (or missing context, conservatively) needs input.
      if (await permissionRequestIsAutoReviewed(payload)) return [{ kind: 'activity' }]
      const summary = strField(payload, 'tool_name')
      return [{ kind: 'needs_user', need: 'permission', ...(summary ? { summary } : {}) }]
    }
    case 'Stop':
      return [
        {
          kind: 'turn_completed',
          verdict: classifyCodexVerdict(strField(payload, 'last_assistant_message')),
        },
      ]
    default:
      return []
  }
}

/** One Codex rollout record (`event_msg` / `response_item`) or native hook
 * payload (`{hook_event_name,…}`) → state events. */
export async function translateCodexEvent(record: unknown): Promise<AgentStateEvent[]> {
  if (isRecord(record) && strField(record, 'hook_event_name')) {
    return await translateCodexHookEvent(record)
  }
  if (isRecord(record) && strField(record, 'type') === 'response_item') {
    const payload = isRecord(record.payload) ? record.payload : undefined
    if (!payload) return []
    const at = strField(record, 'timestamp')
    switch (strField(payload, 'type')) {
      case 'function_call':
      case 'custom_tool_call':
        return isCodexQuestionTool(payload) ? codexQuestionEvent(payload, at) : []
      case 'function_call_output':
      case 'custom_tool_call_output':
        return withEventTime([{ kind: 'activity' }], at)
      default:
        return []
    }
  }
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
    // Older guardian implementations persisted their auto-review lifecycle in
    // the parent rollout. Every status (in_progress/approved/denied/timed_out)
    // means Codex, not the user, owns the next step; it is therefore activity.
    case 'guardian_assessment':
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
      const rollout = await findCodexRolloutPath({
        resumeValue: opts.resumeValue,
        ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
      })
      if (rollout) {
        const seed = classifyResumedRollout(await readFile(rollout, 'utf8'))
        if (seed) {
          if (seed.at === undefined) {
            // Old rollouts without per-record timestamps: the file mtime is the
            // best remaining approximation of when the turn boundary happened.
            const at = await fileMtimeIso(rollout)
            return [at ? { ...seed, at } : seed]
          }
          return [seed]
        }
      }
    } catch {
      // missing/unreadable → fall through to a bare boot event
    }
  }
  return [{ kind: 'session_started' }]
}

/**
 * Classify a resumed rollout from its LAST turn boundary or unresolved user-input
 * call. A rollout whose newest boundary is `task_started`/`user_message` has an
 * OPEN turn, unless that turn is parked on `request_user_input`. Matching call
 * outputs distinguish answered questions from pending ones. Events are stamped
 * with the record's own timestamp so recency reflects when the agent actually
 * acted rather than the reattach moment.
 */
function classifyResumedRollout(jsonl: string): AgentStateEvent | undefined {
  const lines = jsonl.split(/\r?\n/)
  const resolvedCallIds = new Set<string>()
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (!line) continue
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      continue // torn line
    }
    const p = isRecord(rec) && isRecord(rec.payload) ? rec.payload : undefined
    if (!p) continue
    const at = strField(rec, 'timestamp')
    if (strField(rec, 'type') === 'response_item') {
      switch (strField(p, 'type')) {
        case 'function_call_output':
        case 'custom_tool_call_output': {
          const callId = codexCallId(p)
          if (callId) resolvedCallIds.add(callId)
          continue
        }
        case 'function_call':
        case 'custom_tool_call': {
          if (!isCodexQuestionTool(p)) continue
          const callId = codexCallId(p)
          if (callId && resolvedCallIds.delete(callId)) continue
          const summary = codexQuestionSummary(p)
          return {
            kind: 'needs_user',
            need: 'question',
            ...(summary ? { summary } : {}),
            ...(at ? { at } : {}),
          }
        }
        default:
          continue
      }
    }
    if (strField(rec, 'type') !== 'event_msg') continue
    switch (strField(p, 'type')) {
      case 'task_complete':
        return {
          kind: 'turn_completed',
          verdict: classifyCodexVerdict(strField(p, 'last_agent_message') ?? ''),
          ...(at ? { at } : {}),
        }
      case 'turn_aborted':
        return {
          kind: 'turn_completed',
          verdict: { kind: 'interrupted', summary: 'turn aborted' },
          ...(at ? { at } : {}),
        }
      case 'task_started':
      case 'user_message':
        return { kind: 'prompt_submitted', ...(at ? { at } : {}) }
      default:
        continue // activity records don't decide whether the turn is open
    }
  }
  return undefined
}

export const codexStateProvider: AgentStateProvider = {
  // Codex hooks are installed GLOBALLY (hooks.json lives in CODEX_HOME, not per
  // spawn — see the daemon ensurePodiumCodexHooks. New sessions prefer the
  // stable, instance-scoped socket; URL remains for one rolling upgrade.
  // Exact binding receipts survive daemon or server reconnects. Theme seeding
  // uses the official per-invocation config override [spec:SP-a04d].
  instrumentation({ endpointUrl, socketPath, receiptDir, seedTheme }) {
    return {
      args: seedTheme ? ['-c', 'tui.theme=ansi'] : [],
      env: {
        [PODIUM_CODEX_HOOK_URL_ENV]: endpointUrl,
        ...(socketPath ? { [PODIUM_CODEX_HOOK_SOCKET_ENV]: socketPath } : {}),
        ...(receiptDir ? { [PODIUM_CODEX_HOOK_RECEIPT_DIR_ENV]: receiptDir } : {}),
      },
    }
  },
  translate: translateCodexEvent,
  bootEvents: codexBootEvents,
}

/** Legacy rolling-upgrade callback used when no stable socket was injected. */
export const PODIUM_CODEX_HOOK_URL_ENV = 'PODIUM_CODEX_HOOK_URL'
/** Stable, instance-scoped Unix socket used by new Codex hook commands. */
export const PODIUM_CODEX_HOOK_SOCKET_ENV = 'PODIUM_CODEX_HOOK_SOCKET'
/** Instance-scoped directory containing at most one pending identity receipt per pane. */
export const PODIUM_CODEX_HOOK_RECEIPT_DIR_ENV = 'PODIUM_CODEX_HOOK_RECEIPT_DIR'

/**
 * Discover the live rollout file for a freshly-spawned (or resumed) Codex session
 * and tail its rollout records into normalized state events. Mirrors
 * `observeGrokState`. `onSession` fires for each exact native-thread binding
 * (initial startup and a later `/clear`) with the rollout id (the `codex-thread`
 * resume value) and the rollout path, so the daemon can mark the session resumable
 * and start the transcript tail directly — no state-DB round-trip on the hot path.
 */
export function observeCodexState(opts: {
  cwd: string
  resumeValue?: string
  podiumSessionId?: string
  homeDir?: string
  startedAtMs?: number
  pollMs?: number
  statTick?: StatTick
  /** Test override for Linux process correlation. */
  procRoot?: string
  onSession?: (sessionId: string, rolloutPath: string, confidence: 'exact' | 'heuristic') => void
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
  // A fresh spawn passes its spawn time as the floor; a reattach passes the
  // session's original createdAt (the server persists it). Codex creates the
  // rollout file LAZILY — often only at the first prompt, which can land after a
  // daemon restart — so reattach MUST be able to discover by cwd+floor or a
  // session whose rollout appeared after a restart stays status-blind forever.
  // With no resumeValue AND no floor at all (older server), discovering by cwd
  // would grab a sibling's rollout, so we stay idle instead.
  const canDiscoverByCwd = opts.startedAtMs !== undefined
  let stopped = false
  let rolloutPath: string | undefined
  let rolloutCreatedMs = 0
  let rolloutConfidence: 'exact' | 'heuristic' | undefined
  let announcedThreadId: string | undefined
  let nextProcessRolloutPollAt = 0
  // One-shot diagnostics: an observer that can't bind is a silently dead status
  // pipeline (the exact failure mode that left active sessions shown idle), so
  // say so once instead of polling forever in silence.
  let unboundTicks = 0
  let warnedUnbound = false
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
  const stateReader = sharedCodexStateMetadataReaders.acquire(codexHome)
  const readState = stateReader.read

  const bindRollout = (found: {
    path: string
    id: string | undefined
    createdMs: number
    confidence: 'exact' | 'heuristic'
  }): void => {
    const changedPath = rolloutPath !== found.path
    rolloutPath = found.path
    rolloutCreatedMs = found.createdMs
    rolloutConfidence = found.confidence
    if (changedPath) {
      offset = 0
      first = true
      dropLeadingPartial = false
      readFromStart = false
      firstPromptTitled = false
      decoder.reset()
    }
    if (found.id && announcedThreadId !== found.id) {
      announcedThreadId = found.id
      threadId = found.id
      opts.onSession?.(found.id, found.path, found.confidence)
    }
  }

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
      const meta = await readState()
      sendTitle(cleanCodexTitle(meta.byThreadId.get(threadId)?.title))
    } catch {
      // no/unreadable state DB — fall back to the first-prompt tail
    }
  }

  const tick = async (): Promise<void> => {
    if (stopped || reading) return
    reading = true
    try {
      // [spec:SP-fccf] The stable Podium id identifies the live pane. On Linux,
      // its inherited process environment plus that process's open rollout FD
      // gives an exact P→T mapping without putting P in a prompt or guessing by
      // cwd/time. Recheck slowly after binding so an untrusted hook's `/clear`
      // still advances to the new native thread.
      const now = Date.now()
      if (opts.podiumSessionId && now >= nextProcessRolloutPollAt) {
        nextProcessRolloutPollAt = now + PROCESS_ROLLOUT_POLL_MS
        const processBound = await cachedProcessBoundCodexRollout(
          root,
          opts.podiumSessionId,
          opts.procRoot ?? '/proc',
        )
        if (
          processBound &&
          (rolloutPath === undefined ||
            processBound.path === rolloutPath ||
            rolloutConfidence === 'heuristic' ||
            processBound.createdMs > rolloutCreatedMs)
        ) {
          bindRollout(processBound)
        }
      }
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
            ? await findLiveCodexRollout(root, opts.cwd, startedAtMs, opts.podiumSessionId)
            : undefined
        if (!found) {
          unboundTicks++
          if (!warnedUnbound && unboundTicks === 40) {
            warnedUnbound = true
            console.warn(
              `[podium] codex state observer unbound after ${unboundTicks} ticks ` +
                `(cwd=${opts.cwd}, resumeValue=${opts.resumeValue ?? 'none'}, ` +
                `floor=${opts.startedAtMs ?? 'none'}) — status will read idle until a rollout binds`,
            )
          }
          return
        }
        bindRollout(found)
      }
      // Re-read the native (state-DB) title every tick so an in-session `/rename`
      // propagates; the first read also seeds a resumed session's title. No-op
      // until the thread is known; sendTitle suppresses unchanged values.
      await pollNativeTitle()
      // Keep the narrowed path across the await above. No other callback clears
      // a binding, but TypeScript correctly treats the captured variable as
      // mutable while asynchronous work runs.
      const activeRolloutPath = rolloutPath
      if (!activeRolloutPath) return
      const handle = await open(activeRolloutPath, 'r')
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

  const stopPolling = scheduleStatPoll(() => void tick(), {
    statTick: opts.statTick,
    pollMs: opts.pollMs ?? POLL_MS,
  })
  void tick()
  return {
    stop() {
      stopped = true
      stopPolling()
      stateReader.release()
    },
  }
}

/** When the interactive session started, from `session_meta` (record or payload
 *  timestamp). Undefined when the header carries no parseable time. */
function sessionMetaStartedAtMs(
  meta: Record<string, unknown>,
  payload: Record<string, unknown>,
): number | undefined {
  const raw = strField(payload, 'timestamp') ?? strField(meta, 'timestamp')
  if (!raw) return undefined
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : undefined
}

export interface ProcessBoundCodexRollout {
  path: string
  id: string
  createdMs: number
  confidence: 'exact'
}

async function scanProcessBoundCodexRollouts(
  sessionsRoot: string,
  procRoot: string,
): Promise<Map<string, ProcessBoundCodexRollout>> {
  const root = resolve(sessionsRoot)
  const byPodiumId = new Map<string, ProcessBoundCodexRollout>()
  let processes: { pid: string; codexNamed: boolean }[]
  try {
    const named = procRoot === '/proc' ? await findNamedCodexProcesses() : undefined
    processes =
      named ??
      (await readdir(procRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => ({ pid: entry.name, codexNamed: false }))
  } catch {
    return byPodiumId
  }

  const inspectProcess = async (processEntry: {
    pid: string
    codexNamed: boolean
  }): Promise<void> => {
    const processDir = join(procRoot, processEntry.pid)
    try {
      // Avoid reading every descendant's environment. The exact Podium id is on
      // the Codex process itself, and only a Codex process owns rollout FDs.
      if (!processEntry.codexNamed) {
        const cmdline = await readFile(join(processDir, 'cmdline'), 'utf8')
        if (!cmdline.toLowerCase().includes('codex')) return
      }
      const environ = await readFile(join(processDir, 'environ'), 'utf8')
      const assignment = environ.split('\0').find((entry) => entry.startsWith('PODIUM_SESSION_ID='))
      const podiumSessionId = assignment?.slice('PODIUM_SESSION_ID='.length)
      if (!podiumSessionId) return

      const fdDir = join(processDir, 'fd')
      const fds = await readdir(fdDir)
      const seenPaths = new Set<string>()
      for (const fd of fds) {
        let target: string
        try {
          target = await readlink(join(fdDir, fd))
        } catch {
          continue
        }
        if (!target.endsWith('.jsonl') || target.endsWith(' (deleted)')) continue
        const path = resolve(target)
        const rel = relative(root, path)
        if (!rel || rel.startsWith('..') || isAbsolute(rel) || seenPaths.has(path)) continue
        seenPaths.add(path)

        try {
          const prefix = await readPrefix(path)
          const nl = prefix?.indexOf('\n') ?? -1
          const head = prefix ? (nl >= 0 ? prefix.slice(0, nl) : prefix) : undefined
          const meta = head ? JSON.parse(head) : undefined
          const payload = isRecord(meta) && isRecord(meta.payload) ? meta.payload : undefined
          const id = payload ? strField(payload, 'id') : undefined
          if (
            !payload ||
            !id ||
            strField(meta, 'type') !== 'session_meta' ||
            !isInteractiveCodexSource(payload.source)
          ) {
            continue
          }
          const info = await stat(path)
          const createdMs =
            sessionMetaStartedAtMs(meta, payload) ||
            info.birthtimeMs ||
            info.ctimeMs ||
            info.mtimeMs
          const prior = byPodiumId.get(podiumSessionId)
          if (!prior || createdMs >= prior.createdMs) {
            byPodiumId.set(podiumSessionId, {
              path,
              id,
              createdMs,
              confidence: 'exact',
            })
          }
        } catch {
          // A process can close or rotate an FD while we inspect it. Retry next poll.
        }
      }
    } catch {
      // Processes exit constantly and other-user /proc entries may be unreadable.
    }
  }
  // Reading thousands of /proc files serially made a fallback scan take hundreds
  // of milliseconds on busy hosts. A bounded batch keeps scan latency low without
  // creating enough simultaneous opens to exhaust the daemon's file descriptors.
  for (let i = 0; i < processes.length; i += PROCESS_SCAN_BATCH) {
    await Promise.all(processes.slice(i, i + PROCESS_SCAN_BATCH).map(inspectProcess))
  }
  return byPodiumId
}

/** Use procps's native /proc traversal when available so a busy host does not
 * make the daemon open every process's cmdline on each fallback poll. Exit 1
 * means there are simply no matching processes; other failures fall back to
 * the portable directory scan above. */
async function findNamedCodexProcesses(): Promise<{ pid: string; codexNamed: true }[] | undefined> {
  return await new Promise((resolveResult) => {
    execFile(
      'pgrep',
      ['-x', 'codex'],
      { encoding: 'utf8', timeout: 1_000, maxBuffer: 256 * 1024 },
      (err, stdout) => {
        if (err && err.code !== 1) {
          resolveResult(undefined)
          return
        }
        const pids = stdout
          .split(/\s+/)
          .filter((pid) => /^\d+$/.test(pid))
          .map((pid) => ({ pid, codexNamed: true as const }))
        resolveResult(pids)
      },
    )
  })
}

/** Exact Linux fallback for an untrusted/disabled native hook. Podium's stable
 * id is inherited by the Codex process, and that process owns its rollout FD;
 * joining those two OS facts cannot confuse same-cwd sibling panes. */
export async function findProcessBoundCodexRollout(
  sessionsRoot: string,
  podiumSessionId: string,
  procRoot = '/proc',
): Promise<ProcessBoundCodexRollout | undefined> {
  return (await scanProcessBoundCodexRollouts(sessionsRoot, procRoot)).get(podiumSessionId)
}

let processScanCache:
  | {
      key: string
      at: number
      value: Promise<Map<string, ProcessBoundCodexRollout>>
    }
  | undefined

function cachedProcessBoundCodexRollout(
  sessionsRoot: string,
  podiumSessionId: string,
  procRoot: string,
): Promise<ProcessBoundCodexRollout | undefined> {
  const key = `${sessionsRoot}\0${procRoot}`
  const now = Date.now()
  if (
    !processScanCache ||
    processScanCache.key !== key ||
    now - processScanCache.at > PROCESS_SCAN_CACHE_MS
  ) {
    processScanCache = {
      key,
      at: now,
      value: scanProcessBoundCodexRollouts(sessionsRoot, procRoot),
    }
  }
  return processScanCache.value.then((bindings) => bindings.get(podiumSessionId))
}

/**
 * The INTERACTIVE `*.jsonl` under `~/.codex/sessions` whose `session_meta.cwd`
 * matches, booted nearest after `startedAtMs`. For a fresh spawn or a floored
 * reattach (`startedAtMs > 0`), only rollouts whose
 * `session_meta` timestamp (fallback: file birthtime) is at/after the spawn —
 * NOT file mtime, which keeps advancing on an active sibling and would collapse
 * every new Codex pane in the same repo onto that sibling's thread. Returns its
 * path plus the `session_meta.id` (used as the resume value).
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
  podiumSessionId?: string,
): Promise<
  | {
      path: string
      id: string | undefined
      createdMs: number
      confidence: 'exact' | 'heuristic'
    }
  | undefined
> {
  const candidates: {
    path: string
    sortMs: number
    id: string | undefined
    podiumSessionId: string | undefined
  }[] = []
  // Day-directory pruning (POD-601): rollouts live under sessions/YYYY/MM/DD and a
  // candidate must satisfy `createdMs >= startedAtMs - 2000`, so a date directory
  // that ENDS more than PRUNE_SLACK_MS before the floor cannot contain one — skip
  // it without listing. The slack absorbs timezone skew between the dir's (local)
  // date and the session_meta (UTC) timestamp. This is what keeps an UNBOUND
  // observer's every-700ms walk from touching months of history.
  const pruneBeforeMs = startedAtMs > 0 ? startedAtMs - 2000 - PRUNE_SLACK_MS : 0
  // One reusable probe buffer for the whole walk — the walk previously allocated a
  // fresh 256 KB buffer PER FILE (~400 MB of churn per tick on a ~1000-rollout
  // tree; the POD-601 heap oscillation). allocUnsafe is fine: only bytesRead are read.
  const probe = Buffer.allocUnsafe(HEAD_PROBE_BYTES)
  const walk = async (dir: string, dateParts: readonly number[] | null): Promise<void> => {
    let entries: Dirent<string>[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        const childParts = datePathParts(dateParts, e.name)
        if (pruneBeforeMs > 0 && childParts && datePeriodEndMs(childParts) < pruneBeforeMs) continue
        await walk(full, childParts)
      } else if (e.name.endsWith('.jsonl')) {
        try {
          // Two-stage read: the session_meta record is the FIRST line and small, so
          // a 4 KB probe settles cwd/source for almost every file; only survivors
          // pay the full 256 KB prefix read (needed for the launch-marker scan).
          const probed = await readHeadProbe(full, probe)
          let prefix: string | undefined
          let head: string | undefined
          if (probed.escalate) {
            prefix = await readPrefix(full)
            const nl = prefix?.indexOf('\n') ?? -1
            head = prefix ? (nl >= 0 ? prefix.slice(0, nl) : prefix) : undefined
          } else {
            head = probed.line
          }
          const meta = head ? JSON.parse(head) : undefined
          const payload = isRecord(meta) && isRecord(meta.payload) ? meta.payload : undefined
          if (
            !payload ||
            strField(meta, 'type') !== 'session_meta' ||
            strField(payload, 'cwd') !== cwd ||
            !isInteractiveCodexSource(payload.source)
          ) {
            continue
          }
          const s = await stat(full)
          const createdMs = sessionMetaStartedAtMs(meta, payload) ?? s.birthtimeMs
          if (startedAtMs > 0 && createdMs < startedAtMs - 2000) continue
          if (prefix === undefined) prefix = await readPrefix(full)
          candidates.push({
            path: full,
            sortMs: createdMs,
            id: strField(payload, 'id'),
            podiumSessionId: prefix?.match(PODIUM_SESSION_MARKER_RE)?.[1],
          })
        } catch {
          // skip unreadable / non-matching candidate
        }
      }
    }
  }
  await walk(sessionsRoot, [])
  // A legacy launch marker is exact evidence and therefore mandatory when the
  // daemon supplied a Podium session id. New unmarked launches wait for their
  // native hook rather than ever guessing a sibling.
  const eligible = podiumSessionId
    ? candidates.filter((candidate) => candidate.podiumSessionId === podiumSessionId)
    : candidates

  // Nearest-after the floor, not newest: Codex creates the rollout file LAZILY
  // (often at the first prompt, minutes after boot), so several sessions' rollouts
  // can all sit past the floor by the time a reattached observer discovers by cwd.
  // Each rollout's session_meta timestamp is its BOOT time, which tracks its own
  // pane's spawn — so the candidate closest after this session's floor is its own;
  // a sibling pane spawned later boots later. Newest-first cross-wired panes.
  eligible.sort((a, b) => a.sortMs - b.sortMs)
  const best = eligible[0]
  return best
    ? {
        path: best.path,
        id: best.id,
        createdMs: best.sortMs,
        confidence: podiumSessionId ? 'exact' : 'heuristic',
      }
    : undefined
}

/**
 * The live-observer counterpart to `findCodexRolloutPath`: resolve a known
 * thread id to `{ path, id }` so a reattached session pins to ITS OWN rollout
 * instead of re-discovering by cwd+mtime. Returns undefined until the rollout
 * exists (the poller retries), so a just-resumed session that hasn't written
 * its file yet keeps waiting rather than latching onto a sibling.
 */
export async function resolvePinnedCodexRollout(
  resumeValue: string,
  homeDir: string | undefined,
): Promise<{ path: string; id: string; createdMs: number; confidence: 'exact' } | undefined> {
  const path = await findCodexRolloutPath({ resumeValue, ...(homeDir ? { homeDir } : {}) })
  if (!path) return undefined
  try {
    const info = await stat(path)
    return { path, id: resumeValue, createdMs: info.birthtimeMs, confidence: 'exact' }
  } catch {
    return { path, id: resumeValue, createdMs: 0, confidence: 'exact' }
  }
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

/** Stage-1 probe window for the discovery walk: big enough for any real
 *  session_meta line (id/cwd/source/git — well under 4 KB). */
const HEAD_PROBE_BYTES = 4 * 1024

/** Date-directory pruning slack: a rollout's session_meta (UTC) timestamp and its
 *  sessions/YYYY/MM/DD (local-date) directory can disagree by up to a timezone
 *  offset; 48h covers every offset with a full day to spare. */
const PRUNE_SLACK_MS = 48 * 60 * 60 * 1000

/**
 * Fold one directory name into the YYYY/MM/DD date-path context. Returns the
 * extended parts while the name fits the next expected component (year 2000-9999,
 * month 1-12, day 1-31), or null for anything off-layout — null disables pruning
 * for that whole subtree, so an unexpected layout is walked, never skipped.
 */
function datePathParts(parts: readonly number[] | null, name: string): readonly number[] | null {
  if (parts === null || parts.length >= 3) return null
  if (!/^\d+$/.test(name)) return null
  const n = Number(name)
  const [min, max] = parts.length === 0 ? [2000, 9999] : parts.length === 1 ? [1, 12] : [1, 31]
  return n >= min && n <= max ? [...parts, n] : null
}

/** The exclusive END (UTC ms) of the period a date path covers: a year dir ends at
 *  Jan 1 of the next year, a month dir at the 1st of the next month, a day dir at
 *  the next midnight. Date.UTC normalizes the overflowed month/day arguments. */
function datePeriodEndMs(parts: readonly number[]): number {
  const [year, month, day] = [parts[0] as number, parts[1], parts[2]]
  if (month === undefined) return Date.UTC(year + 1, 0, 1)
  if (day === undefined) return Date.UTC(year, month, 1)
  return Date.UTC(year, month - 1, day + 1)
}

/**
 * Read the rollout's first line into a caller-owned reusable buffer. `escalate`
 * means the first line may extend past the probe window (no newline AND the read
 * filled the buffer) — the caller falls back to the full prefix read, preserving
 * exact parity with the old single-read behavior.
 */
async function readHeadProbe(
  path: string,
  probe: Buffer,
): Promise<{ line?: string; escalate?: boolean }> {
  const handle = await open(path, 'r')
  try {
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
    const nl = probe.subarray(0, bytesRead).indexOf(0x0a)
    if (nl >= 0) return { line: probe.toString('utf8', 0, nl) }
    if (bytesRead === probe.length) return { escalate: true }
    return { line: probe.toString('utf8', 0, bytesRead) }
  } finally {
    await handle.close()
  }
}

/** Read a bounded rollout prefix. Besides session_meta, a fresh Codex rollout
 *  stores Podium's developer context here; that carries the exact launch marker. */
async function readPrefix(path: string): Promise<string | undefined> {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    return buf.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}
