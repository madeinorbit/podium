import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lastTimestampedRecordIso } from './boot-time.js'
import {
  type ClaudeTranscriptFeatures,
  classifyClaudeTranscriptDeterministically,
  extractClaudeTranscriptFeatures,
} from './claude-code-classifier.js'
import { locateClaudeSessionFile } from './claude-locate.js'
import { type DeterministicAgentState, deterministicStateToEvents } from './deterministic.js'
import type { AgentObservation, AgentRuntimeState, ObservationInputOrigin } from '@podium/protocol'
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
      const state = classifyClaudeTranscriptDeterministically(
        await readTranscriptTail(transcript),
        'default',
      )
      // Stamp the last DATED record's time, NOT the file mtime: Claude appends
      // timestamp-less metadata (bridge-session/mode/…) on resume/reattach, which
      // bumps the mtime to "now" though no real activity happened. Using mtime here
      // restamped idle sessions to "now" on every redeploy.
      const at = await lastTimestampedRecordIso(transcript)
      // A still-pending AskUserQuestion menu must seed the SAME wire shape as the
      // live hook path (needs_user/question, see translate() and
      // deterministicStateToEvents), not a turn_completed 'question' verdict:
      // the idle/question form made restarted sessions invisible to the
      // superagent's answer_question gate and to NEEDS-ATTENTION grouping.
      if (state.status === 'resolved' && state.label === 'idle.needs_input.ask_user_tool') {
        return deterministicStateToEvents(state).map((e) => (at ? { ...e, at } : e))
      }
      const verdict = idleClassificationFromState(state)
      if (verdict) {
        return [{ kind: 'turn_completed', verdict, ...(at ? { at } : {}) }]
      }
      // No verdict (the transcript is real but doesn't classify deterministically —
      // e.g. autonomous-continuation text). Still seed idle, but carry the real
      // last-activity time so a reattach NEVER restamps recency to "now" and jumps
      // the session to the top of NEEDS YOUR ATTENTION. Only when even that is
      // unknown do we fall through to the bare (now-stamped) boot event.
      if (at) {
        return [{ kind: 'session_started', at }]
      }
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
  bootstrapState: AgentRuntimeState
  bootstrapOffset: number
  now?: () => string
}

/**
 * Claude's provider-owned causal barrier. Hook receipt is not itself a turn:
 * only an exact-binding UserPromptSubmit opens an epoch, and Stop/StopFailure
 * closes it absorbingly except for matching child-stop bookkeeping.
 * [spec:SP-cdb2]
 */
export class ClaudeCausalObserver {
  private readonly segmentId: string
  private predecessorSegmentId: string | null = null
  private readonly now: () => string
  private state: AgentRuntimeState
  private turnEpoch = 0
  private providerPromptId: string | null = null
  private lastOffset: number
  private bootstrapped = false
  private epochOpen = false
  private closing = false
  private currentOrigin: ObservationInputOrigin = 'unknown'
  private readonly pendingOrigins: ObservationInputOrigin[] = []
  private readonly seen = new Set<string>()
  private readonly activeChildren = new Set<string>()

  constructor(private readonly options: ClaudeCausalObserverOptions) {
    this.state = options.bootstrapState
    this.lastOffset = options.bootstrapOffset
    this.now = options.now ?? (() => new Date().toISOString())
    this.segmentId = `claude:${options.providerSessionId}:${options.transcriptPath}`
  }
  /** Rebase after the server's durable ack (including replay rejection, whose
   * acceptedCursor is the already-committed fence) before releasing hooks. */
  acknowledgeCursor(cursor: AgentObservation['providerCursor'] | null | undefined): void {
    if (!cursor) return
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
    return Math.max(
      this.lastOffset + 1,
      Number.isSafeInteger(observedOffset) ? observedOffset : this.lastOffset + 1,
    )
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
      offset: this.options.bootstrapOffset,
      identity: `bootstrap:${this.options.bootstrapOffset}`,
    })
  }

  async observeHook(
    payload: unknown,
    transcriptOffset: number,
    inputOrigin?: ObservationInputOrigin,
  ): Promise<AgentObservation | null> {
    if (typeof payload !== 'object' || payload === null || !this.bootstrapped) return null
    const p = payload as Record<string, unknown>
    if (
      p.session_id !== this.options.providerSessionId ||
      p.transcript_path !== this.options.transcriptPath ||
      !Number.isSafeInteger(transcriptOffset) ||
      transcriptOffset <= this.lastOffset
    ) {
      return null
    }

    const hook = str(p.hook_event_name)
    if (!hook) return null
    const baseIdentity = this.hookIdentity(hook, p)
    const identity = hook === 'UserPromptSubmit' ? baseIdentity : `${this.turnEpoch}:${baseIdentity}`
    if (this.seen.has(identity)) return null
    this.seen.add(identity)
    this.lastOffset = transcriptOffset

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
        components: { transcript: input.offset },
        ...(this.predecessorSegmentId
          ? { predecessorSegmentId: this.predecessorSegmentId }
          : {}),
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
