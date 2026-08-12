import type { TranscriptItem, TranscriptTag } from '@podium/model'
import { toolInputPreview } from './claude'

/** Normalize one Grok chat_history.jsonl record into Podium chat transcript items. */
export function grokRecordToItems(record: unknown): TranscriptItem[] {
  if (!isRecord(record)) return []
  const kind = normalizeName(stringField(record, 'type') ?? stringField(record, 'role'))
  if (!kind || kind === 'reasoning') return []
  // Grok marks its own injected turns with synthetic_reason (system_reminder,
  // project_instructions, task_completed). They wear role 'user' but nobody
  // typed them, and the first is written into chat_history at session creation —
  // so without this an untouched session opens on an 8KB skill listing posing as
  // the user's first message. Same call as Claude Code's isMeta turns. [POD-386]
  if (stringField(record, 'synthetic_reason')) return []

  const ts =
    stringField(record, 'timestamp') ??
    stringField(record, 'created_at') ??
    stringField(record, 'createdAt')
  const message = recordField(record, 'message')
  const content = record.content ?? message?.content

  switch (kind) {
    case 'user':
    case 'user_message':
      return messageItems(record, 'user', content, ts)
    case 'assistant':
    case 'assistant_message':
      return messageItems(record, 'assistant', content, ts)
    case 'system':
    case 'system_message':
      // Grok stores its full injected system prompt in chat_history.jsonl. That
      // is useful for export/debugging, but chat mode should mirror the user-visible conversation.
      return []
    case 'tool':
    case 'tool_use':
    case 'tool_call': {
      const call = toolCallItem(record, ts, kind)
      if (call) return [call]
      const result = toolResultItem(record, ts)
      return result ? [result] : []
    }
    case 'tool_result':
    case 'tool_call_result': {
      const result = toolResultItem(record, ts)
      return result ? [result] : []
    }
    default:
      return []
  }
}

function messageItems(
  record: Record<string, unknown>,
  role: 'user' | 'assistant',
  content: unknown,
  ts: string | undefined,
): TranscriptItem[] {
  const parts = contentParts(content, ts)
  const text = role === 'user' ? userVisibleText(parts.text) : parts.text
  const items: TranscriptItem[] = []
  if (text || parts.tags.length > 0) {
    items.push({
      id: baseId(record, `grok-${role}`, `${role}:${ts ?? ''}:${text}`),
      role,
      ...(ts ? { ts } : {}),
      text,
      ...(parts.tags.length > 0 ? { tags: parts.tags } : {}),
    })
  }
  items.push(...parts.extraItems)
  // Grok's live format puts calls on `assistant.tool_calls`, not in content
  // blocks. Older fixtures (and a few Claude-shaped records) still use
  // `tool_use` parts, which contentParts already emitted above — skip dupes.
  if (role === 'assistant') {
    const seen = new Set(
      items.flatMap((item) => (item.toolUseId ? [item.toolUseId] : [])),
    )
    for (const item of assistantToolCallItems(record, ts)) {
      if (item.toolUseId && seen.has(item.toolUseId)) continue
      items.push(item)
    }
  }
  return items
}

function assistantToolCallItems(
  record: Record<string, unknown>,
  ts: string | undefined,
): TranscriptItem[] {
  if (!Array.isArray(record.tool_calls)) return []
  const items: TranscriptItem[] = []
  for (const call of record.tool_calls) {
    if (!isRecord(call)) continue
    const item = toolCallItem(call, ts, 'tool_call')
    if (item) items.push(item)
  }
  return items
}

function systemItems(
  record: Record<string, unknown>,
  content: unknown,
  ts: string | undefined,
): TranscriptItem[] {
  const text = contentText(content)
  if (!text) return []
  return [
    {
      id: baseId(record, 'grok-system', `system:${ts ?? ''}:${text}`),
      role: 'system',
      ...(ts ? { ts } : {}),
      text,
    },
  ]
}

function contentParts(
  content: unknown,
  ts: string | undefined,
): { text: string; tags: TranscriptTag[]; extraItems: TranscriptItem[] } {
  const textParts: string[] = []
  const tags: TranscriptTag[] = []
  const extraItems: TranscriptItem[] = []

  const visit = (part: unknown): void => {
    if (typeof part === 'string') {
      textParts.push(part)
      return
    }
    if (!isRecord(part)) return
    const kind = normalizeName(stringField(part, 'type'))
    if (kind === 'text' || kind === 'markdown') {
      const text = stringField(part, 'text') ?? stringField(part, 'content')
      if (text) textParts.push(text)
      return
    }
    if (kind === 'image') {
      tags.push({ kind: 'image' })
      return
    }
    if (kind === 'document' || kind === 'file') {
      tags.push({ kind: 'file', ...tagLabel(part) })
      return
    }
    if (kind === 'tool_use' || kind === 'tool_call') {
      const item = toolCallItem(part, ts, kind)
      if (item) extraItems.push(item)
      return
    }
    if (kind === 'tool_result' || kind === 'tool_call_result') {
      const item = toolResultItem(part, ts)
      if (item) extraItems.push(item)
      return
    }
    const text = stringField(part, 'text')
    if (text) textParts.push(text)
  }

  if (Array.isArray(content)) {
    for (const part of content) visit(part)
  } else {
    visit(content)
  }

  return { text: textParts.join('\n').trim(), tags, extraItems }
}

function toolCallItem(
  record: Record<string, unknown>,
  ts: string | undefined,
  fallbackKind: string,
): TranscriptItem | undefined {
  const wireName =
    stringField(record, 'name') ??
    stringField(record, 'tool_name') ??
    stringField(record, 'toolName')
  if (!wireName) return undefined
  const rawInput = record.input ?? record.arguments ?? record.args
  const display = grokToolDisplay(wireName, parseGrokArgs(rawInput))
  const toolUseId =
    stringField(record, 'id') ??
    stringField(record, 'tool_use_id') ??
    stringField(record, 'tool_call_id') ??
    stringField(record, 'call_id')
  return {
    id:
      toolUseId ??
      stableId('grok-tool', `${fallbackKind}:${display.toolName}:${safeJson(rawInput)}`),
    role: 'tool',
    ...(ts ? { ts } : {}),
    text: '',
    toolName: display.toolName,
    ...(display.toolInput ? { toolInput: display.toolInput } : {}),
    ...(display.toolTitle ? { toolTitle: display.toolTitle } : {}),
    ...(display.toolPaths?.length ? { toolPaths: display.toolPaths } : {}),
    ...(display.toolInputJson ? { toolInputJson: display.toolInputJson } : {}),
    ...(toolUseId ? { toolUseId } : {}),
  }
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
    case 'Write':
      return {
        toolName: 'Write',
        ...(path ? { toolInput: path, toolPaths: [path] } : preview ? { toolInput: preview } : {}),
      }
    case 'search_replace':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return {
        toolName: wireName === 'MultiEdit' || wireName === 'NotebookEdit' ? wireName : 'Edit',
        ...(path ? { toolInput: path, toolPaths: [path] } : preview ? { toolInput: preview } : {}),
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

function toolResultItem(
  record: Record<string, unknown>,
  ts: string | undefined,
): TranscriptItem | undefined {
  const resultText = contentText(record.result ?? record.output ?? record.content)
  if (!resultText) return undefined
  const toolUseId =
    stringField(record, 'tool_use_id') ??
    stringField(record, 'tool_call_id') ??
    stringField(record, 'call_id')
  return {
    id: baseId(record, 'grok-tool-result', `result:${toolUseId ?? ''}:${resultText}`),
    role: 'tool',
    ...(ts ? { ts } : {}),
    text: '',
    toolResult: truncate(resultText, 2000),
    ...(toolUseId ? { toolUseId } : {}),
  }
}

function userVisibleText(text: string): string {
  const userQuery = taggedContent(text, 'user_query')
  if (userQuery !== undefined) return userQuery.trim()
  if (isInjectedGrokContext(text)) return ''
  return text
}

function taggedContent(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(text)
  return match?.[1]
}

function isInjectedGrokContext(text: string): boolean {
  // Grok writes the reminder tag hyphenated (`<system-reminder>`); keep the
  // underscore spelling too so older transcripts stay covered.
  return /<(user_info|rules|agent_skills|mcp_file_system|system[_-]reminder)(>|\s)/i.test(text)
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (isRecord(part)) {
          if (typeof part.text === 'string') return part.text
          if (typeof part.content === 'string') return part.content
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  if (isRecord(content)) {
    return (stringField(content, 'text') ?? stringField(content, 'content') ?? '').trim()
  }
  return ''
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

function baseId(record: Record<string, unknown>, prefix: string, seed: string): string {
  return stringField(record, 'id') ?? stringField(record, 'uuid') ?? stableId(prefix, seed)
}

function stableId(prefix: string, seed: string): string {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
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
