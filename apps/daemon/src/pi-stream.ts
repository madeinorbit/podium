/**
 * Pure fold over Pi's `--mode json` event stream (pi 0.84.4, `docs/json.md`),
 * shared by the in-process driver and both durable paths so the three never
 * disagree about what a turn produced.
 *
 * Verified shapes:
 *   {type:'session', id}                                   — always the first line
 *   {type:'message_start', message:{role, responseId?}}
 *   {type:'message_update', assistantMessageEvent:{type:'text_delta', delta}}
 *   {type:'tool_execution_start', toolCallId, toolName, args}
 *   {type:'message_end', message:{role:'assistant', content:[…], stopReason, errorMessage?}}
 *   {type:'auto_retry_start'|'auto_retry_end', …}
 *   {type:'agent_end'} {type:'agent_settled'}
 *
 * A provider failure does NOT change the exit code (still 0): the assistant
 * message carries `stopReason: 'error'` and Pi retries up to three times, then
 * `auto_retry_end { success: false, finalError }`. So "failed" is read from the
 * LAST assistant message, never from the process.
 */

export interface PiStreamEffect {
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  sessionId?: string
  /** The assistant text streamed so far in the current message. */
  partialText?: string
  /** Hint pairing partial text with one assistant message. */
  itemHint?: string
  /** A tool just started executing. */
  toolLabel?: string
}

export interface PiStreamResult {
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  sessionId?: string
  /** The final answer: text of the last successful assistant message. */
  output: string
  /** Set when the turn ended in a provider/agent error. */
  error?: string
}

export interface PiStreamReducer {
  /** Fold one parsed event; returns what a live consumer should surface. */
  push(event: unknown): PiStreamEffect | undefined
  /** Fold one raw JSONL line (blank and unparseable lines are ignored). */
  pushLine(line: string): PiStreamEffect | undefined
  result(): PiStreamResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function assistantText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (isRecord(part) && part.type === 'text' ? str(part, 'text') : undefined))
    .filter((part): part is string => !!part)
    .join('')
}

export function createPiStreamReducer(): PiStreamReducer {
  let sessionId: string | undefined
  let partial = ''
  let itemHint: string | undefined
  let output = ''
  let error: string | undefined

  const push = (event: unknown): PiStreamEffect | undefined => {
    if (!isRecord(event)) return undefined
    switch (str(event, 'type')) {
      case 'session': {
        const id = str(event, 'id')
        if (!id) return undefined
        sessionId = id
        return { sessionId: id }
      }
      case 'message_start': {
        const message = isRecord(event.message) ? event.message : undefined
        if (message && str(message, 'role') === 'assistant') {
          partial = ''
          itemHint = str(message, 'responseId')
        }
        return undefined
      }
      case 'message_update': {
        const ev = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined
        if (!ev || str(ev, 'type') !== 'text_delta') return undefined
        partial += typeof ev.delta === 'string' ? ev.delta : ''
        return { partialText: partial, ...(itemHint ? { itemHint } : {}) }
      }
      case 'tool_execution_start': {
        const toolName = str(event, 'toolName')
        return toolName ? { toolLabel: toolName } : undefined
      }
      case 'message_end': {
        const message = isRecord(event.message) ? event.message : undefined
        if (!message || str(message, 'role') !== 'assistant') return undefined
        const text = assistantText(message)
        if (str(message, 'stopReason') === 'error') {
          error = str(message, 'errorMessage') ?? 'pi turn failed'
        } else {
          error = undefined
          if (text.trim()) output = text.trim()
        }
        partial = ''
        // The authoritative text supersedes any streamed partial.
        return text.trim()
          ? { partialText: text.trim(), ...(itemHint ? { itemHint } : {}) }
          : undefined
      }
      case 'auto_retry_end': {
        if (event.success === false) error = str(event, 'finalError') ?? error ?? 'pi turn failed'
        return undefined
      }
      default:
        return undefined
    }
  }

  return {
    push,
    pushLine(line) {
      const trimmed = line.trim()
      if (!trimmed) return undefined
      let event: unknown
      try {
        event = JSON.parse(trimmed)
      } catch {
        return undefined
      }
      return push(event)
    },
    result: () => ({
      ...(sessionId ? { sessionId } : {}),
      output,
      ...(error ? { error } : {}),
    }),
  }
}
