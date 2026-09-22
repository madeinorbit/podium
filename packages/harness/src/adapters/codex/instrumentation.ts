/**
 * THE CODEX HOOK INSTRUMENTATION (POD-4472): the one authoritative
 * hook-install + payload-codec definition for this harness (spec §4).
 *
 * The install layout (global `hooks.json` upsert + trust detection, per-session
 * socket/URL env wiring) and the payload codec (snake_case field readers plus
 * the moved translate) live here — re-homed unchanged from the daemon's
 * `codex-hooks.ts` and the codex state provider (now `./state-provider.js`,
 * POD-4520). The terminal family's install +
 * ingest mechanism (`driver/families/terminal/instrumentation.ts`) receives
 * this section as a narrow typed SUBSET of the adapter, never the whole
 * Adapter — the same reader-takes-grammar shape as the transcript Store
 * (POD-4471).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from '@podium/logger'
import {
  type HarnessInstrumentation,
  type InstalledInstrumentation,
  type InstrumentationDestination,
} from '../../manifest.js'
import { withStateChannel } from '../../agent-state/types.js'
import type { AgentStateEvent, ProviderAgentStateEvent } from '../../agent-state/types.js'
import { withEventTime } from '../../observer.js'
import { AGENT_VERSION_PROBE_TIMEOUT_MS } from '../../version-probe.js'
import { classifyCodexVerdict } from './state.js'

const log = createLogger('harness:codex-instrumentation')

/** Legacy rolling-upgrade callback used when no stable socket was injected. */
export const PODIUM_CODEX_HOOK_URL_ENV = 'PODIUM_CODEX_HOOK_URL'
/** Stable, instance-scoped Unix socket used by new Codex hook commands. */
export const PODIUM_CODEX_HOOK_SOCKET_ENV = 'PODIUM_CODEX_HOOK_SOCKET'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function strField(v: unknown, k: string): string | undefined {
  if (!isRecord(v)) return undefined
  const f = v[k]
  return typeof f === 'string' && f.length > 0 ? f : undefined
}

/**
 * Install Podium's Codex native-hook instrumentation (Orca-style).
 *
 * Codex ≥0.142 fires Claude-style shell-command hooks (`hooks` feature, stable):
 * `<CODEX_HOME>/hooks.json` declares per-event handlers that receive a JSON
 * payload on stdin carrying session_id + transcript_path + event fields. Podium
 * installs the definition but deliberately leaves review/trust to Codex's public
 * `/hooks` flow. It never writes Codex's private trust-state representation.
 * The process-owned rollout fallback supplies the same exact binding observation.
 *
 * The handler is env-gated fail-open: sessions spawned by Podium carry an
 * instance-scoped socket in their env, which child hook
 * processes inherit. Any Codex run without Podium's env consumes stdin and exits
 * 0, so the global install does not affect non-Podium sessions.
 */

// Single-line POSIX handler. It posts over the stable Unix socket; the daemon
// durably records exact identity in SessionBinding before acknowledging HTTP.
// URL is a one-release fallback for processes running an older hook command.
// Read stdin before every env gate so Codex never sees EPIPE; every I/O failure
// remains fail-open and curl is bounded to two seconds.
export const PODIUM_CODEX_HOOK_COMMAND = `bash -c 'p=$(cat); sid="$PODIUM_SESSION_ID"; s="$${PODIUM_CODEX_HOOK_SOCKET_ENV}"; u="$${PODIUM_CODEX_HOOK_URL_ENV}"; if [ -n "$s" ] && [ -n "$sid" ]; then printf %s "$p" | curl -fsS -m 2 --unix-socket "$s" -X POST -H "content-type: application/json" --data-binary @- "http://localhost/hooks/$sid" >/dev/null 2>&1 || true; elif [ -n "$u" ]; then printf %s "$p" | curl -fsS -m 2 -X POST -H "content-type: application/json" --data-binary @- "$u" >/dev/null 2>&1 || true; fi'`

const PODIUM_CODEX_HOOK_TIMEOUT_SEC = 5
const execFileAsync = promisify(execFile)

/**
 * The first Codex whose public hooks.json contract Podium exercised. A FLOOR
 * ONLY: a newer Codex has already been installed by the user, so refusing it
 * leaves them nothing to do, and the hooks.json format has stayed additive
 * across every minor since. Newer versions install and run; a break would
 * surface as missing observations, never as a refused session (POD-4083).
 */
const MINIMUM_CODEX_HOOKS_MINOR = 142

export interface CodexVersion {
  raw: string
  major: number
  minor: number
  patch: number
}

export interface CodexHookDiagnostic {
  code: 'codex-version-unsupported' | 'codex-hooks-untrusted'
  title: 'Codex hooks need review'
  body: string
  observedVersion: string
}

export type CodexVersionProbe = () => Promise<string>

export function parseCodexVersion(output: string): CodexVersion | null {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(output.trim())
  if (!match) return null
  return {
    raw: output.trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function supportsCodexHooks(version: CodexVersion): boolean {
  if (version.major !== 0) return version.major > 0
  return version.minor >= MINIMUM_CODEX_HOOKS_MINOR
}

export async function detectCodexVersion(report?: (output: string) => void): Promise<string> {
  const { stdout, stderr } = await execFileAsync('codex', ['--version'], {
    timeout: AGENT_VERSION_PROBE_TIMEOUT_MS,
  })
  const output = `${stdout}${stderr}`.trim()
  report?.(output)
  return output
}

const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
] as const

interface HookHandler {
  type?: string
  command?: string
  timeout?: number
  async?: boolean
  [k: string]: unknown
}
interface HookGroup {
  matcher?: string
  hooks?: HookHandler[]
  [k: string]: unknown
}

function isPodiumHandler(h: HookHandler | undefined): boolean {
  return typeof h?.command === 'string' && h.command.includes(PODIUM_CODEX_HOOK_URL_ENV)
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.podium-tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

/**
 * Upsert the Podium handler into hooks.json (parsed structure), preserving all
 * foreign groups/handlers.
 */
function upsertHooksJson(doc: Record<string, unknown>): {
  doc: Record<string, unknown>
  changed: boolean
} {
  const hooks = (isRecord(doc.hooks) ? doc.hooks : {}) as Record<string, unknown>
  let changed = !isRecord(doc.hooks)
  for (const event of CODEX_HOOK_EVENTS) {
    const groups: HookGroup[] = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : []
    let found = false
    groups.forEach((group) => {
      const groupHooks = group.hooks
      groupHooks?.forEach((handler, i) => {
        if (found || !isPodiumHandler(handler)) return
        found = true
        // Refresh a stale podium handler in place (old command/timeout).
        if (
          handler.command !== PODIUM_CODEX_HOOK_COMMAND ||
          handler.timeout !== PODIUM_CODEX_HOOK_TIMEOUT_SEC ||
          handler.type !== 'command'
        ) {
          groupHooks[i] = {
            type: 'command',
            command: PODIUM_CODEX_HOOK_COMMAND,
            timeout: PODIUM_CODEX_HOOK_TIMEOUT_SEC,
          }
          changed = true
        }
      })
    })
    if (!found) {
      groups.push({
        hooks: [
          {
            type: 'command',
            command: PODIUM_CODEX_HOOK_COMMAND,
            timeout: PODIUM_CODEX_HOOK_TIMEOUT_SEC,
          },
        ],
      })
      changed = true
    }
    hooks[event] = groups
  }
  return { doc: { ...doc, hooks }, changed }
}

/**
 * DECISION RECORD (POD-4076): Podium detects Codex hook trust but never grants
 * it. Two alternatives were rejected:
 *
 * - Writing `[hooks.state]` trust entries ourselves would mark our own hooks
 *   trusted on the user's machine, defeating a security control the user owns.
 *   The existing design note ("never writes Codex's private trust-state
 *   representation") stands.
 * - Passing `--dangerously-bypass-hook-trust` at launch is global to the
 *   invocation: it would also run any USER or PROJECT hook configured in that
 *   CODEX_HOME without their trust review. Podium vets only the handlers it
 *   wrote, so a global bypass over-trusts.
 *
 * What remains is detect-and-tell: read the trust state to DIAGNOSE (reading
 * is not writing), and raise an operator diagnostic naming Codex's public
 * `/hooks` flow as the remedy. Until trust exists Codex silently runs none of
 * the handlers, so sessions are poll-only and PermissionRequest — which only
 * the hook channel carries — is gone entirely.
 */

const CODEX_EVENT_SNAKE: Record<(typeof CODEX_HOOK_EVENTS)[number], string> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  Stop: 'stop',
}

export interface PodiumHookPosition {
  event: string
  snake: string
  group: number
  handler: number
}

/** Locate every Podium handler in a parsed hooks.json doc. */
export function podiumHookPositions(doc: Record<string, unknown>): PodiumHookPosition[] {
  const hooks = (isRecord(doc.hooks) ? doc.hooks : {}) as Record<string, unknown>
  const positions: PodiumHookPosition[] = []
  for (const event of CODEX_HOOK_EVENTS) {
    const groups: HookGroup[] = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : []
    groups.forEach((group, groupIndex) => {
      const handlers = group?.hooks
      if (!Array.isArray(handlers)) return
      handlers.forEach((handler, handlerIndex) => {
        if (!isPodiumHandler(handler as HookHandler)) return
        // First Podium handler per event is the one Podium maintains; foreign
        // duplicates of the marker are not ours to trust-check. upsert keeps a
        // single Podium handler per event, so any second match is foreign.
        if (positions.some((p) => p.event === event)) return
        positions.push({
          event,
          snake: CODEX_EVENT_SNAKE[event],
          group: groupIndex,
          handler: handlerIndex,
        })
      })
    })
  }
  return positions
}

export interface CodexHookTrustEntry {
  trustedHash?: string
  enabled?: boolean
}

/**
 * Parse Codex's `[hooks.state."<path>:<event>:<i>:<j>"]` trust table without a
 * TOML dependency: scan section headers and pick `trusted_hash` / `enabled`
 * out of each section body. Anything unparseable yields no entry, which reads
 * as untrusted (fail-loud) rather than trusted.
 */
export function parseCodexHookTrustState(configText: string): Map<string, CodexHookTrustEntry> {
  const entries = new Map<string, CodexHookTrustEntry>()
  const headerPattern = /^\s*\[hooks\.state\."([^"]+)"\s*\]\s*$/gim
  const headers: Array<{ key: string; start: number; bodyStart: number }> = []
  let match: RegExpExecArray | null
  while ((match = headerPattern.exec(configText)) !== null) {
    headers.push({
      key: match[1] ?? '',
      start: match.index,
      bodyStart: match.index + match[0].length,
    })
  }
  headers.forEach((header, index) => {
    const bodyEnd = index + 1 < headers.length ? (headers[index + 1]?.start ?? configText.length) : configText.length
    const body = configText.slice(header.bodyStart, bodyEnd)
    const hashMatch = /^\s*trusted_hash\s*=\s*"([^"]*)"/im.exec(body)
    const enabledMatch = /^\s*enabled\s*=\s*(true|false)/im.exec(body)
    entries.set(header.key, {
      ...(hashMatch?.[1] ? { trustedHash: hashMatch[1] } : {}),
      ...(enabledMatch?.[1] ? { enabled: enabledMatch[1] === 'true' } : {}),
    })
  })
  return entries
}

/**
 * Check whether Codex will actually run the Podium handlers in `doc`.
 *
 * A handler counts as trusted when its trust entry carries a non-empty
 * `trusted_hash` and is not explicitly `enabled = false`. A missing `enabled`
 * line still counts as trusted: entries written before Codex added the field
 * carry only the hash (observed on live hosts), and Codex runs those hooks.
 */
export function checkPodiumHookTrust(input: {
  hooksJsonPath: string
  doc: Record<string, unknown>
  configText: string | undefined
}): { trusted: boolean; untrusted: string[] } {
  const positions = podiumHookPositions(input.doc)
  if (positions.length === 0) return { trusted: true, untrusted: [] }
  const entries = input.configText ? parseCodexHookTrustState(input.configText) : new Map()
  const untrusted: string[] = []
  for (const position of positions) {
    const key = `${input.hooksJsonPath}:${position.snake}:${position.group}:${position.handler}`
    const entry = entries.get(key)
    if (!entry?.trustedHash || entry.enabled === false) untrusted.push(position.event)
  }
  return { trusted: untrusted.length === 0, untrusted }
}

/**
 * Ensure Podium's codex hook definitions are installed. Safe to call on every
 * daemon boot: no-op (no writes) when everything is already in place; never
 * removes or reorders another tool's hooks. Skips silently when
 * `<home>/.codex` doesn't exist (codex not installed / not used).
 */
export async function ensurePodiumCodexHooks(opts?: {
  homeDir?: string
  codexHome?: string
  versionProbe?: CodexVersionProbe
  onDegraded?: (diagnostic: CodexHookDiagnostic) => void
  /** Host telemetry plumbing for the default version probe (best-effort). */
  reportVersionProbe?: (output: string) => void
}): Promise<{
  installed: boolean
  changed: boolean
  degraded?: boolean
  reason?: string
  trusted?: boolean
  untrustedEvents?: string[]
}> {
  const codexHome = opts?.codexHome ?? join(opts?.homeDir ?? homedir(), '.codex')
  if (!existsSync(codexHome)) return { installed: false, changed: false, reason: 'no ~/.codex' }
  const hooksJsonPath = join(codexHome, 'hooks.json')

  let observedVersion: string
  try {
    observedVersion = await (opts?.versionProbe ??
      (() => detectCodexVersion(opts?.reportVersionProbe)))()
  } catch (error) {
    observedVersion = `unavailable (${error instanceof Error ? error.message : String(error)})`
  }
  const parsedVersion = parseCodexVersion(observedVersion)
  if (!parsedVersion || !supportsCodexHooks(parsedVersion)) {
    const diagnostic: CodexHookDiagnostic = {
      code: 'codex-version-unsupported',
      title: 'Codex hooks need review',
      observedVersion,
      body: `Podium does not recognize Codex version '${observedVersion}'. Codex hook automation is disabled; hooks.json and config.toml were left untouched.`,
    }
    // The local banner covers an operator watching the daemon journal. The
    // callback crosses the authenticated machine transport so the server can
    // issue-mail only this machine's owner and admins, never every client.
    log.error(diagnostic.title, {
      code: diagnostic.code,
      observedVersion,
      detail: diagnostic.body,
    })
    opts?.onDegraded?.(diagnostic)
    return {
      installed: false,
      changed: false,
      degraded: true,
      reason: `unsupported codex version: ${observedVersion}`,
    }
  }

  let doc: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(hooksJsonPath, 'utf8'))
    if (isRecord(parsed)) doc = parsed
    else return { installed: false, changed: false, reason: 'hooks.json not an object' }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Unreadable/corrupt hooks.json: leave the user's file alone.
      return { installed: false, changed: false, reason: 'unreadable hooks.json' }
    }
  }
  const upserted = upsertHooksJson(doc)
  if (upserted.changed) {
    await mkdir(codexHome, { recursive: true })
    await writeAtomic(hooksJsonPath, `${JSON.stringify(upserted.doc, null, 2)}\n`)
  }

  // Trust is a separate question from installation: the file above can be
  // in place while Codex silently runs none of it. Read (never write)
  // config.toml's [hooks.state] table and say so when our handlers lack it.
  let configText: string | undefined
  try {
    configText = await readFile(join(codexHome, 'config.toml'), 'utf8')
  } catch {
    configText = undefined
  }
  const trust = checkPodiumHookTrust({
    hooksJsonPath,
    doc: upserted.doc,
    configText,
  })
  if (!trust.trusted) {
    const missing = trust.untrusted.join(', ')
    const diagnostic: CodexHookDiagnostic = {
      code: 'codex-hooks-untrusted',
      title: 'Codex hooks need review',
      observedVersion,
      body: `Podium installed Codex hook handlers in '${hooksJsonPath}' but Codex has not trusted them (missing trust for: ${missing}). Approve them in Codex's own /hooks flow; Podium never marks hooks trusted on your behalf. Until then Codex runs none of Podium's hooks and says nothing about it: sessions fall back to poll-only state and PermissionRequest observations are missing.`,
    }
    log.error(diagnostic.title, {
      code: diagnostic.code,
      observedVersion,
      detail: diagnostic.body,
    })
    opts?.onDegraded?.(diagnostic)
    return {
      installed: true,
      changed: upserted.changed,
      degraded: true,
      // USER-FACING, and deliberately so: the terminal family's degradation
      // report quotes this reason verbatim, so the installed-but-dead wording
      // (the /hooks remedy, the poll-only consequence) lives HERE, in the one
      // adapter that knows Codex's review flow — never in the mechanism.
      reason: `Codex hooks are installed but Codex has not trusted them (missing trust for: ${missing}); approve them in Codex's /hooks flow. Sessions run poll-only until then.`,
      trusted: false,
      untrustedEvents: trust.untrusted,
    }
  }

  return { installed: true, changed: upserted.changed, trusted: true, untrustedEvents: [] }
}

type CodexApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent'

function approvalsReviewerField(value: unknown, key: string): CodexApprovalsReviewer | undefined {
  const reviewer = strField(value, key)
  return reviewer === 'user' || reviewer === 'auto_review' || reviewer === 'guardian_subagent'
    ? reviewer
    : undefined
}

function codexToolName(payload: Record<string, unknown>): string | undefined {
  return strField(payload, 'tool_name') ?? strField(payload, 'name')
}

export function isCodexQuestionTool(payload: Record<string, unknown>): boolean {
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

export function codexQuestionSummary(payload: Record<string, unknown>): string | undefined {
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

// PermissionRequest hooks do not say whether the request is routed to the user
// or Codex's automatic reviewer. The effective reviewer lives in the rollout.
// Bound the one-off prefix + tail reads so a long-running session never gets
// slurped just to classify an approval.
const SESSION_CONTEXT_BYTES = 1024 * 1024

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
    case 'SessionEnd':
      return [{ kind: 'session_ended' }]
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
// ---------------------------------------------------------------------------
// Payload codec: snake_case shape readers + decode (POD-4472).
// ---------------------------------------------------------------------------

async function decodeCodexHookPayload(payload: unknown): Promise<ProviderAgentStateEvent[]> {
  return withStateChannel(
    await translateCodexEvent(payload),
    typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).hook_event_name === 'string'
      ? 'hook'
      : 'poll',
  )
}

// ---------------------------------------------------------------------------
// Install: global hooks.json layout + per-session env wiring (POD-4472).
// ---------------------------------------------------------------------------

async function installCodexInstrumentation(
  destination: InstrumentationDestination,
): Promise<InstalledInstrumentation> {
  const codexHome =
    destination.harnessHome ??
    join(destination.homeDir ?? homedir(), '.codex')
  const wiring = {
    args: destination.seedTheme ? ['-c', 'tui.theme=ansi'] : [],
    env: {
      [PODIUM_CODEX_HOOK_URL_ENV]: destination.endpointUrl,
      ...(destination.socketPath ? { [PODIUM_CODEX_HOOK_SOCKET_ENV]: destination.socketPath } : {}),
    },
  }
  // A throwing global install degrades like a refused one: the per-session
  // wiring above is still returned, so the session starts poll-only with the
  // reason reported instead of being refused.
  try {
    const result = await ensurePodiumCodexHooks({
      codexHome,
      ...(destination.reportVersionProbe
        ? { reportVersionProbe: (output) => destination.reportVersionProbe?.('codex', output) }
        : {}),
    })
    const degradedReason = !result.installed
      ? (result.reason ?? 'hook installation failed')
      : 'trusted' in result && result.trusted === false
        ? (result.reason ?? 'untrusted codex hooks')
        : undefined
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
  if (
    reason === 'untrusted' ||
    reason?.startsWith('untrusted codex hooks') ||
    reason?.includes('has not trusted them') ||
    reason?.includes('hook trust')
  )
    return 'untrusted'
  switch (reason) {
    case 'no ~/.codex':
      return 'no-home'
    case 'unreadable hooks.json':
      return 'unreadable-hooks-json'
    case 'hooks.json not an object':
      return 'not-an-object'
    default:
      return reason === 'unsupported codex version' ||
        reason?.startsWith('unsupported codex version:')
        ? 'unsupported-version'
        : 'error'
  }
}

// ---------------------------------------------------------------------------
// Section: the ONE authoritative instrumentation definition (spec §4).
// ---------------------------------------------------------------------------

/**
 * The Codex home the install serializes by (POD-4531).
 *
 * The same rule the terminal family applied when it owned the
 * `global-env` branch: instance-owned homes override session values, an
 * ambient `CODEX_HOME` redirects otherwise, and the fallback is
 * `<home>/.codex`. Owned here so the mechanism never reads the environment
 * section — it only looks the `home` strategy up by scope.
 */
function codexHomeOf(destination: InstrumentationDestination): string {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...(destination.env ?? {}),
    ...(destination.homeDir ? { CODEX_HOME: join(destination.homeDir, '.codex') } : {}),
  }
  const homeDir = destination.homeDir ?? env.HOME ?? homedir()
  return env.CODEX_HOME?.trim() || join(homeDir, '.codex')
}

export const codexInstrumentation: HarnessInstrumentation = {
  scope: { kind: 'home', homeOf: codexHomeOf },
  install: installCodexInstrumentation,
  payloadCodec: {
    eventName: (raw) => strField(raw, 'hook_event_name'),
    sessionId: (raw) => strField(raw, 'session_id'),
    transcriptPath: (raw) => strField(raw, 'transcript_path'),
    decode: decodeCodexHookPayload,
  },
  hookTransport: 'loopback-http',
}
