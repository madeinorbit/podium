/**
 * THE GROK HOOK INSTRUMENTATION (POD-4472): the one authoritative hook-install
 * + payload-codec definition for this harness (spec §4).
 *
 * The install layout (global personal-hooks file upsert, per-session callback
 * env wiring) and the payload codec (camelCase field readers plus the moved
 * translate) live here — re-homed unchanged from the daemon's `grok-hooks.ts`
 * and `agent-state/grok.ts`. The terminal family's install + ingest mechanism
 * (`driver/families/terminal/instrumentation.ts`) receives this section as a
 * narrow typed SUBSET of the adapter, never the whole Adapter — the same
 * reader-takes-grammar shape as the transcript Store (POD-4471).
 */
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type HarnessInstrumentation,
  type InstalledInstrumentation,
  type InstrumentationDestination,
} from '../../manifest.js'
import { withStateChannel } from '../../agent-state/types.js'
import type { AgentStateEvent, ProviderAgentStateEvent } from '../../agent-state/types.js'
import { withEventTime } from '../../observer.js'
import {
  type GrokPlanState,
  classifyGrokIdleTranscript,
  withGrokOpenTodos,
} from './state.js'

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

function normalizeName(value: string | undefined): string | undefined {
  return value
    ?.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}


/**
 * Grok Build reads personal hooks from GROK_HOME/hooks without project trust.
 * Podium installs one env-gated command hook per lifecycle event: Podium-spawned
 * sessions inherit their own callback URL; every other Grok process exits 0
 * before touching the network. The command streams the daemon response back to
 * Grok so PreToolUse decisions remain usable; passive event responses are ignored.
 * Keep the command free of dollar-prefixed names: Grok pre-expands every such
 * token as a required environment variable before it invokes the shell.
 */
export const PODIUM_GROK_HOOK_COMMAND =
  'bash -c \'printenv PODIUM_GROK_HOOK_URL >/dev/null 2>&1 || exit 0; curl -fsS -m 2 -X POST -H "content-type: application/json" --data-binary @- "`printenv PODIUM_GROK_HOOK_URL`" 2>/dev/null || true\''

const PODIUM_GROK_HOOK_TIMEOUT_SEC = 5
const GROK_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
] as const

interface HookHandler {
  type?: string
  command?: string
  timeout?: number
  [key: string]: unknown
}

interface HookGroup {
  matcher?: string
  hooks?: HookHandler[]
  [key: string]: unknown
}

function isPodiumHandler(handler: HookHandler | undefined): boolean {
  return typeof handler?.command === 'string' && handler.command.includes(PODIUM_GROK_HOOK_URL_ENV)
}

function upsertHooks(doc: Record<string, unknown>): {
  doc: Record<string, unknown>
  changed: boolean
} {
  const hooks = (isRecord(doc.hooks) ? doc.hooks : {}) as Record<string, unknown>
  let changed = !isRecord(doc.hooks)

  for (const event of GROK_HOOK_EVENTS) {
    const groups: HookGroup[] = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : []
    let found = false
    for (const group of groups) {
      const handlers = group.hooks ?? []
      for (let index = 0; index < handlers.length; index++) {
        const handler = handlers[index]
        if (found || !isPodiumHandler(handler)) continue
        found = true
        if (
          handler?.type !== 'command' ||
          handler.command !== PODIUM_GROK_HOOK_COMMAND ||
          handler.timeout !== PODIUM_GROK_HOOK_TIMEOUT_SEC
        ) {
          handlers[index] = {
            type: 'command',
            command: PODIUM_GROK_HOOK_COMMAND,
            timeout: PODIUM_GROK_HOOK_TIMEOUT_SEC,
          }
          changed = true
        }
      }
    }
    if (!found) {
      groups.push({
        hooks: [
          {
            type: 'command',
            command: PODIUM_GROK_HOOK_COMMAND,
            timeout: PODIUM_GROK_HOOK_TIMEOUT_SEC,
          },
        ],
      })
      changed = true
    }
    hooks[event] = groups
  }

  return { doc: { ...doc, hooks }, changed }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.podium-tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

/**
 * Install or refresh Podium's dedicated personal Grok hook file. Foreign groups
 * in that file are preserved, corrupt content is never overwritten, and a host
 * without a Grok home is a clean no-op.
 */
export async function ensurePodiumGrokHooks(opts?: {
  homeDir?: string
  grokHome?: string
}): Promise<{ installed: boolean; changed: boolean; reason?: string }> {
  const grokHome =
    opts?.grokHome ??
    (opts?.homeDir
      ? join(opts.homeDir, '.grok')
      : process.env.GROK_HOME?.trim() || join(homedir(), '.grok'))
  if (!existsSync(grokHome)) return { installed: false, changed: false, reason: 'no GROK_HOME' }

  const hooksDir = join(grokHome, 'hooks')
  const hooksPath = join(hooksDir, 'podium.json')
  let doc: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(hooksPath, 'utf8'))
    if (!isRecord(parsed)) {
      return { installed: false, changed: false, reason: 'podium hook file is not an object' }
    }
    doc = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { installed: false, changed: false, reason: 'unreadable podium hook file' }
    }
  }

  const upserted = upsertHooks(doc)
  if (upserted.changed) {
    await mkdir(hooksDir, { recursive: true })
    await writeAtomic(hooksPath, `${JSON.stringify(upserted.doc, null, 2)}\n`)
  }
  return { installed: true, changed: upserted.changed }
}
const TAIL_BYTES = 128 * 1024

export const PODIUM_GROK_HOOK_URL_ENV = 'PODIUM_GROK_HOOK_URL'

export interface GrokSessionPaths {
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  sessionId: string
  sessionDir: string
  summaryPath: string
  updatesPath: string
  chatHistoryPath: string
}

export function grokSessionPaths(opts: {
  cwd: string
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
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

interface GrokTranslationOptions {
  classifyIdleVerdict?: boolean
  onVerdictRead?: () => void
  planState?: GrokPlanState
}

export async function translateGrokUpdatePayload(
  payload: unknown,
  options: GrokTranslationOptions = {},
): Promise<AgentStateEvent[]> {
  if (!isRecord(payload)) return []
  const directEvent = grokHookEventName(payload)
  if (directEvent) return grokLifecycleEvents(directEvent, payload, payload, options)

  const method = stringField(payload, 'method')
  if (
    method !== 'session/update' &&
    method !== '_x.ai/session/update' &&
    method !== '_x.ai/session_notification'
  )
    return []
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
      const stopReason = normalizeName(stringField(update, 'stop_reason'))
      if (stopReason === 'error') {
        return withEventTime([classifyGrokProviderFailure(update)], at)
      }
      // Grok's authoritative end-of-turn signal (stop_reason: end_turn). It lands
      // AFTER the Stop hook and the final agent_message_chunk, so it is the record
      // that must settle the phase — without it that trailing chunk (→ activity →
      // 'working') leaves the session stuck 'working' once the turn ends. This is
      // the provider owning its run-state verdict; the reducer only transports it.
      // [spec:SP-8b0e]
      const classified =
        options.classifyIdleVerdict === false
          ? undefined
          : await classifyStopPayload(payload, options.onVerdictRead)
      const verdict = withGrokOpenTodos(classified, options.planState, stopReason === 'end_turn')
      return withEventTime([{ kind: 'turn_completed', ...(verdict ? { verdict } : {}) }], at)
    }
    case 'retry_state': {
      const retryState = normalizeName(stringField(update, 'type'))
      if (retryState === 'retrying') return withEventTime([{ kind: 'activity' }], at)
      if (retryState === 'failed' || retryState === 'exhausted') {
        return withEventTime([classifyGrokProviderFailure(update)], at)
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
      return withEventTime(await grokHookEvents(update, payload, options), at)
    default:
      return []
  }
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

async function grokHookEvents(
  update: Record<string, unknown>,
  payload: Record<string, unknown>,
  options: GrokTranslationOptions,
): Promise<AgentStateEvent[]> {
  const event = normalizeName(
    stringField(update, 'event_name') ?? stringField(update, 'hook_event_name'),
  )
  return event ? grokLifecycleEvents(event, update, payload, options) : []
}

export function grokHookEventName(payload: Record<string, unknown>): string | undefined {
  return normalizeName(
    stringField(payload, 'hookEventName') ?? stringField(payload, 'hook_event_name'),
  )
}

async function grokLifecycleEvents(
  event: string,
  fields: Record<string, unknown>,
  payload: Record<string, unknown>,
  options: GrokTranslationOptions,
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
      const verdict =
        options.classifyIdleVerdict === false
          ? undefined
          : await classifyStopPayload(payload, options.onVerdictRead)
      return [{ kind: 'turn_completed', ...(verdict ? { verdict } : {}) }]
    }
    case 'stop_failure': {
      const failure = classifyGrokProviderFailure(fields)
      // Grok emits this hook as a lifecycle marker even when it carries no
      // provider error. The live marker is `{ errorClass: 'unknown', detail:
      // 'unknown' }` if classified; emitting that synthetic failure after the
      // real retry_state/turn_completed records would clobber the 402 reason.
      return failure.errorClass === 'unknown' && failure.detail === 'unknown' ? [] : [failure]
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

export async function classifyStopPayload(
  payload: Record<string, unknown>,
  onVerdictRead?: () => void,
): Promise<{ kind: 'done' | 'question' | 'approval'; summary?: string } | undefined> {
  const path =
    stringField(payload, 'chat_history_path') ??
    stringField(payload, 'chatHistoryPath') ??
    grokHookChatHistoryPath(payload)
  if (!path) return undefined
  onVerdictRead?.()
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

export async function readGrokChatHistoryTail(path: string): Promise<unknown[]> {
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

export function grokRoot(homeDir: string | undefined): string {
  if (homeDir) return join(homeDir, '.grok')
  return process.env.GROK_HOME || join(homedir(), '.grok')
}

/** Grok reports provider failures in retry_state and in the authoritative
 * turn_completed record. Keep the provider-specific vocabulary here and emit
 * only the normalized failure event to shared layers. [spec:SP-8b0e] */
export function classifyGrokProviderFailure(
  fields: Record<string, unknown>,
): Extract<AgentStateEvent, { kind: 'turn_failed' }> {
  const message =
    stringField(fields, 'agent_result') ??
    stringField(fields, 'message') ??
    stringField(fields, 'reason') ??
    ''
  const errorType =
    stringField(fields, 'error_type') ?? stringField(fields, 'errorType') ?? 'unknown'
  const providerDetail = String(message || errorType)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000)
  const detail = providerDetail.toLowerCase()

  if (/\b(?:usage (?:balance )?(?:exhausted|limit)|quota (?:exhausted|limit))\b/.test(detail)) {
    return {
      kind: 'turn_failed',
      errorClass: 'usage_limit',
      retryable: false,
      detail: providerDetail,
    }
  }
  if (fields.is_rate_limited === true || /\b(?:status )?429\b|too many requests/.test(detail)) {
    return {
      kind: 'turn_failed',
      errorClass: 'rate_limit',
      retryable: true,
      detail: providerDetail,
    }
  }
  if (/\b(?:overloaded|temporarily at capacity)\b/.test(detail)) {
    return {
      kind: 'turn_failed',
      errorClass: 'overloaded',
      retryable: true,
      detail: providerDetail,
    }
  }
  if (/\b(?:status )?5\d\d\b|server error/.test(detail)) {
    return {
      kind: 'turn_failed',
      errorClass: 'server_error',
      retryable: true,
      detail: providerDetail,
    }
  }
  if (/\b(?:status )?(?:401|403)\b|unauthori[sz]ed|authentication/.test(detail)) {
    return {
      kind: 'turn_failed',
      errorClass: 'authentication',
      retryable: false,
      detail: providerDetail,
    }
  }
  if (/\b(?:status )?402\b|payment required|billing|insufficient credits/.test(detail)) {
    return {
      kind: 'turn_failed',
      errorClass: 'billing_error',
      retryable: false,
      detail: providerDetail,
    }
  }
  if (/\b(?:network|transport|connection|timeout)\b/.test(detail)) {
    return {
      kind: 'turn_failed',
      errorClass: 'network_error',
      retryable: true,
      detail: providerDetail,
    }
  }

  const errorClass = normalizeName(errorType) ?? 'unknown'
  return {
    kind: 'turn_failed',
    errorClass,
    retryable: errorClass === 'api' || RETRYABLE.has(errorClass),
    detail: providerDetail,
  }
}


const RETRYABLE = new Set([
  'rate_limit',
  'overloaded',
  'server_error',
  'max_output_tokens',
  'unknown',
])
// ---------------------------------------------------------------------------
// Payload codec: camelCase shape readers + decode (POD-4472).
// ---------------------------------------------------------------------------

async function decodeGrokHookPayload(payload: unknown): Promise<ProviderAgentStateEvent[]> {
  return withStateChannel(await translateGrokUpdatePayload(payload), 'poll')
}

// ---------------------------------------------------------------------------
// Install: global personal-hooks layout + per-session env wiring (POD-4472).
// ---------------------------------------------------------------------------

async function installGrokInstrumentation(
  destination: InstrumentationDestination,
): Promise<InstalledInstrumentation> {
  const grokHome =
    destination.harnessHome ??
    (destination.homeDir
      ? join(destination.homeDir, '.grok')
      : process.env.GROK_HOME?.trim() || join(homedir(), '.grok'))
  const wiring = {
    args: [],
    env: { [PODIUM_GROK_HOOK_URL_ENV]: destination.endpointUrl },
  }
  // A throwing global install degrades like a refused one: the per-session
  // wiring above is still returned, so the session starts poll-only with the
  // reason reported instead of being refused.
  try {
    const result = await ensurePodiumGrokHooks({ grokHome })
    const degradedReason = !result.installed ? (result.reason ?? 'hook installation failed') : undefined
    return {
      ...wiring,
      ...(degradedReason
        ? {
            degradedReason,
            degradedKind: installerDegradedKind(result.reason) as InstalledInstrumentation['degradedKind'],
          }
        : {}),
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ...wiring, degradedReason: reason, degradedKind: 'error' }
  }
}

/** Classify installer refusals. Exceptions always use error, regardless of text. */
function installerDegradedKind(
  reason: string | undefined,
): 'no-home' | 'unreadable-hooks-json' | 'not-an-object' | 'unsupported-version' | 'untrusted' | 'error' {
  switch (reason) {
    case 'no GROK_HOME':
      return 'no-home'
    case 'unreadable podium hook file':
      return 'unreadable-hooks-json'
    case 'podium hook file is not an object':
      return 'not-an-object'
    default:
      return 'error'
  }
}

// ---------------------------------------------------------------------------
// Section: the ONE authoritative instrumentation definition (spec §4).
// ---------------------------------------------------------------------------

export const grokInstrumentation: HarnessInstrumentation = {
  install: installGrokInstrumentation,
  payloadCodec: {
    eventName: (raw) => normalizeName(stringField(raw, 'hookEventName') ?? stringField(raw, 'hook_event_name')),
    sessionId: (raw) => stringField(raw, 'sessionId') ?? stringField(raw, 'session_id'),
    transcriptPath: (raw) => stringField(raw, 'transcriptPath') ?? stringField(raw, 'transcript_path'),
    decode: decodeGrokHookPayload,
  },
  hookTransport: 'loopback-http',
}
