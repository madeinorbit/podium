import type { TranscriptItem, TranscriptTag } from '@podium/protocol'

/**
 * Normalize one Claude Code transcript JSONL record into render-oriented
 * TranscriptItems. One record can yield several items: an assistant turn with
 * text + two tool calls becomes one 'assistant' item and two 'tool' items.
 *
 * Skipped on purpose: sidechain records (subagent internals), summary/progress
 * bookkeeping, isMeta records (injected, non-user-authored content), and
 * tool-result-only user records become 'tool' result items rather than user
 * messages.
 */
/**
 * The agent's `/color` accent if this record is an `agent-color` line, else
 * undefined. Claude appends `{"type":"agent-color","agentColor":"green",…}` on
 * every metadata flush (last one wins), so the tail's last non-undefined result
 * is the current colour. Returns the raw named colour (incl. 'default').
 */
export function claudeRecordColor(record: unknown): string | undefined {
  if (typeof record !== 'object' || record === null) return undefined
  const r = record as Record<string, unknown>
  if (r.type !== 'agent-color') return undefined
  return typeof r.agentColor === 'string' ? r.agentColor : undefined
}

export function claudeRecordToItems(record: unknown): TranscriptItem[] {
  if (typeof record !== 'object' || record === null) return []
  const r = record as Record<string, unknown>
  if (r.isSidechain === true) return []
  // Claude Code tags synthetic/injected turns with isMeta:true — skill-body
  // expansions ("Base directory for this skill: …"), slash-command expansions,
  // the auto "Continue from where you left off." prompt, SessionStart context.
  // Its own UI hides them; rendering them as user messages dumps what looks like
  // the system prompt into the chat view (and poisons the /btw seed downstream).
  if (r.isMeta === true) return []
  const uuid = typeof r.uuid === 'string' ? r.uuid : undefined
  const ts = typeof r.timestamp === 'string' ? r.timestamp : undefined
  const message = (r.message ?? {}) as Record<string, unknown>
  // How the user turn originated. Real prompts are 'typed' (also paste/voice); the
  // harness injects task-notifications, system-reminders and slash-command output
  // as type:'user' turns tagged promptSource:'system' — not user-authored. Absent
  // on older transcripts (then undefined → treated as a real turn, no regression).
  const promptSource = typeof r.promptSource === 'string' ? r.promptSource : undefined

  if (r.type === 'user') return userItems(uuid, ts, message, promptSource)
  if (r.type === 'assistant') return assistantItems(uuid, ts, message)
  if (r.type === 'system') {
    const text = typeof r.content === 'string' ? r.content : ''
    if (!text.trim()) return []
    return [{ id: uuid ?? `sys-${ts ?? Math.random()}`, role: 'system', ts, text }]
  }
  return []
}

let fallbackCounter = 0
const freshId = (prefix: string): string => `${prefix}-${++fallbackCounter}`

// The user stopping the agent mid-run is written as a normal user turn whose only
// text is this marker. It IS a user action (role stays 'user'), but it isn't a
// chat message — flag it so the UI shows it inline and a state detector can read
// it as an interrupt rather than a typed prompt.
const INTERRUPT_MARKER = '[Request interrupted by user]'

// Claude Code injects <system-reminder> blocks INTO user turns (timestamps,
// context nudges) — sometimes prepended/appended to a real prompt, sometimes a
// turn is nothing but a reminder. They aren't user-authored, so strip them: the
// chat shows only what the user wrote, a turn that was wholly a reminder drops
// out, and the cleaned text matches the optimistic-bubble draft for reconciliation.
function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

function userItems(
  uuid: string | undefined,
  ts: string | undefined,
  message: Record<string, unknown>,
  promptSource: string | undefined,
): TranscriptItem[] {
  const content = message.content
  // Plain string content: the common typed prompt. But the harness also injects
  // task-notifications / system-reminders / slash-command output as string-content
  // type:'user' turns tagged promptSource:'system' — Claude Code's own UI hides
  // those, so drop them rather than render a misleading "You" bubble. (Array
  // content — tool_results — is never an injected turn, so it falls through.)
  if (typeof content === 'string') {
    if (promptSource === 'system') return []
    const text = stripSystemReminders(content)
    if (!text) return []
    return [
      {
        id: uuid ?? freshId('u'),
        role: 'user',
        ts,
        text,
        ...(text === INTERRUPT_MARKER ? { event: 'interrupt' as const } : {}),
      },
    ]
  }
  if (!Array.isArray(content)) return []

  const items: TranscriptItem[] = []
  const textParts: string[] = []
  const tags: TranscriptTag[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text)
    } else if (b.type === 'image') {
      tags.push({ kind: 'image' })
    } else if (b.type === 'document') {
      const src = b.source as Record<string, unknown> | undefined
      tags.push({ kind: 'file', ...(typeof src?.title === 'string' ? { label: src.title } : {}) })
    } else if (b.type === 'tool_result') {
      const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined
      items.push({
        // Parallel tool calls put several tool_result blocks in one record; key
        // off the tool_use_id (unique per call) so the items don't collide as
        // React keys when their originating calls scrolled out of the buffer.
        id: toolUseId ? `${uuid ?? 'r'}-result-${toolUseId}` : freshId('tr'),
        role: 'tool',
        ts,
        text: '',
        toolResult: truncate(blockContentToText(b.content), 2000),
        ...(toolUseId ? { toolUseId } : {}),
      })
    }
  }
  const text = stripSystemReminders(textParts.join('\n'))
  if (text || tags.length > 0) {
    items.unshift({
      id: uuid ?? freshId('u'),
      role: 'user',
      ts,
      text,
      ...(tags.length > 0 ? { tags } : {}),
      ...(text === INTERRUPT_MARKER ? { event: 'interrupt' as const } : {}),
    })
  }
  return items
}

function assistantItems(
  uuid: string | undefined,
  ts: string | undefined,
  message: Record<string, unknown>,
): TranscriptItem[] {
  const content = message.content
  if (!Array.isArray(content)) return []
  const items: TranscriptItem[] = []
  const textParts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text)
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      const toolUseId = typeof b.id === 'string' ? b.id : undefined
      // AskUserQuestion is the agent asking the human — carry the full structured
      // input so the chat renders an interactive question card instead of a
      // collapsed tool row, and preview the question text rather than a JSON blob.
      const isAsk = b.name === 'AskUserQuestion'
      items.push({
        id: toolUseId ?? freshId('t'),
        role: 'tool',
        ts,
        text: '',
        toolName: b.name,
        toolInput: isAsk ? askQuestionPreview(b.input) : toolInputPreview(b.input),
        ...(isAsk ? { toolInputJson: safeJsonString(b.input) } : {}),
        ...(toolUseId ? { toolUseId } : {}),
      })
    }
  }
  const text = textParts.join('\n').trim()
  if (text) {
    // stop_reason 'end_turn'/'stop_sequence' marks the message that ended the turn
    // — its text is the final, user-facing answer (vs. the intermediate narration
    // in 'tool_use' records). Claude Code splits blocks across records but repeats
    // the parent message's stop_reason on each, so this is reliable per text block.
    const sr = message.stop_reason
    const isAnswer = sr === 'end_turn' || sr === 'stop_sequence'
    items.unshift({
      id: uuid ?? freshId('a'),
      role: 'assistant',
      ts,
      text,
      ...(isAnswer ? { answer: true as const } : {}),
    })
  }
  return items
}

/** One-line, human-scannable summary of a tool input, biased to the fields that matter. */
export function toolInputPreview(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const i = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    if (typeof i[key] === 'string' && i[key]) return truncate(i[key] as string, 160)
  }
  try {
    return truncate(JSON.stringify(i), 160)
  } catch {
    return ''
  }
}

/** Preview for an AskUserQuestion tool: the first question's text (collapsed-row
 *  fallback when the card can't render). */
function askQuestionPreview(input: unknown): string {
  if (typeof input !== 'object' || input === null) return 'AskUserQuestion'
  const qs = (input as Record<string, unknown>).questions
  const first = Array.isArray(qs) ? (qs[0] as Record<string, unknown> | undefined) : undefined
  const q = first && typeof first.question === 'string' ? first.question : undefined
  return q ? truncate(q, 160) : 'AskUserQuestion'
}

/** JSON-stringify a tool input, capped so a pathological payload can't bloat the
 *  transcript. Returns undefined on failure (the card just falls back to the row). */
function safeJsonString(input: unknown): string | undefined {
  try {
    const s = JSON.stringify(input)
    return s.length > 8000 ? undefined : s
  } catch {
    return undefined
  }
}

function blockContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (typeof part === 'object' && part !== null) {
        const p = part as Record<string, unknown>
        if (typeof p.text === 'string') return p.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
