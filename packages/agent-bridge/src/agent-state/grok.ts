import type { Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentObservationAckMessage } from '@podium/protocol'
import { type StatTick, scheduleStatPoll } from '@podium/transcript'
import { fileMtimeIso } from './boot-time.js'
import { GrokCausalObserver, type GrokObservationLease } from './grok-causal.js'
import { chooseGrokSessionDir } from './grok-binding.js'
import { withEventTime } from './reducer.js'
import type { AgentStateEvent, AgentStateProvider } from './types.js'

const POLL_MS = 700
const TAIL_BYTES = 128 * 1024

/** Env-gated callback used by the global Grok Build hook install. */
export const PODIUM_GROK_HOOK_URL_ENV = 'PODIUM_GROK_HOOK_URL'

export interface GrokSessionPaths {
  sessionId: string
  sessionDir: string
  summaryPath: string
  updatesPath: string
  chatHistoryPath: string
}

export interface GrokStateObserver {
  readonly path: string | undefined
  stop(): void
  onObservationAck?(ack: AgentObservationAckMessage): void
}

type GrokCausalOptions = Omit<GrokObservationLease, 'providerSessionId'> & {
  providerSessionId?: string | null
}

export const grokStateProvider: AgentStateProvider = {
  // [spec:SP-79c5] Grok personal hooks are installed globally and gated by this
  // session-only callback env. The file observer below remains the fallback.
  instrumentation({ endpointUrl }) {
    return { args: [], env: { [PODIUM_GROK_HOOK_URL_ENV]: endpointUrl } }
  },
  translate: translateGrokUpdatePayload,
  bootEvents: grokBootEvents,
}

export function grokSessionPaths(opts: {
  cwd: string
  sessionId: string
  homeDir?: string
}): GrokSessionPaths {
  const sessionDir = join(
    grokRoot(opts.homeDir),
    'sessions',
    encodeURIComponent(opts.cwd),
    opts.sessionId,
  )
  return {
    sessionId: opts.sessionId,
    sessionDir,
    summaryPath: join(sessionDir, 'summary.json'),
    updatesPath: join(sessionDir, 'updates.jsonl'),
    chatHistoryPath: join(sessionDir, 'chat_history.jsonl'),
  }
}

export async function translateGrokUpdatePayload(payload: unknown): Promise<AgentStateEvent[]> {
  if (!isRecord(payload)) return []
  const directEvent = grokHookEventName(payload)
  if (directEvent) return grokLifecycleEvents(directEvent, payload, payload)

  const method = stringField(payload, 'method')
  if (method !== 'session/update' && method !== '_x.ai/session/update') return []
  const params = recordField(payload, 'params')
  const update = recordField(params, 'update')
  if (!update) return []

  // The update record's own timestamp is the event-time. The observer seeks to the
  // tail on reattach and replays recent records; stamping `at` keeps those replays
  // carrying their original time so recency isn't restamped to "now".
  const at = normalizeGrokProviderTimestamp(payload.timestamp)
  const sessionUpdate = normalizeName(stringField(update, 'sessionUpdate'))
  switch (sessionUpdate) {
    case 'user_message_chunk':
      return withEventTime([{ kind: 'prompt_submitted' }], at)
    case 'tool_call':
    case 'agent_thought_chunk':
    case 'agent_message_chunk':
    case 'tool_call_update':
    case 'tool_result_update':
      return withEventTime([{ kind: 'activity' }], at)
    case 'turn_completed': {
      if (normalizeName(stringField(update, 'stop_reason')) === 'error') {
        return withEventTime([grokTurnFailedEvent(update)], at)
      }
      // Grok's authoritative end-of-turn signal (stop_reason: end_turn). It lands
      // AFTER the Stop hook and the final agent_message_chunk, so it is the record
      // that must settle the phase — without it that trailing chunk (→ activity →
      // 'working') leaves the session stuck 'working' once the turn ends. This is
      // the provider owning its run-state verdict; the reducer only transports it.
      // [spec:SP-8b0e]
      const verdict = await classifyStopPayload(payload)
      return withEventTime([{ kind: 'turn_completed', ...(verdict ? { verdict } : {}) }], at)
    }
    case 'retry_state': {
      const retryState = normalizeName(stringField(update, 'type'))
      if (retryState === 'retrying') return withEventTime([{ kind: 'activity' }], at)
      if (retryState === 'failed' || retryState === 'exhausted') {
        return withEventTime([grokTurnFailedEvent(update)], at)
      }
      return []
    }
    case 'task_backgrounded':
    case 'task_completed':
      // The lifecycle of a detached shell command that runs alongside the turn.
      // It has no bearing on the turn's phase: backgrounding must not extend
      // 'working' past the real turn boundary, and a background task finishing
      // after turn_completed must not resurrect an idle session.
      return []
    case 'hook_execution':
      return withEventTime(await grokHookEvents(update, payload), at)
    default:
      return []
  }
}

export function classifyGrokIdleTranscript(
  records: unknown[],
): { kind: 'done' | 'question' | 'approval'; summary?: string } | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]
    if (!isRecord(record) || record.type !== 'assistant') continue
    const text =
      grokContentText(record.content) || grokContentText(recordField(record, 'message')?.content)
    if (!text) continue
    if (QUESTIONISH.test(text.slice(-400))) {
      const summary =
        text
          .split('\n')
          .filter((line) => line.trim())
          .at(-1) ?? text
      return { kind: 'question', summary: summary.trim().slice(0, 140) }
    }
    return { kind: 'done' }
  }
  return undefined
}

/** Grok writes both ISO strings and Unix epochs. Retain the provider's instant;
 * receipt time is never a substitute for missing or invalid source time.
 * [spec:SP-cdb2] */
export function normalizeGrokProviderTimestamp(value: unknown): string | undefined {
  let epochMs: number
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    epochMs = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value
  } else if (typeof value === 'string' && value.trim()) {
    epochMs = Date.parse(value)
  } else {
    return undefined
  }
  if (!Number.isFinite(epochMs)) return undefined
  try {
    return new Date(epochMs).toISOString()
  } catch {
    return undefined
  }
}

export async function findLatestGrokSessionPaths(opts: {
  cwd: string
  homeDir?: string
  watermarkMs: number
  boundId?: string
}): Promise<GrokSessionPaths | undefined> {
  const workspaceDir = join(grokRoot(opts.homeDir), 'sessions', encodeURIComponent(opts.cwd))
  let entries: Dirent<string>[]
  try {
    entries = await readdir(workspaceDir, { withFileTypes: true })
  } catch {
    return undefined
  }

  const dirInfos: { paths: GrokSessionPaths; createdMs: number; mtimeMs: number }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const paths = grokSessionPaths({ cwd: opts.cwd, sessionId: entry.name, homeDir: opts.homeDir })
    try {
      const summaryInfo = await stat(paths.summaryPath)
      const dirInfo = await stat(paths.sessionDir)
      // Use birthtimeMs when available (Linux may have it); fall back to ctimeMs.
      const createdMs = dirInfo.birthtimeMs > 0 ? dirInfo.birthtimeMs : dirInfo.ctimeMs
      dirInfos.push({ paths, createdMs, mtimeMs: summaryInfo.mtimeMs })
    } catch {
      // Directory exists before summary.json is committed. Try again on the next poll.
    }
  }

  const chosen = chooseGrokSessionDir({
    dirs: dirInfos.map((d) => ({
      id: d.paths.sessionId,
      createdMs: d.createdMs,
      mtimeMs: d.mtimeMs,
    })),
    watermarkMs: opts.watermarkMs,
    boundId: opts.boundId,
  })
  if (!chosen) return undefined
  return dirInfos.find((d) => d.paths.sessionId === chosen)?.paths
}

export function observeGrokState(opts: {
  cwd: string
  resumeValue?: string
  homeDir?: string
  startedAtMs?: number
  pollMs?: number
  statTick?: StatTick
  onSession?: (sessionId: string) => void
  /** Rejecting a candidate prevents every resume, transcript, and bootstrap side effect. */
  onSessionCandidate?: (sessionId: string) => boolean
  /** Fires after history is folded through the captured complete-record EOF. */
  onBootstrap?: (lastCompleteRecordOffset: number) => void
  onEvents?: (events: AgentStateEvent[]) => void
  causal?: GrokCausalOptions
}): GrokStateObserver {
  const pollMs = opts.pollMs ?? POLL_MS
  // watermarkMs is the spawn time: only sessions created at or after this point
  // are eligible to bind, preventing a new chat from inheriting an old transcript.
  // Default 0 = no watermark filtering (plain discovery; find the latest session).
  // A fresh spawn passes its start time so only sessions created after the spawn
  // are eligible, preventing an old active session from being inherited.
  const watermarkMs = opts.startedAtMs ?? 0
  let stopped = false
  let attached: GrokSessionPaths | undefined
  let boundId: string | undefined
  let updateTail: GrokStateObserver | undefined

  const attach = (paths: GrokSessionPaths): void => {
    if (attached?.sessionId === paths.sessionId) return
    if (opts.onSessionCandidate && !opts.onSessionCandidate(paths.sessionId)) return
    updateTail?.stop()
    attached = paths
    boundId = paths.sessionId
    opts.onSession?.(paths.sessionId)
    updateTail = tailGrokUpdates(paths, opts.onEvents ?? (() => {}), {
      pollMs,
      statTick: opts.statTick,
      onBootstrap: opts.onBootstrap,
      ...(opts.causal ? { causal: { ...opts.causal, providerSessionId: paths.sessionId } } : {}),
    })
  }

  const discover = async (): Promise<void> => {
    if (stopped || attached) return
    const paths = await findLatestGrokSessionPaths({
      cwd: opts.cwd,
      ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
      watermarkMs,
      boundId,
    })
    if (paths && !stopped) attach(paths)
  }

  let stopDiscovery: (() => void) | undefined
  if (opts.resumeValue) {
    attach(grokSessionPaths({ cwd: opts.cwd, sessionId: opts.resumeValue, homeDir: opts.homeDir }))
  } else {
    stopDiscovery = scheduleStatPoll(() => void discover(), {
      statTick: opts.statTick,
      pollMs,
    })
    void discover()
  }

  return {
    get path() {
      return updateTail?.path
    },
    stop() {
      stopped = true
      stopDiscovery?.()
      updateTail?.stop()
    },
    onObservationAck(ack) {
      updateTail?.onObservationAck?.(ack)
    },
  }
}

async function grokBootEvents(opts: {
  cwd: string
  resumeValue?: string
  homeDir?: string
}): Promise<AgentStateEvent[]> {
  if (opts.resumeValue) {
    const paths = grokSessionPaths({
      cwd: opts.cwd,
      sessionId: opts.resumeValue,
      ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
    })
    try {
      const verdict = classifyGrokIdleTranscript(
        await readGrokChatHistoryTail(paths.chatHistoryPath),
      )
      if (verdict) {
        // Stamp the chat-history mtime so re-seeding this idle session on reattach
        // restores its real last-active time, not the reattach moment.
        const at = await fileMtimeIso(paths.chatHistoryPath)
        return [{ kind: 'turn_completed', verdict, ...(at ? { at } : {}) }]
      }
    } catch {
      // Missing/unreadable chat history falls back to a bare boot event.
    }
  }
  return [{ kind: 'session_started' }]
}

async function grokHookEvents(
  update: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<AgentStateEvent[]> {
  const event = normalizeName(
    stringField(update, 'event_name') ?? stringField(update, 'hook_event_name'),
  )
  return event ? grokLifecycleEvents(event, update, payload) : []
}

function grokHookEventName(payload: Record<string, unknown>): string | undefined {
  return normalizeName(
    stringField(payload, 'hookEventName') ?? stringField(payload, 'hook_event_name'),
  )
}

async function grokLifecycleEvents(
  event: string,
  fields: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<AgentStateEvent[]> {
  switch (event) {
    case 'session_start':
      return [{ kind: 'session_started' }]
    case 'user_prompt_submit':
      return [{ kind: 'prompt_submitted' }]
    case 'pre_tool_use': {
      const tool = stringField(fields, 'toolName') ?? stringField(fields, 'tool_name')
      if (tool && ['ask_user', 'ask_user_question'].includes(normalizeName(tool) ?? '')) {
        const summary = grokQuestionSummary(fields)
        return [{ kind: 'needs_user', need: 'question', ...(summary ? { summary } : {}) }]
      }
      return [{ kind: 'activity' }]
    }
    case 'post_tool_use':
    case 'post_tool_use_failure':
    case 'notification':
      return [{ kind: 'activity' }]
    case 'permission_denied': {
      const summary = stringField(fields, 'toolName') ?? stringField(fields, 'tool_name')
      return [{ kind: 'needs_user', need: 'permission', ...(summary ? { summary } : {}) }]
    }
    case 'stop': {
      const verdict = await classifyStopPayload(payload)
      return [{ kind: 'turn_completed', ...(verdict ? { verdict } : {}) }]
    }
    case 'stop_failure': {
      return [grokTurnFailedEvent(fields)]
    }
    case 'pre_compact':
      return [{ kind: 'compaction', phase: 'start' }]
    case 'post_compact':
      return [{ kind: 'compaction', phase: 'end' }]
    case 'task_created':
    case 'subagent_start':
      return [{ kind: 'task_delta', delta: 1 }]
    case 'task_completed':
    case 'subagent_stop':
      return [{ kind: 'task_delta', delta: -1 }]
    case 'session_end':
      return [{ kind: 'session_ended' }]
    default:
      return []
  }
}

function grokQuestionSummary(fields: Record<string, unknown>): string | undefined {
  const input = recordField(fields, 'toolInput') ?? recordField(fields, 'tool_input')
  const direct = stringField(input, 'question') ?? stringField(input, 'prompt')
  if (direct) return direct
  const questions = input?.questions
  const first = Array.isArray(questions) && isRecord(questions[0]) ? questions[0] : undefined
  return stringField(first, 'question') ?? stringField(first, 'prompt')
}

function tailGrokUpdates(
  paths: GrokSessionPaths,
  onEvents: (events: AgentStateEvent[]) => void,
  opts: {
    pollMs?: number
    statTick?: StatTick
    onBootstrap?: (lastCompleteRecordOffset: number) => void
    causal?: GrokObservationLease
  } = {},
): GrokStateObserver {
  const causal = opts.causal ? new GrokCausalObserver(opts.causal) : undefined
  let readOffset = 0
  let lastCompleteRecordOffset = 0
  let fileIdentity: string | undefined
  let segmentIdentity: Parameters<GrokCausalObserver['beginSegment']>[0] | undefined
  let prefixAnchor: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let first = true
  let stopped = false
  let reading = false
  let observedWork = false
  const decoder = new BoundedLineDecoder()

  const translateLines = async (lines: DecodedGrokLine[], emit: boolean): Promise<void> => {
    const events: AgentStateEvent[] = []
    for (const line of lines) {
      const trimmed = line.text.trim()
      if (!trimmed) continue
      try {
        const record = JSON.parse(trimmed) as unknown
        const payload = isRecord(record)
          ? { ...record, chat_history_path: paths.chatHistoryPath }
          : record
        const next = await translateGrokUpdatePayload(payload)
        if (isAvailableCommandsUpdate(payload) && (causal || observedWork)) {
          next.push({ kind: 'turn_completed' })
        }
        const at = isRecord(record) ? normalizeGrokProviderTimestamp(record.timestamp) : undefined
        const normalized = withEventTime(next, at)
        if (causal && segmentIdentity && isRecord(record)) {
          const evidence = {
            record,
            cursor: causal.cursorFor(segmentIdentity, line.endOffset),
            events: normalized,
            sourceEventKind: grokSourceEventKind(record),
            providerAt: at ?? null,
          }
          if (emit) causal.enqueue(evidence)
          else causal.fold(evidence)
        } else {
          for (const event of normalized) {
            // Background/tool-only records are activity inside an already-open
            // turn, never causal evidence that opens a new epoch. Likewise, a
            // duplicate terminal after the epoch closed is inert. [spec:SP-cdb2]
            if (
              !observedWork &&
              (event.kind === 'activity' ||
                event.kind === 'needs_user' ||
                event.kind === 'turn_completed' ||
                event.kind === 'turn_failed' ||
                event.kind === 'compaction' ||
                event.kind === 'task_delta')
            ) {
              continue
            }
            observedWork = updateObservedWork(observedWork, event)
            if (emit) events.push(event)
          }
        }
      } catch {
        // Invalid complete records are inert. Torn records remain buffered until
        // their newline arrives and never advance the accepted record boundary.
      }
    }
    if (events.length > 0) onEvents(events)
  }

  const readRange = async (
    handle: Awaited<ReturnType<typeof open>>,
    start: number,
    end: number,
    emit: boolean,
  ): Promise<void> => {
    let position = start
    while (position < end) {
      const length = Math.min(GROK_READ_BYTES, end - position)
      const chunk = Buffer.alloc(length)
      const { bytesRead } = await handle.read(chunk, 0, length, position)
      if (bytesRead === 0) break
      const bytes = chunk.subarray(0, bytesRead)
      const lastNewline = bytes.lastIndexOf(0x0a)
      if (lastNewline >= 0) lastCompleteRecordOffset = position + lastNewline + 1
      await translateLines(decoder.push(bytes, position), emit)
      position += bytesRead
    }
  }

  const bootstrap = async (
    handle: Awaited<ReturnType<typeof open>>,
    size: number,
    identity: string,
    device: string,
    inode: string,
    forceSuccessor: boolean,
  ): Promise<void> => {
    // Capture the last complete-record EOF on this exact descriptor, fold all
    // history once without live callbacks, then begin strictly after it.
    // Historical files may be large, so both scanning and parsing are chunked.
    const boundary = await lastCompleteGrokRecordOffset(handle, size)
    segmentIdentity = {
      segmentId: `grok:${paths.sessionId}:${device}:${inode}:${paths.updatesPath}`,
      pathHint: paths.updatesPath,
      device,
      inode,
    }
    const start = causal?.beginSegment(segmentIdentity, boundary, forceSuccessor) ?? 0
    decoder.reset()
    observedWork = false
    await readRange(handle, start, boundary, false)
    const finalRecord = decoder.takeValidFinalRecord(boundary)
    if (finalRecord) await translateLines([finalRecord], false)
    decoder.reset()
    readOffset = boundary
    lastCompleteRecordOffset = boundary
    fileIdentity = identity
    prefixAnchor = await readGrokPrefix(handle, boundary)
    first = false
    if (causal && segmentIdentity) {
      causal.finishBootstrap(causal.cursorFor(segmentIdentity, boundary))
    }
    opts.onBootstrap?.(lastCompleteRecordOffset)
  }

  const readNew = async (): Promise<void> => {
    if (reading || stopped) return
    reading = true
    try {
      const handle = await open(paths.updatesPath, 'r')
      try {
        const info = await handle.stat()
        const identity = `${info.dev}:${info.ino}`
        const device = String(info.dev)
        const inode = String(info.ino)
        const prefixChanged =
          !first &&
          identity === fileIdentity &&
          prefixAnchor.length > 0 &&
          !(await grokPrefixMatches(handle, prefixAnchor, info.size))
        if (first || identity !== fileIdentity || info.size < readOffset || prefixChanged) {
          if (causal?.hasPendingDelivery) return
          // Rotation/replacement/truncation is a new bootstrap segment. Never
          // replay the replacement prefix through the live callback.
          await bootstrap(handle, info.size, identity, device, inode, !first)
        }
        if (info.size <= readOffset) return
        const end = info.size
        await readRange(handle, readOffset, end, true)
        readOffset = end
        const finalRecord = decoder.takeValidFinalRecord(readOffset)
        if (finalRecord) {
          lastCompleteRecordOffset = readOffset
          await translateLines([finalRecord], true)
        }
        prefixAnchor = await readGrokPrefix(handle, readOffset)
      } finally {
        await handle.close()
      }
    } catch {
      // File may not exist until Grok finishes session initialization.
    } finally {
      reading = false
    }
  }

  const stopPolling = scheduleStatPoll(() => void readNew(), {
    statTick: opts.statTick,
    pollMs: opts.pollMs ?? POLL_MS,
  })
  void readNew()

  return {
    path: paths.updatesPath,
    stop() {
      stopped = true
      stopPolling()
    },
    onObservationAck(ack) {
      causal?.acknowledge(ack)
    },
  }
}

const GROK_READ_BYTES = 64 * 1024
const GROK_MAX_RECORD_BYTES = 1024 * 1024
const GROK_PREFIX_ANCHOR_BYTES = 256

async function readGrokPrefix(
  handle: Awaited<ReturnType<typeof open>>,
  through: number,
): Promise<Buffer> {
  const length = Math.min(GROK_PREFIX_ANCHOR_BYTES, through)
  if (length === 0) return Buffer.alloc(0)
  const prefix = Buffer.alloc(length)
  const { bytesRead } = await handle.read(prefix, 0, length, 0)
  return prefix.subarray(0, bytesRead)
}

async function grokPrefixMatches(
  handle: Awaited<ReturnType<typeof open>>,
  expected: Buffer,
  size: number,
): Promise<boolean> {
  if (size < expected.length) return false
  const actual = Buffer.alloc(expected.length)
  const { bytesRead } = await handle.read(actual, 0, actual.length, 0)
  return bytesRead === expected.length && actual.equals(expected)
}

interface DecodedGrokLine {
  text: string
  endOffset: number
}

/** A bounded JSONL splitter: an oversized malformed record is discarded through
 * its newline instead of growing observer memory without limit. */
class BoundedLineDecoder {
  private pending = Buffer.alloc(0)
  private dropping = false

  push(chunk: Buffer, chunkOffset: number): DecodedGrokLine[] {
    const lines: DecodedGrokLine[] = []
    let start = 0
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue
      const part = chunk.subarray(start, index)
      start = index + 1
      if (this.dropping) {
        this.dropping = false
        this.pending = Buffer.alloc(0)
        continue
      }
      if (this.pending.length + part.length > GROK_MAX_RECORD_BYTES) {
        this.pending = Buffer.alloc(0)
        continue
      }
      const line = this.pending.length === 0 ? part : Buffer.concat([this.pending, part])
      this.pending = Buffer.alloc(0)
      lines.push({ text: line.toString('utf8'), endOffset: chunkOffset + index + 1 })
    }

    const suffix = chunk.subarray(start)
    if (!this.dropping && this.pending.length + suffix.length <= GROK_MAX_RECORD_BYTES) {
      this.pending =
        this.pending.length === 0 ? Buffer.from(suffix) : Buffer.concat([this.pending, suffix])
    } else if (suffix.length > 0) {
      this.pending = Buffer.alloc(0)
      this.dropping = true
    }
    return lines
  }

  takeValidFinalRecord(endOffset: number): DecodedGrokLine | null {
    if (this.dropping || !validGrokJsonRecord(this.pending)) return null
    const record = this.pending.toString('utf8')
    this.pending = Buffer.alloc(0)
    return { text: record, endOffset }
  }

  reset(): void {
    this.pending = Buffer.alloc(0)
    this.dropping = false
  }
}

async function lastCompleteGrokRecordOffset(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<number> {
  if (size === 0) return 0

  // A valid final JSON value is complete even when Grok has not appended its
  // newline yet. Invalid/torn suffixes remain strictly beyond the boundary.
  const candidateStart = Math.max(0, size - GROK_MAX_RECORD_BYTES)
  const candidate = Buffer.alloc(size - candidateStart)
  const { bytesRead } = await handle.read(candidate, 0, candidate.length, candidateStart)
  const bytes = candidate.subarray(0, bytesRead)
  const lastNewline = bytes.lastIndexOf(0x0a)
  const suffix = bytes.subarray(lastNewline + 1)
  if ((candidateStart === 0 || lastNewline >= 0) && validGrokJsonRecord(suffix)) return size
  if (lastNewline >= 0) return candidateStart + lastNewline + 1

  let end = candidateStart
  while (end > 0) {
    const start = Math.max(0, end - GROK_READ_BYTES)
    const chunk = Buffer.alloc(end - start)
    const read = await handle.read(chunk, 0, chunk.length, start)
    const newline = chunk.subarray(0, read.bytesRead).lastIndexOf(0x0a)
    if (newline >= 0) return start + newline + 1
    end = start
  }
  return 0
}

function validGrokJsonRecord(bytes: Buffer): boolean {
  const text = bytes.toString('utf8').trim()
  if (!text) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function grokSourceEventKind(record: Record<string, unknown>): string {
  const hook = grokHookEventName(record)
  if (hook) return `hook:${normalizeName(hook) ?? hook}`
  const update = recordField(recordField(record, 'params'), 'update')
  return `update:${normalizeName(stringField(update, 'sessionUpdate')) ?? 'unknown'}`
}

function isAvailableCommandsUpdate(payload: unknown): boolean {
  if (!isRecord(payload)) return false
  const params = recordField(payload, 'params')
  const update = recordField(params, 'update')
  return normalizeName(stringField(update, 'sessionUpdate')) === 'available_commands_update'
}

function updateObservedWork(current: boolean, event: AgentStateEvent): boolean {
  switch (event.kind) {
    case 'prompt_submitted':
    case 'activity':
      return true
    case 'compaction':
      return event.phase === 'start' ? true : current
    case 'turn_completed':
    case 'turn_failed':
    case 'needs_user':
    case 'session_ended':
    case 'session_started':
      return false
    case 'task_delta':
      return current
  }
}

async function classifyStopPayload(
  payload: Record<string, unknown>,
): Promise<{ kind: 'done' | 'question' | 'approval'; summary?: string } | undefined> {
  const path =
    stringField(payload, 'chat_history_path') ??
    stringField(payload, 'chatHistoryPath') ??
    grokHookChatHistoryPath(payload)
  if (!path) return undefined
  try {
    return classifyGrokIdleTranscript(await readGrokChatHistoryTail(path))
  } catch {
    return undefined
  }
}

function grokHookChatHistoryPath(payload: Record<string, unknown>): string | undefined {
  const sessionId = stringField(payload, 'sessionId') ?? stringField(payload, 'session_id')
  const cwd =
    stringField(payload, 'cwd') ??
    stringField(payload, 'workspaceRoot') ??
    stringField(payload, 'workspace_root')
  if (!sessionId || !cwd) return undefined
  return grokSessionPaths({ cwd, sessionId }).chatHistoryPath
}

async function readGrokChatHistoryTail(path: string): Promise<unknown[]> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES))
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
        // Skip torn final writes.
      }
    }
    return records
  } finally {
    await handle.close()
  }
}

function grokRoot(homeDir: string | undefined): string {
  if (homeDir) return join(homeDir, '.grok')
  return process.env.GROK_HOME || join(homedir(), '.grok')
}

function grokContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (isRecord(block) && typeof block.text === 'string') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function normalizeName(value: string | undefined): string | undefined {
  return value
    ?.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return isRecord(field) ? field : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

/** Grok reports provider failures in retry_state and in the authoritative
 * turn_completed record. Keep the provider-specific vocabulary here and emit
 * only the normalized failure event to shared layers. [spec:SP-8b0e] */
function grokTurnFailedEvent(fields: Record<string, unknown>): AgentStateEvent {
  const message =
    stringField(fields, 'agent_result') ??
    stringField(fields, 'message') ??
    stringField(fields, 'reason') ??
    ''
  const errorType =
    stringField(fields, 'error_type') ?? stringField(fields, 'errorType') ?? 'unknown'
  const detail = `${errorType} ${message}`.toLowerCase()

  if (/\b(?:usage (?:balance )?(?:exhausted|limit)|quota (?:exhausted|limit))\b/.test(detail)) {
    return { kind: 'turn_failed', errorClass: 'usage_limit', retryable: false }
  }
  if (fields.is_rate_limited === true || /\b(?:status )?429\b|too many requests/.test(detail)) {
    return { kind: 'turn_failed', errorClass: 'rate_limit', retryable: true }
  }
  if (/\b(?:overloaded|temporarily at capacity)\b/.test(detail)) {
    return { kind: 'turn_failed', errorClass: 'overloaded', retryable: true }
  }
  if (/\b(?:status )?5\d\d\b|server error/.test(detail)) {
    return { kind: 'turn_failed', errorClass: 'server_error', retryable: true }
  }
  if (/\b(?:status )?(?:401|403)\b|unauthori[sz]ed|authentication/.test(detail)) {
    return { kind: 'turn_failed', errorClass: 'authentication', retryable: false }
  }
  if (/\b(?:status )?402\b|payment required|billing|insufficient credits/.test(detail)) {
    return { kind: 'turn_failed', errorClass: 'billing_error', retryable: false }
  }
  if (/\b(?:network|transport|connection|timeout)\b/.test(detail)) {
    return { kind: 'turn_failed', errorClass: 'network_error', retryable: true }
  }

  const errorClass = normalizeName(errorType) ?? 'unknown'
  return {
    kind: 'turn_failed',
    errorClass,
    retryable: errorClass === 'api' || RETRYABLE.has(errorClass),
  }
}

const QUESTIONISH =
  /(\?\s*$)|\b(should i|shall i|want me to|would you like|let me know|which (one|option|approach)|do you want)\b/i

const RETRYABLE = new Set([
  'rate_limit',
  'overloaded',
  'server_error',
  'max_output_tokens',
  'unknown',
])
