import type { TranscriptItem } from '@podium/model'
import { toolInputPreview } from './claude'
import { contentToText, isRecord, stringField } from './json-util'

/**
 * Normalize one Codex rollout JSONL record (envelope `{ timestamp, type, payload }`)
 * into Podium chat items.
 *
 * User text: taken from `event_msg.user_message` — the canonical, typed prompt.
 * `response_item` role=user records are ALWAYS duplicates of the paired event_msg
 * (Codex injects them into the model context) or system preamble; either way, skip.
 * `response_item` role=developer is always a permissions/AGENTS preamble; skip.
 * `response_item` role=assistant → assistant message.
 *
 * `function_call` / `custom_tool_call` → tool call (keyed by call_id || id).
 * `function_call_output` / `custom_tool_call_output` → tool result.  Even empty-
 * output records are emitted so callers always see a result paired with each call.
 *
 * `reasoning` (encrypted or plain) → skip explicitly.
 * All other event_msg subtypes (task_started, token_count, agent_message …) → skip.
 */
export function codexRecordToItems(record: unknown): TranscriptItem[] {
  if (!isRecord(record)) return []
  const payload = isRecord(record.payload) ? record.payload : undefined
  if (!payload) return []
  const type = stringField(record, 'type')
  const ptype = stringField(payload, 'type')
  const ts = stringField(record, 'timestamp') ?? stringField(payload, 'timestamp')

  if (type === 'event_msg') {
    if (ptype !== 'user_message') return []
    const text = userMessageText(payload)
    return text
      ? [
          {
            id: stableId('codex-user', `${ts ?? ''}:${text}`),
            role: 'user',
            ...(ts ? { ts } : {}),
            text,
          },
        ]
      : []
  }

  if (type !== 'response_item') return []

  switch (ptype) {
    case 'message': {
      const role = stringField(payload, 'role')
      // developer = permissions/AGENTS preamble; user = event_msg duplicate or env preamble.
      // Both are always covered by a canonical event_msg or are internal-only, so skip.
      // Note: skipping user-role response_item relies on event_msg covering the user turn.
      if (role !== 'assistant') return []
      const text = contentToText(payload.content).trim()
      return text
        ? [
            {
              id: stableId('codex-assistant', `${ts ?? ''}:${text}`),
              role: 'assistant',
              ...(ts ? { ts } : {}),
              text,
            },
          ]
        : []
    }
    case 'function_call':
    case 'custom_tool_call':
      return [toolCallItem(payload, ts)]
    case 'function_call_output':
    case 'custom_tool_call_output':
      // Always emit the result even when output is empty — callers expect a result
      // for every call and should not silently lose tool turns.
      return [toolResultItem(payload, ts)]
    case 'reasoning':
      // Encrypted or plain reasoning blobs — internal to the model, not chat content.
      return []
    default:
      // Known unparsed gap: `compacted` (replacement_history) records appear in
      // long sessions where Codex compacts its context. They carry no displayable
      // content, so falling through to an empty result is correct.
      return []
  }
}

function userMessageText(payload: Record<string, unknown>): string {
  return (stringField(payload, 'message') ?? contentToText(payload.text_elements)).trim()
}

function toolCallItem(payload: Record<string, unknown>, ts: string | undefined): TranscriptItem {
  const wireToolName = stringField(payload, 'name') ?? 'tool'
  const rawInput = payload.arguments ?? payload.input
  const display = codexToolDisplay(wireToolName, rawInput)
  const callId = stringField(payload, 'call_id') ?? stringField(payload, 'id')
  return {
    id: callId ?? stableId('codex-tool', `${wireToolName}:${ts ?? ''}`),
    role: 'tool',
    ...(ts ? { ts } : {}),
    text: '',
    toolName: display.toolName,
    ...(display.toolInput ? { toolInput: display.toolInput } : {}),
    ...(display.toolTitle ? { toolTitle: display.toolTitle } : {}),
    ...(display.toolPaths?.length ? { toolPaths: display.toolPaths } : {}),
    ...(callId ? { toolUseId: callId } : {}),
  }
}

interface CodexToolDisplay {
  toolName: string
  toolInput?: string
  toolTitle?: string
  toolPaths?: string[]
}

interface WrappedToolCall {
  name: string
  input: unknown
}

/**
 * Codex's unified tool protocol exposes one outer custom tool named `exec`.
 * Its input is JavaScript which calls the real tool (`tools.exec_command`,
 * `tools.apply_patch`, ...). Showing the transport wrapper in chat regressed
 * the work line from "Running bun test" to "Running exec" (POD-514).
 *
 * Recover only the small, generated call shape we can recognize without
 * evaluating JavaScript. Unknown scripts get a quiet "automation" summary;
 * transcript parsing must never execute agent-authored input.
 */
function codexToolDisplay(wireName: string, rawInput: unknown): CodexToolDisplay {
  if (wireName === 'exec' && typeof rawInput === 'string') {
    const calls = wrappedToolCalls(rawInput)
    const onlyCall = calls.length === 1 ? calls[0] : undefined
    if (onlyCall) return codexToolDisplay(onlyCall.name, onlyCall.input)
    if (calls.length > 1) {
      const kinds = [...new Set(calls.map((call) => wrappedToolKind(call.name)))]
      const onlyKind = kinds.length === 1 ? kinds[0] : undefined
      return {
        toolName: 'Workflow',
        toolTitle: `${calls.length} ${onlyKind ? pluralize(onlyKind, calls.length) : 'actions'}`,
      }
    }
    return { toolName: 'Workflow', toolTitle: 'automation' }
  }

  const input = parseArgs(rawInput)
  if (wireName === 'exec_command') {
    return {
      toolName: 'Bash',
      toolInput: (recordString(input, 'cmd') ?? toolInputPreview(input)) || undefined,
    }
  }
  if (wireName === 'apply_patch') {
    const patch = typeof input === 'string' ? input : recordString(input, 'patch')
    const toolPaths = patch ? patchPaths(patch) : []
    const createsOnly =
      patch !== undefined &&
      /\*\*\* Add File:/.test(patch) &&
      !/\*\*\* (?:Update|Delete) File:/.test(patch)
    return {
      toolName: createsOnly ? 'Write' : 'Edit',
      ...(toolPaths[0] ? { toolInput: toolPaths[0], toolPaths } : { toolTitle: 'patch' }),
    }
  }
  if (wireName === 'write_stdin') {
    const sessionId = recordScalar(input, 'session_id')
    return {
      toolName: 'Bash',
      toolInput: sessionId === undefined ? 'running command' : `command session ${sessionId}`,
    }
  }
  if (wireName === 'view_image') {
    const path = recordString(input, 'path')
    return {
      toolName: 'Read',
      ...(path ? { toolInput: path, toolPaths: [path] } : { toolTitle: 'image' }),
    }
  }

  return {
    toolName: wireName,
    ...(toolInputPreview(input) ? { toolInput: toolInputPreview(input) } : {}),
  }
}

function recordString(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) return undefined
  return typeof input[key] === 'string' ? input[key] : undefined
}

function recordScalar(input: unknown, key: string): string | number | undefined {
  if (!isRecord(input)) return undefined
  const value = input[key]
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].flatMap((match) =>
    match[1] ? [match[1].trim()] : [],
  )
}

function wrappedToolKind(name: string): string {
  if (name === 'exec_command' || name === 'write_stdin') return 'command'
  if (name === 'apply_patch') return 'edit'
  if (name === 'view_image') return 'image'
  return 'action'
}

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`
}

/** Find generated `tools.name(firstArgument)` calls without running the script. */
function wrappedToolCalls(source: string): WrappedToolCall[] {
  const calls: WrappedToolCall[] = []
  const toolCall = /\btools\.([A-Za-z_$][\w$]*)\s*\(/g
  for (const match of source.matchAll(toolCall)) {
    const name = match[1]
    if (!name || match.index === undefined || !isCodePosition(source, match.index)) continue
    const openParen = match.index + match[0].length - 1
    const expression = firstArgument(source, openParen + 1)
    if (expression === undefined) continue
    calls.push({ name, input: parseWrappedExpression(expression, source) })
  }
  return calls
}

/** The command itself can mention `tools.foo(`. Ignore matches inside strings
 *  and comments so those words do not turn one command into a fake workflow. */
function isCodePosition(source: string, target: number): boolean {
  let quote: '"' | "'" | '`' | undefined
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let i = 0; i < target; i += 1) {
    const char = source[i]
    const next = source[i + 1]
    if (char === undefined) break
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        i += 1
      }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      i += 1
    } else if (char === '/' && next === '*') {
      blockComment = true
      i += 1
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char
    }
  }
  return quote === undefined && !lineComment && !blockComment
}

/** Read up to the first top-level comma or the call's closing parenthesis. */
function firstArgument(source: string, start: number): string | undefined {
  const stack: string[] = []
  let quote: '"' | "'" | '`' | undefined
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (char === undefined) break
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '(' || char === '{' || char === '[') stack.push(char)
    else if (char === ')' && stack.length === 0) return source.slice(start, i).trim()
    else if (char === ',' && stack.length === 0) return source.slice(start, i).trim()
    else if (char === ')' || char === '}' || char === ']') stack.pop()
  }
  return undefined
}

function parseWrappedExpression(expression: string, source: string): unknown {
  const direct = parseJsonExpression(expression)
  if (direct !== undefined) return direct
  if (!/^[A-Za-z_$][\w$]*$/.test(expression)) return expression

  const escapedName = expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const assignment = new RegExp(`\\b(?:const|let|var)\\s+${escapedName}\\s*=\\s*`).exec(source)
  if (!assignment || assignment.index >= source.indexOf(`tools.`)) return expression
  const valueStart = assignment.index + assignment[0].length
  const value = assignedExpression(source, valueStart)
  return value === undefined ? expression : (parseJsonExpression(value) ?? expression)
}

/** Read a generated variable initializer up to its top-level semicolon. */
function assignedExpression(source: string, start: number): string | undefined {
  const stack: string[] = []
  let quote: '"' | "'" | '`' | undefined
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (char === undefined) break
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '(' || char === '{' || char === '[') stack.push(char)
    else if (char === ')' || char === '}' || char === ']') stack.pop()
    else if (char === ';' && stack.length === 0) return source.slice(start, i).trim()
  }
  return undefined
}

function parseJsonExpression(expression: string): unknown {
  try {
    return JSON.parse(expression)
  } catch {
    return undefined
  }
}

function toolResultItem(payload: Record<string, unknown>, ts: string | undefined): TranscriptItem {
  const out = payload.output
  const text = (typeof out === 'string' ? out : contentToText(out)).trim()
  const callId = stringField(payload, 'call_id') ?? stringField(payload, 'id')
  return {
    id: callId ? `${callId}:out` : stableId('codex-tool-result', `${ts ?? ''}:${text}`),
    role: 'tool',
    ...(ts ? { ts } : {}),
    text: '',
    // Always set toolResult, even when empty — callers rely on the item being present.
    toolResult: truncate(text, 2000),
    ...(callId ? { toolUseId: callId } : {}),
  }
}

function parseArgs(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s
}

function stableId(prefix: string, seed: string): string {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`
}
