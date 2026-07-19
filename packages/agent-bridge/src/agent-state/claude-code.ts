import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type {
  AgentObservation,
  AgentRuntimeState,
  ObservationInputOrigin,
  SessionObservationCheckpointV1,
} from '@podium/protocol'
import {
  type ClaudeTranscriptFeatures,
  classifyClaudeTranscriptDeterministically,
  extractClaudeTranscriptFeatures,
} from './claude-code-classifier.js'
import { locateClaudeSessionFile } from './claude-locate.js'
import { type DeterministicAgentState, deterministicStateToEvents } from './deterministic.js'
import { reduceAgentState } from './reducer.js'
import type { AgentInstrumentation, AgentStateEvent, AgentStateProvider } from './types.js'

// Observation only: every hook replies 200 {} immediately (see the daemon's
// ingest server), so injecting these can never block or steer the agent.
function httpHook(url: string): { hooks: { type: 'http'; url: string }[] } {
  return { hooks: [{ type: 'http', url }] }
}

export function claudeHookSettings(endpointUrl: string, opts?: { seedTheme?: boolean }): string {
  const h = httpHook(endpointUrl)
  return JSON.stringify(
    {
      // theme:auto makes Claude Code query the terminal background (OSC 11 —
      // xterm answers from its live, issue-tinted theme) instead of assuming a
      // scheme. Per-session --settings only; the user's global config is never
      // touched, and with seeding off the key is absent entirely [spec:SP-a04d].
      ...(opts?.seedTheme ? { theme: 'auto' } : {}),
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
        // TaskCreated/Completed are DEAD on Claude Code 2.1.x (empirically never
        // fire for Task/Agent spawns). Kept registered for forward-compat only;
        // nativeSubagentCount is driven by SubagentStart/Stop below — without
        // those the count stayed 0 and M4's →idle debounce had nothing to gate on.
        TaskCreated: [h],
        TaskCompleted: [h],
        // Live native-subagent lifecycle + identity (agent_id / agent_type).
        SubagentStart: [h],
        SubagentStop: [h],
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
  instrumentation({ endpointUrl, settingsPath, seedTheme }): AgentInstrumentation {
    return {
      args: ['--settings', settingsPath],
      file: {
        path: settingsPath,
        contents: claudeHookSettings(endpointUrl, seedTheme !== undefined ? { seedTheme } : {}),
      },
    }
  },
  translate: translateClaudeHookPayload,
  bootEvents: claudeBootEvents,
}

// claudeProjectSlug moved beside the locator (claude-locate.ts); the package
// index re-exports both, so external importers are unaffected.

export async function claudeBootEvents(opts: {
  cwd: string
  resumeValue?: string
  pathHint?: string
  homeDir?: string
}): Promise<AgentStateEvent[]> {
  if (opts.resumeValue) {
    // Locator, not derivation: after a worktree move the transcript lives in the
    // ORIGINAL cwd's bucket — deriving from the current cwd silently misclassified
    // moved sessions as bare session_started (restamping recency on reattach).
    const transcript = await locateClaudeSessionFile({
      cwd: opts.cwd,
      resumeValue: opts.resumeValue,
      ...(opts.pathHint ? { pathHint: opts.pathHint } : {}),
      ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
    })
    if (!transcript) return [{ kind: 'session_started' }]
    try {
      return (await captureClaudeTranscript(transcript)).bootEvents
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
    case 'Stop':
      return await stopEvents(p)
    case 'StopFailure': {
      // Field name not pinned by docs — accept the plausible spellings, then give up
      // to 'unknown' (still errored, still retryable) rather than dropping the event.
      const errorClass = str(p.error_type) ?? str(p.errorType) ?? str(p.matcher) ?? 'unknown'
      return [{ kind: 'turn_failed', errorClass, retryable: RETRYABLE.has(errorClass) }]
    }
    case 'TaskCreated':
      // Dead path on Claude 2.1.x (hooks never observed). task_delta event type
      // stays — Grok still emits it. If this ever fires again it only bumps the
      // anonymous count (no agent_id).
      return [{ kind: 'task_delta', delta: 1 }]
    case 'TaskCompleted':
      return [{ kind: 'task_delta', delta: -1 }]
    case 'SubagentStart': {
      // COUNT REWIRE: this is the live ±1 for nativeSubagentCount on Claude.
      // Captured shape (2.1.212): agent_id, agent_type, session_id (parent),
      // transcript_path, cwd, prompt_id. agent_id names the subagent; reducer
      // sets nativeSubagentCount = nativeSubagents.length after the add.
      const agentId = str(p.agent_id)
      const agentType = str(p.agent_type)
      return [
        {
          kind: 'task_delta',
          delta: 1,
          ...(agentId ? { agentId } : {}),
          ...(agentType ? { agentType } : {}),
        },
      ]
    }
    case 'SubagentStop': {
      // Pair of SubagentStart: remove by agent_id, count = remaining list length.
      const agentId = str(p.agent_id)
      const agentType = str(p.agent_type)
      return [
        {
          kind: 'task_delta',
          delta: -1,
          ...(agentId ? { agentId } : {}),
          ...(agentType ? { agentType } : {}),
        },
      ]
    }
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
export interface ClaudeCausalObserverOptions {
  podiumSessionId: string
  observerGeneration: number
  bindingVersion: number
  providerSessionId: string
  transcriptPath: string
  transcriptSegmentId?: string
  bootstrapState: AgentRuntimeState
  bootstrapOffset: number
  acceptedCheckpoint?: SessionObservationCheckpointV1
  bootstrapAdvanced?: boolean
  bootstrapPromptOrigin?: ObservationInputOrigin
  bootstrapPromptCount?: number
  now?: () => string
}

export interface ClaudePromptHookIdentity {
  recordBoundary: number
  payloadFingerprint: string
}

/**
 * Claude's provider-owned causal barrier. Hook receipt is not itself a turn:
 * only an exact-binding UserPromptSubmit opens an epoch, and Stop/StopFailure
 * closes it absorbingly except for matching child-stop bookkeeping.
 * [spec:SP-cdb2]
 */
export class ClaudeCausalObserver {
  private segmentId: string
  private predecessorSegmentId: string | null = null
  private readonly now: () => string
  private state: AgentRuntimeState
  private turnEpoch = 0
  private providerPromptId: string | null = null
  private lastOffset: number
  private readonly bootstrapOffset: number
  private hookSequence = 0
  private bootstrapped = false
  private epochOpen = false
  private closing = false
  private currentOrigin: ObservationInputOrigin = 'unknown'
  private readonly pendingOrigins: ObservationInputOrigin[] = []
  private readonly seen = new Set<string>()
  private readonly activeChildren = new Set<string>()
  constructor(private readonly options: ClaudeCausalObserverOptions) {
    const checkpoint = options.acceptedCheckpoint
    const reconciledEpochs = checkpoint ? (options.bootstrapPromptCount ?? 0) : 0
    const reconciledNewEpoch = reconciledEpochs > 0
    const reconciledState =
      checkpoint &&
      options.bootstrapAdvanced &&
      (checkpoint.terminalFence === null || reconciledNewEpoch)
    this.state = reconciledState
      ? options.bootstrapState
      : (checkpoint?.turnState ?? options.bootstrapState)
    this.turnEpoch = (checkpoint?.turnEpoch ?? 0) + reconciledEpochs
    this.providerPromptId = reconciledNewEpoch ? null : (checkpoint?.providerPromptId ?? null)
    if (options.bootstrapPromptOrigin !== undefined) {
      this.currentOrigin = options.bootstrapPromptOrigin
    }
    this.now = options.now ?? (() => new Date().toISOString())
    this.segmentId =
      options.transcriptSegmentId ?? `claude:${options.providerSessionId}:${options.transcriptPath}`
    this.bootstrapOffset = options.bootstrapOffset
    this.lastOffset = options.bootstrapOffset
    const acceptedCursor = checkpoint?.providerCursor
    const acceptedHook = acceptedCursor?.components.hook
    if (Number.isSafeInteger(acceptedHook)) this.hookSequence = acceptedHook ?? 0
    if (acceptedCursor?.segmentId === this.segmentId) {
      const offset = acceptedCursor.components.transcript
      if (Number.isSafeInteger(offset)) {
        this.bootstrapOffset = Math.max(this.bootstrapOffset, offset ?? 0)
        this.lastOffset = this.bootstrapOffset
      }
    } else if (acceptedCursor) {
      this.predecessorSegmentId = acceptedCursor.segmentId
    }
    if (checkpoint?.terminalFence?.closing && !reconciledNewEpoch && this.state.awaitingSubagents) {
      this.closing = true
      for (const child of this.state.nativeSubagents ?? []) {
        this.activeChildren.add(child.id)
      }
    } else if (
      checkpoint &&
      this.turnEpoch > 0 &&
      (this.state.phase === 'working' ||
        this.state.phase === 'compacting' ||
        this.state.phase === 'needs_user')
    ) {
      this.epochOpen = true
    }
  }
  /** Rebase after the server's durable ack (including replay rejection, whose
   * acceptedCursor is the already-committed fence) before releasing hooks. */
  acknowledgeCursor(cursor: AgentObservation['providerCursor'] | null | undefined): void {
    if (!cursor) return
    const hook = cursor.components.hook
    if (Number.isSafeInteger(hook)) this.hookSequence = Math.max(this.hookSequence, hook ?? 0)
    if (cursor.segmentId !== this.segmentId) {
      this.predecessorSegmentId = cursor.segmentId
      this.lastOffset = 0
      return
    }
    const offset = cursor.components.transcript
    if (Number.isSafeInteger(offset)) this.lastOffset = Math.max(this.lastOffset, offset ?? 0)
  }

  /** Hooks sharing a transcript byte boundary still need distinct cursor
   * positions; the ack-rebased fence makes the local suffix restart-safe. */
  nextHookOffset(observedOffset: number): number {
    return Number.isSafeInteger(observedOffset) ? observedOffset : this.lastOffset
  }
  recordInputOrigin(origin: ObservationInputOrigin): void {
    if (origin !== 'provider' && origin !== 'unknown') this.pendingOrigins.push(origin)
  }

  bootstrap(): AgentObservation | null {
    if (this.bootstrapped) return null
    this.bootstrapped = true
    return this.observation({
      sourceEventKind: 'bootstrap',
      transitionKind: 'snapshot',
      provenance: 'bootstrap',
      inputOrigin: 'provider',
      priorPhase: 'unknown',
      state: this.state,
      offset: this.bootstrapOffset,
      identity: `bootstrap:${this.bootstrapOffset}`,
    })
  }

  async observeHook(
    payload: unknown,
    transcriptOffset: number,
    inputOrigin?: ObservationInputOrigin,
    transcriptSegmentId?: string,
    promptIdentity?: ClaudePromptHookIdentity,
  ): Promise<AgentObservation | null> {
    if (typeof payload !== 'object' || payload === null || !this.bootstrapped) return null
    const p = payload as Record<string, unknown>
    if (
      p.session_id !== this.options.providerSessionId ||
      p.transcript_path !== this.options.transcriptPath ||
      !Number.isSafeInteger(transcriptOffset) ||
      transcriptOffset < 0
    ) {
      return null
    }

    const hook = str(p.hook_event_name)
    if (!hook) return null

    if (transcriptSegmentId) {
      const identity = parseClaudeTranscriptSegmentId(transcriptSegmentId)
      if (
        !identity ||
        identity.path !== this.options.transcriptPath ||
        !transcriptSegmentId.startsWith(`claude:${this.options.providerSessionId}:`)
      ) {
        return null
      }
      const compatible =
        this.segmentId === transcriptSegmentId ||
        this.segmentId.startsWith(`${transcriptSegmentId}:after:`)
      if (!compatible || transcriptOffset < this.lastOffset) {
        const predecessor = this.segmentId
        this.predecessorSegmentId = predecessor
        this.segmentId = compatible
          ? `${transcriptSegmentId}:after:${createHash('sha256')
              .update(`${predecessor}:${this.lastOffset}:${transcriptOffset}`)
              .digest('hex')}`
          : transcriptSegmentId
        this.lastOffset = 0
      }
    }
    if (transcriptOffset < this.lastOffset) return null

    const hookPromptId = str(p.prompt_id) ?? null
    if (
      hook !== 'UserPromptSubmit' &&
      this.providerPromptId !== null &&
      hookPromptId &&
      hookPromptId !== this.providerPromptId
    ) {
      return null
    }
    const baseIdentity =
      hook === 'UserPromptSubmit' && !hookPromptId
        ? promptIdentity &&
          Number.isSafeInteger(promptIdentity.recordBoundary) &&
          promptIdentity.recordBoundary >= 0 &&
          promptIdentity.recordBoundary <= transcriptOffset
          ? `UserPromptSubmit:record:${promptIdentity.recordBoundary}:${promptIdentity.payloadFingerprint}`
          : null
        : this.hookIdentity(hook, p)
    if (!baseIdentity) return null
    const identity =
      hook === 'UserPromptSubmit' ? baseIdentity : `${this.turnEpoch}:${baseIdentity}`
    if (this.seen.has(identity)) return null
    // Cursor/segment/prompt validation must precede dedupe insertion: invalid
    // evidence cannot poison a later valid hook with the same native identity.
    this.seen.add(identity)
    this.lastOffset = Math.max(this.lastOffset, transcriptOffset)
    this.hookSequence += 1

    if (hook === 'SessionStart') return null
    if (hook === 'UserPromptSubmit') {
      this.turnEpoch += 1
      this.providerPromptId = str(p.prompt_id) ?? null
      this.epochOpen = true
      this.closing = false
      this.activeChildren.clear()
      const origin =
        inputOrigin ??
        this.pendingOrigins.shift() ??
        (p.promptSource === 'system' || p.prompt_source === 'system' ? 'system' : 'unknown')
      this.currentOrigin = origin
      const prior = this.state
      this.state = reduceAgentState(prior, { kind: 'prompt_submitted' }, this.now())
      return this.observation({
        sourceEventKind: hook,
        transitionKind: 'turn_opened',
        provenance: 'live',
        inputOrigin: origin,
        priorPhase: prior.phase,
        state: this.state,
        offset: transcriptOffset,
        identity,
      })
    }

    if (!this.epochOpen && !this.closing) return null
    if (this.closing) {
      if (hook !== 'SubagentStop') return null
      const agentId = str(p.agent_id)
      if (!agentId || !this.activeChildren.has(agentId)) return null
    }

    let events = await translateClaudeHookPayload(payload)
    const scheduledSelfWake =
      hook === 'Stop' &&
      (p.scheduled_self_wake === true || (events.length === 1 && events[0]?.kind === 'activity'))
    if (scheduledSelfWake) {
      events = [{ kind: 'turn_completed' }]
      this.pendingOrigins.unshift('auto_continue')
    }
    if (events.length !== 1) return null
    const event = events[0]!
    if (hook === 'SubagentStart') {
      const agentId = str(p.agent_id)
      if (agentId) this.activeChildren.add(agentId)
    } else if (hook === 'SubagentStop') {
      const agentId = str(p.agent_id)
      if (agentId) this.activeChildren.delete(agentId)
    }

    const prior = this.state
    const next = reduceAgentState(prior, event, this.now())
    if (next === prior) return null
    this.state = next

    const terminal = hook === 'Stop' || hook === 'StopFailure' || hook === 'SessionEnd'
    let transitionKind: AgentObservation['transitionKind'] =
      hook === 'SubagentStop' ? 'subagent_bookkeeping' : 'activity'
    if (terminal) {
      transitionKind = 'turn_terminal'
      this.epochOpen = false
      this.closing = next.awaitingSubagents === true && this.activeChildren.size > 0
    } else if (this.closing && this.activeChildren.size === 0) {
      this.closing = false
    }

    return this.observation({
      sourceEventKind: hook,
      transitionKind,
      provenance: 'live',
      inputOrigin: this.currentOrigin,
      priorPhase: prior.phase,
      state: next,
      offset: transcriptOffset,
      identity,
      providerAt: str(p.timestamp) ?? null,
    })
  }

  private hookIdentity(hook: string, p: Record<string, unknown>): string {
    const native =
      str(p.agent_id) ??
      str(p.tool_use_id) ??
      str(p.tool_use?.toString()) ??
      str(p.error_type) ??
      str(p.prompt_id) ??
      ''
    return [hook, native, str(p.tool_name) ?? '', str(p.stop_hook_active) ?? ''].join(':')
  }

  private observation(input: {
    sourceEventKind: string
    transitionKind: AgentObservation['transitionKind']
    provenance: AgentObservation['provenance']
    inputOrigin: ObservationInputOrigin
    priorPhase: AgentRuntimeState['phase']
    state: AgentRuntimeState
    offset: number
    identity: string
    providerAt?: string | null
  }): AgentObservation {
    const receivedAt = this.now()
    const transitionId = createHash('sha256')
      .update(
        [this.segmentId, this.turnEpoch, input.identity, input.priorPhase, input.state.phase].join(
          '|',
        ),
      )
      .digest('hex')
    return {
      podiumSessionId: this.options.podiumSessionId,
      provider: 'claude-code',
      providerSessionId: this.options.providerSessionId,
      bindingVersion: this.options.bindingVersion,
      providerTurnId: null,
      providerPromptId: this.providerPromptId,
      observerGeneration: this.options.observerGeneration,
      providerCursor: {
        segmentId: this.segmentId,
        components: { transcript: input.offset, hook: this.hookSequence },
        ...(this.predecessorSegmentId ? { predecessorSegmentId: this.predecessorSegmentId } : {}),
      },
      providerAt:
        input.providerAt && Number.isFinite(Date.parse(input.providerAt)) ? input.providerAt : null,
      receivedAt,
      sourceEventKind: input.sourceEventKind,
      transitionKind: input.transitionKind,
      provenance: input.provenance,
      inputOrigin: input.inputOrigin,
      turnEpoch: this.turnEpoch,
      priorPhase: input.priorPhase,
      nextPhase: input.state.phase,
      transitionId,
      state: input.state,
    }
  }
}

const TAIL_BYTES = 128 * 1024

type IdleClassification = {
  kind: 'done' | 'question' | 'approval' | 'interrupted'
  summary?: string
}

function promptText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value !== 'object' || value === null) return null
  const block = value as Record<string, unknown>
  if (block.type === 'tool_result') return null
  if (block.type === 'text' && typeof block.text === 'string') return block.text.trim() || null
  return null
}

function isInterruptMarker(text: string): boolean {
  return /^\[Request interrupted by user(?: for tool use)?\]$/i.test(text.trim())
}

function stripInjectedContext(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

export interface ClaudePromptEvidence {
  offset: number
  recordBoundary: number
  payloadFingerprint: string
  origin: ObservationInputOrigin
  hasAssistantOutputAfter: boolean
}

export interface ClaudeTranscriptCapture {
  boundary: number
  path: string
  device: string
  inode: string
  fileIdentity: string
  bootEvents: AgentStateEvent[]
  prompts: ClaudePromptEvidence[]
  promptCount: number
  latestPrompt: ClaudePromptEvidence | null
}

export interface ClaudeTranscriptCaptureOptions {
  /** Scan prompt evidence only in the accepted checkpoint gap. The bounded
   * classification tail remains independent of this potentially large scan. */
  promptScanStart?: number
  promptScanIdentity?: ClaudeTranscriptFileIdentity
}

export interface ClaudeTranscriptFileIdentity {
  path: string
  device: string
  inode: string
}

export function claudeTranscriptSegmentId(
  providerSessionId: string,
  identity: ClaudeTranscriptFileIdentity,
): string {
  const encoded = Buffer.from(
    JSON.stringify({
      path: identity.path,
      device: identity.device,
      inode: identity.inode,
    }),
  ).toString('base64url')
  return `claude:${providerSessionId}:${encoded}`
}

export function parseClaudeTranscriptSegmentId(
  segmentId: string | undefined,
): ClaudeTranscriptFileIdentity | null {
  if (!segmentId?.startsWith('claude:')) return null
  const encoded = segmentId.split(':', 3)[2]
  if (!encoded) return null
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    return typeof record.path === 'string' &&
      typeof record.device === 'string' &&
      typeof record.inode === 'string'
      ? { path: record.path, device: record.device, inode: record.inode }
      : null
  } catch {
    return null
  }
}

const READ_CHUNK_BYTES = 64 * 1024
const MAX_JSONL_RECORD_BYTES = 2 * 1024 * 1024

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`
}

function fingerprintPromptPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function claudePromptHookFingerprint(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  const prompt = p.prompt ?? p.message ?? p.content
  if (prompt === undefined) return null
  if (typeof prompt === 'string') return fingerprintPromptPayload(stripInjectedContext(prompt))
  if (Array.isArray(prompt)) {
    const texts = prompt
      .map(promptText)
      .filter((value): value is string => value !== null)
      .map(stripInjectedContext)
      .filter(Boolean)
    return texts.length > 0 ? fingerprintPromptPayload(texts.join('\n')) : null
  }
  return fingerprintPromptPayload(prompt)
}

function parseRecord(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function promptPayload(record: Record<string, unknown>): {
  payload: unknown
  origin: ObservationInputOrigin
} | null {
  if (record.type !== 'user' || record.isMeta === true) return null
  const message = record.message
  if (typeof message !== 'object' || message === null) return null
  const m = message as Record<string, unknown>
  if (m.role !== 'user') return null
  const content = Array.isArray(m.content) ? m.content : [m.content]
  const texts = content
    .map(promptText)
    .filter((value): value is string => value !== null)
    .map(stripInjectedContext)
    .filter(Boolean)
  if (texts.length === 0 || texts.every(isInterruptMarker)) return null
  const payload: unknown = texts.join('\n')
  const provablySystem =
    record.promptSource === 'system' ||
    record.prompt_source === 'system' ||
    record.source === 'system'
  return { payload, origin: provablySystem ? 'system' : 'unknown' }
}

interface ClaudePromptAccumulator {
  count: number
  latest: ClaudePromptEvidence | null
  collected: ClaudePromptEvidence[]
  collectAll: boolean
}

function collectClaudePromptEvidence(
  record: Record<string, unknown>,
  offset: number,
  recordBoundary: number,
  accumulator: ClaudePromptAccumulator,
): void {
  const message = record.message
  if (typeof message === 'object' && message !== null) {
    const m = message as Record<string, unknown>
    if (record.type === 'assistant' && m.role === 'assistant') {
      if (accumulator.latest) accumulator.latest.hasAssistantOutputAfter = true
      return
    }
  }
  const prompt = promptPayload(record)
  if (!prompt) return
  const evidence: ClaudePromptEvidence = {
    offset,
    recordBoundary,
    payloadFingerprint: fingerprintPromptPayload(prompt.payload),
    origin: prompt.origin,
    hasAssistantOutputAfter: false,
  }
  accumulator.count += 1
  accumulator.latest = evidence
  if (accumulator.collectAll) accumulator.collected.push(evidence)
}

type ClaudeRecordRow = { record: Record<string, unknown>; offset: number; boundary: number }

async function scanDescriptorRange(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  boundary: number,
  discardInitialPartial = false,
  onRecord: (row: ClaudeRecordRow) => void,
): Promise<void> {
  let position = start
  let lineOffset = start
  let carry = Buffer.alloc(0)
  let skipLine = discardInitialPartial
  let dropOversizedLine = false
  while (position < boundary) {
    const length = Math.min(READ_CHUNK_BYTES, boundary - position)
    const chunk = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(chunk, 0, length, position)
    if (bytesRead === 0) break
    position += bytesRead
    const data =
      carry.length === 0
        ? chunk.subarray(0, bytesRead)
        : Buffer.concat([carry, chunk.subarray(0, bytesRead)])
    let cursor = 0
    if (dropOversizedLine) {
      const newline = data.indexOf(0x0a)
      if (newline < 0) {
        lineOffset += data.length
        continue
      }
      cursor = newline + 1
      dropOversizedLine = false
    }
    for (;;) {
      const newline = data.indexOf(0x0a, cursor)
      if (newline < 0) break
      const recordBoundary = lineOffset + newline + 1
      if (skipLine) {
        skipLine = false
      } else {
        const record = parseRecord(data.subarray(cursor, newline).toString('utf8'))
        if (record) onRecord({ record, offset: lineOffset + cursor, boundary: recordBoundary })
      }
      cursor = newline + 1
    }
    const remainder = data.subarray(cursor)
    if (remainder.length > MAX_JSONL_RECORD_BYTES) {
      lineOffset += data.length
      carry = Buffer.alloc(0)
      dropOversizedLine = true
    } else {
      lineOffset += cursor
      carry = Buffer.from(remainder)
    }
  }
  if (carry.length > 0 && lineOffset < boundary) {
    const record = parseRecord(carry.toString('utf8'))
    if (record) onRecord({ record, offset: lineOffset, boundary })
  }
}

async function readDescriptorRange(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  boundary: number,
  discardInitialPartial = false,
): Promise<ClaudeRecordRow[]> {
  const output: ClaudeRecordRow[] = []
  await scanDescriptorRange(handle, start, boundary, discardInitialPartial, (row) => {
    output.push(row)
  })
  return output
}

async function previousNewlineBoundary(
  handle: Awaited<ReturnType<typeof open>>,
  before: number,
): Promise<number> {
  let end = before
  while (end > 0) {
    const start = Math.max(0, end - READ_CHUNK_BYTES)
    const chunk = Buffer.allocUnsafe(end - start)
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, start)
    const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (newline >= 0) return start + newline + 1
    end = start
  }
  return 0
}

function bootEventsForClaudeRecords(records: unknown[]): AgentStateEvent[] {
  const state = classifyClaudeTranscriptDeterministically(records, 'default')
  const at = [...records].reverse().find((record) => {
    if (typeof record !== 'object' || record === null) return false
    const timestamp = (record as Record<string, unknown>).timestamp
    return typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp))
  }) as Record<string, unknown> | undefined
  const timestamp = typeof at?.timestamp === 'string' ? at.timestamp : undefined
  if (state.status === 'resolved' && state.label === 'idle.needs_input.ask_user_tool') {
    return deterministicStateToEvents(state).map((event) =>
      timestamp ? { ...event, at: timestamp } : event,
    )
  }
  const verdict = idleClassificationFromState(state)
  if (verdict)
    return [
      {
        kind: 'turn_completed',
        verdict,
        ...(timestamp ? { at: timestamp } : {}),
      },
    ]
  return [{ kind: 'session_started', ...(timestamp ? { at: timestamp } : {}) }]
}

/** Capture classification, prompt evidence, exact file identity, and the last
 * complete JSONL boundary from one descriptor/fstat snapshot. */
export async function captureClaudeTranscript(
  path: string,
  options: ClaudeTranscriptCaptureOptions = {},
): Promise<ClaudeTranscriptCapture> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat({ bigint: true })
    if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Claude transcript is too large to address safely: ${path}`)
    }
    const capturedSize = Number(info.size)
    const tailStart = Math.max(0, capturedSize - TAIL_BYTES)
    const tail = Buffer.allocUnsafe(capturedSize - tailStart)
    const { bytesRead } = await handle.read(tail, 0, tail.length, tailStart)
    const capturedTail = tail.subarray(0, bytesRead)
    const lastNewline = capturedTail.lastIndexOf(0x0a)
    let boundary =
      lastNewline < 0
        ? await previousNewlineBoundary(handle, tailStart)
        : tailStart + lastNewline + 1
    const trailing = capturedTail.subarray(lastNewline + 1).toString('utf8')
    if ((lastNewline >= 0 || tailStart === 0) && parseRecord(trailing)) {
      boundary = tailStart + bytesRead
    }

    const classificationStart = Math.max(0, boundary - TAIL_BYTES)
    const classificationRows = await readDescriptorRange(
      handle,
      classificationStart,
      boundary,
      classificationStart > 0,
    )
    const records = classificationRows.map(({ record }) => record)
    const promptAccumulator: ClaudePromptAccumulator = {
      count: 0,
      latest: null,
      collected: [],
      collectAll: options.promptScanStart === undefined,
    }
    const device = String(info.dev)
    const inode = String(info.ino)
    const samePromptScanIdentity =
      options.promptScanIdentity === undefined ||
      (options.promptScanIdentity.path === path &&
        options.promptScanIdentity.device === device &&
        options.promptScanIdentity.inode === inode)
    const promptStart = samePromptScanIdentity ? options.promptScanStart : 0
    if (
      promptStart !== undefined &&
      Number.isSafeInteger(promptStart) &&
      promptStart >= 0 &&
      promptStart <= boundary
    ) {
      await scanDescriptorRange(handle, promptStart, boundary, false, (row) => {
        collectClaudePromptEvidence(row.record, row.offset, row.boundary, promptAccumulator)
      })
    } else {
      for (const row of classificationRows) {
        collectClaudePromptEvidence(row.record, row.offset, row.boundary, promptAccumulator)
      }
    }
    return {
      boundary,
      path,
      device,
      inode,
      fileIdentity: `${device}:${inode}`,
      bootEvents: bootEventsForClaudeRecords(records),
      prompts: promptAccumulator.collected,
      promptCount: promptAccumulator.count,
      latestPrompt: promptAccumulator.latest,
    }
  } finally {
    await handle.close()
  }
}

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

function idleClassificationFromState(
  state: DeterministicAgentState,
): IdleClassification | undefined {
  if (state.status === 'needs_semantic_classification') return undefined
  switch (state.label) {
    case 'idle.finished':
      return { kind: 'done', ...(state.summary ? { summary: state.summary } : {}) }
    case 'idle.interrupted':
      return { kind: 'interrupted', ...(state.summary ? { summary: state.summary } : {}) }
    case 'idle.needs_input.approval':
      return { kind: 'approval', ...(state.summary ? { summary: state.summary } : {}) }
    case 'idle.needs_input.ask_user_tool':
    case 'idle.needs_input.text_question':
      return { kind: 'question', ...(state.summary ? { summary: state.summary } : {}) }
    case 'idle.needs_input.open_todo_list':
      return { kind: 'done', summary: state.summary ?? 'open todo list' }
    default:
      return undefined
  }
}

export function classifyIdleTranscript(
  records: unknown[],
  permissionMode: unknown,
): IdleClassification | undefined {
  return idleClassificationFromState(
    classifyClaudeTranscriptDeterministically(records, permissionMode),
  )
}

export function classifyClaudeTranscriptState(
  records: unknown[],
  permissionMode: unknown,
): DeterministicAgentState {
  return classifyClaudeTranscriptDeterministically(records, permissionMode)
}

export type { ClaudeTranscriptFeatures }

/**
 * Translate a Stop hook into the right lifecycle event(s).
 *
 * Normally Stop ends the turn → `turn_completed` (with an idle verdict when the
 * transcript classifies). But when the agent scheduled its OWN resume this turn
 * (a /loop `ScheduleWakeup` or a `CronCreate`), it will wake itself — it is NOT
 * awaiting the user — so we keep it `working` (emit `activity`) rather than drop
 * it into NEEDS YOUR ATTENTION as a finished turn. This is the one self-resume
 * signal we can read with certainty; a backgrounded shell is ambiguous (a server
 * left running vs. a command that will wake the loop) and stays idle.
 */
async function stopEvents(p: Record<string, unknown>): Promise<AgentStateEvent[]> {
  const planVerdict: IdleClassification | undefined =
    p.permission_mode === 'plan'
      ? { kind: 'approval', summary: 'plan awaiting approval' }
      : undefined
  const transcriptPath = typeof p.transcript_path === 'string' ? p.transcript_path : undefined
  if (!transcriptPath) {
    return [{ kind: 'turn_completed', ...(planVerdict ? { verdict: planVerdict } : {}) }]
  }
  let records: unknown[]
  try {
    records = await readTranscriptTail(transcriptPath)
  } catch {
    // unreadable transcript (rotated, perms) — Stop still means idle, just unclassified
    return [{ kind: 'turn_completed', ...(planVerdict ? { verdict: planVerdict } : {}) }]
  }
  if (extractClaudeTranscriptFeatures(records, p.permission_mode).scheduledSelfWake) {
    return [{ kind: 'activity' }]
  }
  const verdict = classifyIdleTranscript(records, p.permission_mode) ?? planVerdict
  return [{ kind: 'turn_completed', ...(verdict ? { verdict } : {}) }]
}

// agentStateProviderFor moved to the harness adapter registry (harness/registry.ts,
// #158) — each adapter carries its own state provider.
