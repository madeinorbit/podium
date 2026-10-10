import type { TranscriptItem, TranscriptTag } from '@podium/model'
import { fileTranscript, supported, type TranscriptSourceInput } from '../../manifest.js'
import type {
  HarnessRuntimeObservation,
  TranscriptRecordMapper,
  TranscriptTurnEnd,
} from '../../transcript-types.js'
import { SYNTHESIZED_ITEM_ID_PREFIX } from '../../transcript-types.js'
import { toolInputPreview } from '../claude-code/transcript.js'
import { safeToolEditJsonFromInput } from '../shared/tool-edit.js'
import { locateGrokTranscript } from './state-locate.js'

/**
 * Normalize one Grok `updates.jsonl` record into Podium chat transcript items.
 *
 * WHY `updates.jsonl` AND NOT `chat_history.jsonl` (POD-4875). Measured on
 * grok 1.0.44's terminal UI (POD-4865,
 * docs/measurements/pod-4834-receipt-proof/grok-tui-1.0.44/results.md): Grok
 * replaces `chat_history.jsonl` by rename on every cancel and resume, rewrites
 * its earlier lines on new prompts (old tool results become `[Tool result
 * omitted — too old]`) and on compaction (62 → 5 lines), and a compaction
 * re-adds an old prompt as a new-looking user record. A byte position in it
 * means nothing, and entries vanish and reappear. `updates.jsonl` stayed
 * append-only through compaction, cancels, send-now, `kill -9`, SIGTERM and
 * resumes, and its `user_message_chunk` was the one record whose presence
 * decided whether a prompt survived a kill and reached the model.
 *
 * What becomes an item, one record at a time:
 *   - `user_message_chunk` → the prompt entry, the text as typed. Not when
 *     `_meta.hideFromScrollback`: that is Grok waking itself after a background
 *     task, a `<system-reminder>` nobody typed.
 *   - `agent_message_chunk` → the reply. The terminal writes each text segment
 *     whole, as one record (real sessions: never two in a row). Whether it is
 *     the turn's answer or narration before a tool is not in the record: the
 *     next one decides it, so `grokRecordEndsTurn` below names the turn end
 *     and the Store's readers mark the answer (store/turn-end.ts, POD-4936).
 *   - `tool_call` → the call; a `tool_call_update` that ends it → its result.
 *   - everything else — reasoning, hooks, turn ends, background-task and
 *     compaction bookkeeping — is not part of the conversation view. In
 *     particular `turn_completed interrupted`, which a resume writes for a turn
 *     that died, names the dead prompt's id but is not its entry.
 *
 * Times come from `_meta.agentTimestampMs`, Grok's event time in ms (for a
 * prompt: when Grok dispatched it, later than the send when it waited in
 * Grok's queue). The record's own `timestamp` is whole seconds and is not used.
 *
 * Ids are the record's position (the cursor the store stamps), except tool
 * items, which keep Grok's call id. They stay the same however the file is
 * read. Grok's own `promptId` is not on the chunk: it is on the
 * `hook_execution user_prompt_submit` record written just before it, which a
 * windowed read can cut off, so it is not folded into the id.
 */
export const grokRecordToItems: TranscriptRecordMapper = Object.assign(mapGrokRecord, {
  endsTurn: grokRecordEndsTurn,
})

function mapGrokRecord(record: unknown, previousRecord?: unknown): TranscriptItem[] {
  const params = recordField(record, 'params')
  const update = recordField(params, 'update')
  if (!params || !update) return []
  const ts = eventTime(recordField(params, '_meta'))
  switch (stringField(update, 'sessionUpdate')) {
    case 'user_message_chunk': {
      if (recordField(update, '_meta')?.hideFromScrollback === true) return []
      const { text, tags } = contentBlock(update.content)
      // Measured 35/35: the prompt's submit hook_execution is immediately
      // before its chunk. Reader-local context only; a clipped read has no id.
      const preceding = recordField(recordField(previousRecord, 'params'), 'update')
      const promptId = stringField(preceding, 'sessionUpdate') === 'hook_execution' &&
        stringField(preceding, 'event_name') === 'user_prompt_submit'
        ? stringField(preceding, 'prompt_id') : undefined
      if (!text && tags.length === 0) return []
      // A LATER CHUNK OF THE SAME PROMPT IS NOT ANOTHER ENTRY (POD-5923).
      // Measured on 1.0.46, a paste of image paths alone is recorded as a
      // text chunk of `[Image #N]` placeholders and then one image chunk per
      // image, all with the prompt's `promptIndex`. The image chunks are that
      // prompt's images; counted as entries they were unexplained prompts.
      const companion = !text && stringField(preceding, 'sessionUpdate') === 'user_message_chunk' &&
        promptIndexOf(preceding) !== undefined && promptIndexOf(preceding) === promptIndexOf(update)
      return [
        {
          id: SYNTHESIZED_ITEM_ID_PREFIX,
          role: 'user',
          ...(companion ? { promptEntry: false } : {}),
          ...(ts ? { ts } : {}),
          text,
          ...(promptId ? { harnessRef: [{ kind: 'grok-prompt', id: promptId }] } : {}),
          ...(tags.length > 0 ? { tags } : {}),
        },
      ]
    }
    case 'agent_message_chunk': {
      const { text } = contentBlock(update.content)
      if (!text) return []
      return [{ id: SYNTHESIZED_ITEM_ID_PREFIX, role: 'assistant', ...(ts ? { ts } : {}), text }]
    }
    case 'tool_call': {
      const call = toolCallItem(update, ts)
      return call ? [call] : []
    }
    case 'tool_call_update': {
      const result = toolResultItem(update, ts)
      return result ? [result] : []
    }
    default:
      return []
  }
}

/**
 * `turn_completed` ends a turn. `end_turn` is a finished turn, and the reply
 * right before it was its answer — the marker Claude (stop_reason), Codex
 * (phase), Pi (stopReason) and OpenCode (finish) carry on the reply itself
 * (POD-4809). Any other stop — `cancelled`, `error`, the `interrupted` a resume
 * writes for a turn that died — answered nothing. In 23 real sessions
 * (2026-09-30) all 80 `end_turn`s followed a reply; no other stop did.
 */
export function grokRecordEndsTurn(record: unknown): TranscriptTurnEnd | undefined {
  const update = recordField(recordField(record, 'params'), 'update')
  if (stringField(update, 'sessionUpdate') !== 'turn_completed') return undefined
  return stringField(update, 'stop_reason') === 'end_turn' ? 'answered' : 'ended'
}

/** The chunk's `_meta.promptIndex`: which prompt of the session it belongs to. */
function promptIndexOf(update: Record<string, unknown> | undefined): number | undefined {
  const index = recordField(update, '_meta')?.promptIndex
  return typeof index === 'number' ? index : undefined
}

/** `_meta.agentTimestampMs` as an ISO instant, or undefined. */
function eventTime(meta: Record<string, unknown> | undefined): string | undefined {
  const ms = meta?.agentTimestampMs
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** One ACP content block: its text, or a tag for an attachment. */
function contentBlock(content: unknown): { text: string; tags: TranscriptTag[] } {
  if (typeof content === 'string') return { text: content.trim(), tags: [] }
  if (!isRecord(content)) return { text: '', tags: [] }
  switch (normalizeName(stringField(content, 'type'))) {
    case 'image':
      return { text: '', tags: [{ kind: 'image' }] }
    case 'resource':
    case 'resource_link':
    case 'document':
    case 'file':
      return { text: '', tags: [{ kind: 'file', ...tagLabel(content) }] }
    default:
      return { text: (stringField(content, 'text') ?? '').trim(), tags: [] }
  }
}

function toolCallItem(
  update: Record<string, unknown>,
  ts: string | undefined,
): TranscriptItem | undefined {
  const toolUseId = stringField(update, 'toolCallId')
  // `_meta["x.ai/tool"].name` is Grok's wire name; `title` repeats it on the
  // call record (a later update retitles it for display).
  const wireName =
    stringField(recordField(update._meta, 'x.ai/tool'), 'name') ?? stringField(update, 'title')
  if (!toolUseId || !wireName) return undefined
  const display = grokToolDisplay(wireName, parseGrokArgs(update.rawInput))
  return {
    id: toolUseId,
    role: 'tool',
    ...(ts ? { ts } : {}),
    text: '',
    toolName: display.toolName,
    ...(display.toolInput ? { toolInput: display.toolInput } : {}),
    ...(display.toolTitle ? { toolTitle: display.toolTitle } : {}),
    ...(display.toolPaths?.length ? { toolPaths: display.toolPaths } : {}),
    ...(display.toolInputJson ? { toolInputJson: display.toolInputJson } : {}),
    toolUseId,
  }
}

/**
 * The result of a call, from the update that ends it (`completed` or
 * `failed`); updates without a final status only retitle the call.
 *
 * The text is what the model was given where Grok records it (a shell
 * command's `rawOutput.output_for_prompt`, an edit's or a todo update's
 * `…for_prompt`), else the display content, else the few `rawOutput` shapes
 * that carry no display content (a directory listing, a background task's
 * output); checked against the tool results of 29 real Grok sessions
 * (2026-09-29). No text, no item — the same as an empty result before.
 */
function toolResultItem(
  update: Record<string, unknown>,
  ts: string | undefined,
): TranscriptItem | undefined {
  const status = stringField(update, 'status')
  if (status !== 'completed' && status !== 'failed') return undefined
  const toolUseId = stringField(update, 'toolCallId')
  if (!toolUseId) return undefined
  const raw = recordField(update, 'rawOutput')
  const text = (
    stringField(raw, 'output_for_prompt') ??
    variantForPrompt(raw) ??
    displayText(update.content) ??
    stringField(recordField(raw, 'Content'), 'content') ??
    stringField(recordField(raw, 'Result'), 'output') ??
    stringField(recordField(raw, 'Result'), 'message') ??
    ''
  ).trim()
  if (!text) return undefined
  return {
    id: `${toolUseId}:out`,
    role: 'tool',
    ...(ts ? { ts } : {}),
    text: '',
    toolResult: truncate(text, 2000),
    toolUseId,
  }
}

/** The model-facing text a tool's output variant carries (`EditsApplied`,
 *  `TodosUpdated`, …), when it carries one. */
function variantForPrompt(raw: Record<string, unknown> | undefined): string | undefined {
  for (const value of Object.values(raw ?? {})) {
    const text =
      stringField(value, 'tool_output_for_prompt') ?? stringField(value, 'summary_for_prompt')
    if (text) return text
  }
  return undefined
}

/** The text of a tool update's display content (`[{type:'content', content:{text}}]`). */
function displayText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts = content.flatMap((part) => {
    const text = stringField(recordField(part, 'content'), 'text')
    return text ? [text] : []
  })
  return parts.length > 0 ? parts.join('\n') : undefined
}

interface GrokToolDisplay {
  toolName: string
  toolInput?: string
  toolTitle?: string
  toolPaths?: string[]
  toolInputJson?: string
}

/**
 * Grok's wire names (`run_terminal_command`, `read_file`, …) are not the
 * shared chat vocabulary. Without this map every call falls through to
 * "Ran a tool" / "result", even after the call itself is recovered from
 * `assistant.tool_calls`. Same idea as Codex's exec unwrap (POD-895).
 */
function grokToolDisplay(wireName: string, input: unknown): GrokToolDisplay {
  const path = firstString(input, ['target_file', 'file_path', 'path', 'target_directory'])
  const command = firstString(input, ['command', 'cmd'])
  const description = firstString(input, ['description', 'caption'])
  const preview = toolInputPreview(input) || undefined

  switch (wireName) {
    case 'run_terminal_command':
    case 'shell_command':
    case 'exec_command':
      return {
        toolName: 'Bash',
        ...(command || preview ? { toolInput: command ?? preview } : {}),
        ...(description ? { toolTitle: description } : {}),
      }
    case 'read_file':
    case 'Read':
    case 'NotebookRead':
      return {
        toolName: wireName === 'NotebookRead' ? 'NotebookRead' : 'Read',
        ...(path ? { toolInput: path, toolPaths: [path] } : preview ? { toolInput: preview } : {}),
      }
    case 'write':
    case 'Write': {
      const json = safeToolEditJsonFromInput('Write', input)
      return {
        toolName: 'Write',
        ...(path ? { toolInput: path, toolPaths: [path] } : preview ? { toolInput: preview } : {}),
        ...(json ? { toolInputJson: json } : {}),
      }
    }
    case 'search_replace':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const toolName = wireName === 'MultiEdit' || wireName === 'NotebookEdit' ? wireName : 'Edit'
      const json = safeToolEditJsonFromInput(toolName, input)
      return {
        toolName,
        ...(path ? { toolInput: path, toolPaths: [path] } : preview ? { toolInput: preview } : {}),
        ...(json ? { toolInputJson: json } : {}),
      }
    }
    case 'grep':
    case 'Grep':
    case 'Glob':
      return {
        toolName: wireName === 'Glob' ? 'Glob' : 'Grep',
        ...(firstString(input, ['pattern', 'glob', 'query']) || preview
          ? { toolInput: firstString(input, ['pattern', 'glob', 'query']) ?? preview }
          : {}),
        ...(path ? { toolPaths: [path] } : {}),
      }
    case 'list_dir':
    case 'list_directory':
      return {
        toolName: 'list_dir',
        ...(path ? { toolInput: path, toolPaths: [path] } : preview ? { toolInput: preview } : {}),
      }
    case 'web_fetch':
    case 'WebFetch':
      return {
        toolName: 'WebFetch',
        ...(firstString(input, ['url']) || preview
          ? { toolInput: firstString(input, ['url']) ?? preview }
          : {}),
      }
    case 'web_search':
    case 'WebSearch':
      return {
        toolName: 'WebSearch',
        ...(firstString(input, ['query', 'pattern']) || preview
          ? { toolInput: firstString(input, ['query', 'pattern']) ?? preview }
          : {}),
      }
    case 'todo_write':
    case 'TodoWrite':
      return { toolName: 'TodoWrite', toolTitle: description ?? 'todo list' }
    case 'spawn_subagent':
    case 'Task':
    case 'Agent':
      return {
        toolName: 'Task',
        ...(description || firstString(input, ['subagent_type']) || preview
          ? { toolTitle: description ?? firstString(input, ['subagent_type']) ?? preview }
          : {}),
      }
    case 'ask_user_question':
    case 'AskUserQuestion': {
      const json = objectJson(input)
      return {
        toolName: 'AskUserQuestion',
        toolInput: askQuestionPreview(input),
        ...(json ? { toolInputJson: json } : {}),
      }
    }
    case 'exit_plan_mode':
    case 'ExitPlanMode':
      return {
        toolName: 'ExitPlanMode',
        ...(description || preview ? { toolTitle: description ?? preview } : {}),
      }
    default:
      return {
        toolName: wireName,
        ...(preview ? { toolInput: preview } : {}),
        ...(description ? { toolTitle: description } : {}),
        ...(path ? { toolPaths: [path] } : {}),
      }
  }
}

function parseGrokArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return raw
    }
  }
  return raw
}

function firstString(input: unknown, keys: string[]): string | undefined {
  if (!isRecord(input)) return undefined
  for (const key of keys) {
    const value = stringField(input, key)
    if (value) return value
  }
  return undefined
}

function objectJson(input: unknown): string | undefined {
  if (!isRecord(input) && !Array.isArray(input)) return undefined
  try {
    const json = JSON.stringify(input)
    return json && json !== '{}' ? json : undefined
  } catch {
    return undefined
  }
}

function askQuestionPreview(input: unknown): string {
  if (!isRecord(input)) return 'AskUserQuestion'
  const questions = input.questions
  const first = Array.isArray(questions) && isRecord(questions[0]) ? questions[0] : undefined
  const question = first ? stringField(first, 'question') : undefined
  return question ? truncate(question, 160) : 'AskUserQuestion'
}

function tagLabel(record: Record<string, unknown>): { label: string } | Record<string, never> {
  const source = recordField(record, 'source')
  const label =
    stringField(record, 'title') ??
    stringField(record, 'name') ??
    stringField(record, 'path') ??
    stringField(source, 'title') ??
    stringField(source, 'name') ??
    stringField(source, 'path')
  return label ? { label } : {}
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s
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

/**
 * Grok: the model the prompt was sent to, from a `user_message_chunk`'s
 * `_meta.modelId` (the only `updates.jsonl` record that carries it). Declared
 * as this harness's `recordRuntime` in its transcript section.
 */
export function grokRuntime(record: unknown): HarnessRuntimeObservation {
  const update = recordField(recordField(record, 'params'), 'update')
  if (stringField(update, 'sessionUpdate') !== 'user_message_chunk') return {}
  const model = stringField(recordField(update, '_meta'), 'modelId')
  return model ? { model } : {}
}

// ---------------------------------------------------------------------------
// Transcript section: file-store grammar + layout (POD-4471), the ONE
// authoritative transcript definition for this harness (spec §4).
// ---------------------------------------------------------------------------

export async function grokChainPaths(input: TranscriptSourceInput): Promise<string[]> {
  if (!input.resumeValue) return []
  // Locate, don't derive: Grok buckets by the creation-time cwd, while
  // session.cwd is the current worktree (docs/spec/conversation-registry.md §3.3).
  const path = await locateGrokTranscript({
    cwd: input.cwd,
    sessionId: input.resumeValue,
    ...(input.pathHint !== undefined ? { pathHint: input.pathHint } : {}),
    ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
    ...(input.transcriptRoot !== undefined ? { transcriptRoot: input.transcriptRoot } : {}),
  })
  return path ? [path] : []
}

export const grokTranscript = supported(
  fileTranscript(grokChainPaths, grokRecordToItems, grokRuntime),
)
