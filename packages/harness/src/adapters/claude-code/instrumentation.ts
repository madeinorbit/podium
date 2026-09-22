/**
 * THE CLAUDE CODE HOOK INSTRUMENTATION (POD-4472): the one authoritative
 * hook-install + payload-codec definition for this harness (spec §4).
 *
 * The install layout (per-session `--settings` file wiring; Claude has no
 * global hook home) and the payload codec (snake_case field readers plus the
 * moved translate, including the Stop-verdict classification it reads the
 * transcript tail for) live here. The terminal family's install + ingest
 * mechanism (`driver/families/terminal/instrumentation.ts`) receives this
 * section as a narrow typed SUBSET of the adapter, never the whole Adapter —
 * the same reader-takes-grammar shape as the transcript Store (POD-4471).
 */
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AgentInterview,
  AgentInterviewOption,
  AgentInterviewQuestion,
} from '@podium/model'
import type {
  HarnessInstrumentation,
  InstalledInstrumentation,
  InstrumentationDestination,
} from '../../manifest.js'
import type {
  AgentStateEvent,
  ProviderAgentStateEvent,
} from '../../agent-state/types.js'
import { withStateChannel } from '../../agent-state/types.js'
import type { DeterministicAgentState } from '../../agent-state/deterministic.js'
import type { TranscriptClassifier } from '../../observer.js'

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
type ClaudeClassifierFeatures = { scheduledSelfWake: boolean }
type ClaudeTranscriptClassifier = TranscriptClassifier<
  unknown,
  ClaudeClassifierFeatures,
  DeterministicAgentState
>
let claudeTranscriptClassifier: ClaudeTranscriptClassifier | undefined

/** Configured once by the Claude manifest (adapters/claude-code/index.ts). */
export function configureClaudeTranscriptClassifier(classifier: ClaudeTranscriptClassifier): void {
  claudeTranscriptClassifier = classifier
}

/** Shared with the transcript-capture boot path in ./state-provider.ts,
 *  which classifies the same tail through the same configured rules. */
export function claudeHookClassifier(): ClaudeTranscriptClassifier {
  if (!claudeTranscriptClassifier)
    throw new Error('Claude transcript classifier is not configured by its manifest')
  return claudeTranscriptClassifier
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

/** A permission card is one line wide, and a tool input can be a whole file. */
const PERMISSION_DETAIL_MAX = 300

/**
 * The field of a tool's input that says what the tool would DO.
 *
 * Ordered, not merged: `Bash` carries both `command` and `description`, and the
 * command is the thing being consented to. A tool whose input matches nothing
 * here yields no detail rather than a guess — an approval line that describes
 * the wrong field is worse than one that describes none, so the card falls back
 * to the tool name alone.
 */
const PERMISSION_DETAIL_KEYS = [
  'command',
  'file_path',
  'path',
  'url',
  'pattern',
  'query',
  'notebook_path',
  'prompt',
]

/** Collapse the newlines out of a heredoc/multi-line command so one ask stays one line. */
function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > PERMISSION_DETAIL_MAX ? `${flat.slice(0, PERMISSION_DETAIL_MAX - 1)}…` : flat
}

function permissionDetail(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const input = toolInput as Record<string, unknown>
  for (const key of PERMISSION_DETAIL_KEYS) {
    const value = str(input[key])
    if (value) return oneLine(value)
  }
  return undefined
}

/**
 * Did the harness offer an "always allow" alongside this ask?
 *
 * `permission_suggestions` is a list of RULE MUTATIONS (addRules / replaceRules /
 * setMode / addDirectories …), which is what the native menu's "yes, and don't
 * ask again" rows commit. Only their EXISTENCE is reported — see
 * {@link AgentPermissionAsk} for why their key positions are not usable.
 */
function offersAlwaysAllow(suggestions: unknown): boolean {
  return Array.isArray(suggestions) && suggestions.length > 0
}

/** The interview tool. Claude Code routes it through the permission channel too. */
const ASK_USER_QUESTION = 'AskUserQuestion'

/**
 * CAPS ON A CARRIED INTERVIEW.
 *
 * The tool's own contract is a handful of questions with a handful of options
 * each, so these bound a MALFORMED or hostile input, not a real one — the ask a
 * card renders passes through untouched. Prose is capped where reading stops
 * being possible anyway; `preview` gets the largest allowance because it is
 * meant to be a mockup and is the one field the operator compares options BY.
 */
const INTERVIEW_MAX_QUESTIONS = 8
const INTERVIEW_MAX_OPTIONS = 12
const INTERVIEW_TEXT_MAX = 400
const INTERVIEW_PREVIEW_MAX = 4_000

/** Truncate for the wire while preserving what the field MEANS. Newlines survive
 *  (a preview is drawn as a mockup, and `oneLine` would flatten it into prose),
 *  and a non-empty value stays non-empty — `isPreviewLayout` reads presence, and
 *  a truncation that emptied a preview would change which keystrokes answer the
 *  question. */
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function interviewOption(raw: unknown): AgentInterviewOption | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const label = str(o.label)
  if (label === undefined) return undefined
  const description = str(o.description)
  const preview = str(o.preview)
  return {
    label: clip(label, INTERVIEW_TEXT_MAX),
    ...(description ? { description: clip(description, INTERVIEW_TEXT_MAX) } : {}),
    ...(preview ? { preview: clip(preview, INTERVIEW_PREVIEW_MAX) } : {}),
  }
}

/** One question of the ask. Mirrors the client's own parser: an entry without an
 *  options ARRAY is malformed and is dropped rather than half-rendered. */
function interviewQuestion(raw: unknown): AgentInterviewQuestion | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const q = raw as Record<string, unknown>
  const question = str(q.question)
  if (question === undefined || !Array.isArray(q.options)) return undefined
  const options = q.options
    .slice(0, INTERVIEW_MAX_OPTIONS)
    .map(interviewOption)
    .filter((o): o is AgentInterviewOption => o !== undefined)
  const header = str(q.header)
  return {
    question: clip(question, INTERVIEW_TEXT_MAX),
    ...(header ? { header: clip(header, INTERVIEW_TEXT_MAX) } : {}),
    ...(typeof q.multiSelect === 'boolean' ? { multiSelect: q.multiSelect } : {}),
    options,
  }
}

/** The whole ask, bounded — what the chat draws its live card from. */
function interviewOf(toolInput: unknown): AgentInterview | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const { questions } = toolInput as { questions?: unknown }
  if (!Array.isArray(questions)) return undefined
  const parsed = questions
    .slice(0, INTERVIEW_MAX_QUESTIONS)
    .map(interviewQuestion)
    .filter((q): q is AgentInterviewQuestion => q !== undefined)
  return parsed.length > 0 ? { questions: parsed } : undefined
}

/** The first question of an AskUserQuestion call — the subject of the interview.
 *  Read off the RAW input, so a question the strict parse dropped (no `options`
 *  array) still names the wait in the sidebar, as it did before the card had a
 *  payload to draw from. */
function askedQuestion(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const { questions } = toolInput as { questions?: unknown }
  if (!Array.isArray(questions)) return undefined
  const first = questions[0]
  if (typeof first !== 'object' || first === null) return undefined
  return str((first as { question?: unknown }).question)
}

/** An interview is a question whichever channel announced it. The summary is the
 *  first question — the one line the sidebar has room for — and `interview` is
 *  the whole ask, because a PENDING AskUserQuestion never reaches the transcript
 *  the chat's card is otherwise built from (Claude Code writes a tool call down
 *  only once it resolves). */
function interviewEvent(toolInput: unknown): AgentStateEvent[] {
  const interview = interviewOf(toolInput)
  const question = askedQuestion(toolInput)
  return [
    {
      kind: 'needs_user',
      need: 'question',
      ...(question ? { summary: clip(question, INTERVIEW_TEXT_MAX) } : {}),
      ...(interview ? { interview } : {}),
    },
  ]
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
      if (p.tool_name === ASK_USER_QUESTION) return interviewEvent(p.tool_input)
      return [{ kind: 'activity' }]
    }
    case 'PostToolUse':
      return [{ kind: 'activity' }]
    case 'PermissionRequest': {
      // The ONE channel that says what is being asked. `tool_input` and
      // `permission_suggestions` are on the payload (bundle 2.1.226 pins the
      // schema: hook_event_name / tool_name / tool_input /
      // permission_suggestions?) and used to be dropped here, which is why the
      // web chat could only ever render "needs permission" with no subject.
      //
      // An interview is not a consent step. Claude Code gates AskUserQuestion
      // through this SAME channel as Bash or Write — the "permission" being
      // granted IS the answer — so reporting it verbatim told the user a tool
      // wanted approval when the agent was only asking them a question.
      //
      // An interview is not a consent step. Claude Code gates AskUserQuestion
      // through this SAME channel as Bash or Write — the "permission" being
      // granted IS the answer — so reporting it verbatim told the user a tool
      // wanted approval when the agent was only asking them a question.
      if (p.tool_name === ASK_USER_QUESTION) return interviewEvent(p.tool_input)
      const summary = str(p.tool_name)
      const detail = permissionDetail(p.tool_input)
      const ask = summary
        ? {
            toolName: summary,
            ...(detail ? { detail } : {}),
            ...(offersAlwaysAllow(p.permission_suggestions) ? { canAlwaysAllow: true } : {}),
          }
        : undefined
      return [
        {
          kind: 'needs_user',
          need: 'permission',
          ...(summary ? { summary } : {}),
          ...(ask ? { ask } : {}),
        },
      ]
    }
    case 'Notification': {
      // Settings subscribe matcher=permission_prompt only, so anything arriving is one.
      // No `ask`: this channel carries a rendered message, not the tool call, so
      // there is nothing here to build a faithful subject from.
      //
      // `subjectless`: the CLI's dialog host notifies for EVERY modal it opens,
      // and roughly ten of those kinds share the one title "Claude needs your
      // permission" — the message names no tool, no question, nothing. It may
      // open a wait (a plan approval or a paused session announces itself
      // nowhere else) but it may never overwrite a wait already described.
      const summary = str(p.message)
      return [
        {
          kind: 'needs_user',
          need: 'permission',
          subjectless: true,
          ...(summary ? { summary } : {}),
        },
      ]
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
export type IdleClassification = {
  kind: 'done' | 'question' | 'approval' | 'interrupted' | 'open_todos'
  summary?: string
}


const STOP_TAIL_BYTES = 128 * 1024
async function readTranscriptTail(path: string, maxBytes = STOP_TAIL_BYTES): Promise<unknown[]> {
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
/** Shared with the transcript-capture boot path in ./state-provider.ts. */
export function idleClassificationFromState(
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
      // The turn DID end — this verdict only adds that the agent's own task list
      // still had items on it, which the row says quietly and nothing else acts
      // on (idleVerdictFinishedTurn). Reported since POD-415; before that the
      // label arrived and was flattened to a bare 'done', so the kind the wire
      // and four UI surfaces already understood was never produced by anyone.
      return { kind: 'open_todos', summary: state.summary ?? 'open todo list' }
    default:
      return undefined
  }
}
export function classifyIdleTranscript(
  records: unknown[],
  permissionMode: unknown,
): IdleClassification | undefined {
  return idleClassificationFromState(claudeHookClassifier().classify(records, permissionMode))
}

export function classifyClaudeTranscriptState(
  records: unknown[],
  permissionMode: unknown,
): DeterministicAgentState {
  return claudeHookClassifier().classify(records, permissionMode)
}
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
  if (claudeHookClassifier().extract(records, p.permission_mode).scheduledSelfWake) {
    return [{ kind: 'activity' }]
  }
  const verdict = classifyIdleTranscript(records, p.permission_mode) ?? planVerdict
  return [{ kind: 'turn_completed', ...(verdict ? { verdict } : {}) }]
}
// ---------------------------------------------------------------------------
// Payload codec: snake_case shape readers + decode (POD-4472).
// ---------------------------------------------------------------------------

function hookField(raw: unknown, key: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = (raw as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function decodeClaudeHookPayload(payload: unknown): Promise<ProviderAgentStateEvent[]> {
  return withStateChannel(await translateClaudeHookPayload(payload), 'hook')
}

// ---------------------------------------------------------------------------
// Install: per-session settings-file wiring (POD-4472).
//
// Claude's hookInstall is 'settings-args': there is no global home to merge,
// so install is only the `--settings` file + argv. It cannot degrade the way
// a global install can — the host writing the file is the only fallible step
// and the family reports that.
// ---------------------------------------------------------------------------

function installClaudeCodeInstrumentation(
  destination: InstrumentationDestination,
): InstalledInstrumentation {
  const settingsPath = join(destination.settingsDir, `${destination.sessionId}.json`)
  return {
    args: ['--settings', settingsPath],
    file: {
      path: settingsPath,
      contents: claudeHookSettings(destination.endpointUrl, { seedTheme: destination.seedTheme ?? true }),
    },
  }
}

// ---------------------------------------------------------------------------
// Section: the ONE authoritative instrumentation definition (spec §4).
// ---------------------------------------------------------------------------

export const claudeCodeInstrumentation: HarnessInstrumentation = {
  // Per-session `--settings` file wiring; Claude has no shared hook home, so
  // installs never serialize across sessions.
  scope: { kind: 'session' },
  install: (destination) => Promise.resolve(installClaudeCodeInstrumentation(destination)),
  payloadCodec: {
    eventName: (raw) => hookField(raw, 'hook_event_name'),
    sessionId: (raw) => hookField(raw, 'session_id'),
    transcriptPath: (raw) => hookField(raw, 'transcript_path'),
    decode: decodeClaudeHookPayload,
  },
  hookTransport: 'loopback-http',
}
