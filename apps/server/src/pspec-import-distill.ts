import type { TranscriptItem } from '@podium/protocol'

/**
 * Spec-import distillation (#172) — deterministic, LLM-free compression of a
 * session transcript into a "decision digest".
 *
 * The importer's map/reduce agents must see which questions the human actually
 * answered without drowning in tool output. Keep: user messages verbatim
 * (pasted blobs truncated), AskUserQuestion Q&A pairs, and a short window of
 * the assistant text around each user turn. Drop: tool calls/results, system
 * items, interrupts, thinking. Typical shrink is 20–100×.
 */

export interface DigestHeader {
  conversationId: string
  agentKind: string
  date?: string | undefined
  branch?: string | undefined
  title?: string | undefined
}

const MAX_USER_LINES = 30
const ASSISTANT_TAIL_CHARS = 500
const ASSISTANT_HEAD_CHARS = 240

function truncateBlob(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= MAX_USER_LINES) return text
  return [
    ...lines.slice(0, MAX_USER_LINES),
    `… [${lines.length - MAX_USER_LINES} more lines truncated]`,
  ].join('\n')
}

function tail(text: string, n: number): string {
  const t = text.trim()
  return t.length <= n ? t : `…${t.slice(-n)}`
}

function head(text: string, n: number): string {
  const t = text.trim()
  return t.length <= n ? t : `${t.slice(0, n)}…`
}

/** Render an AskUserQuestion call + its answer as a compact Q&A block. */
function askUserQa(item: TranscriptItem, answer: string | undefined): string | null {
  if (!item.toolInputJson) return null
  let questions: { question?: string; options?: { label?: string }[] }[] = []
  try {
    const parsed = JSON.parse(item.toolInputJson) as {
      questions?: { question?: string; options?: { label?: string }[] }[]
    }
    questions = parsed.questions ?? []
  } catch {
    return null
  }
  if (questions.length === 0) return null
  const qs = questions
    .map((q) => {
      const opts = (q.options ?? [])
        .map((o) => o.label)
        .filter(Boolean)
        .join(' | ')
      return `Q: ${q.question ?? ''}${opts ? `\n   options: ${opts}` : ''}`
    })
    .join('\n')
  return `${qs}\nA: ${answer?.trim() || '(no recorded answer)'}`
}

function isRealUserMessage(item: TranscriptItem): boolean {
  return item.role === 'user' && !item.event && item.text.trim().length > 0
}

/**
 * Distill one conversation's transcript items into a markdown decision digest.
 * Returns null when the session contains no user input worth importing.
 */
export function distillTranscript(items: TranscriptItem[], header: DigestHeader): string | null {
  const blocks: string[] = []
  let lastAssistantText = ''
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.role === 'assistant') {
      if (item.toolName === 'AskUserQuestion') {
        const result = items.find((r) => r.toolUseId && r.toolUseId === item.toolUseId && r !== item)
        const qa = askUserQa(item, result?.toolResult ?? result?.text)
        if (qa) blocks.push(`### Decision (asked)\n${qa}`)
      } else if (item.text.trim()) {
        lastAssistantText = item.text
      }
      continue
    }
    if (!isRealUserMessage(item)) continue
    const parts: string[] = []
    if (lastAssistantText) parts.push(`> agent: ${tail(lastAssistantText, ASSISTANT_TAIL_CHARS)}`)
    parts.push(`USER: ${truncateBlob(item.text.trim())}`)
    const follow = items
      .slice(i + 1, i + 6)
      .find((n) => n.role === 'assistant' && n.text.trim() && !n.toolName)
    if (follow) parts.push(`> agent then: ${head(follow.text, ASSISTANT_HEAD_CHARS)}`)
    blocks.push(parts.join('\n'))
    lastAssistantText = ''
  }
  if (!blocks.some((b) => b.startsWith('USER:') || b.includes('\nUSER:') || b.startsWith('### '))) {
    return null
  }
  const meta = [
    `conversation: ${header.conversationId}`,
    `agent: ${header.agentKind}`,
    header.date ? `date: ${header.date}` : null,
    header.branch ? `branch: ${header.branch}` : null,
    header.title ? `title: ${header.title}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return `## Session ${header.conversationId}\n${meta}\n\n${blocks.join('\n\n')}\n`
}

/** Greedily pack digests into batches of at most `maxChars` (oversized digests
 *  become single-digest batches rather than being dropped). */
export function batchDigests(digests: string[], maxChars = 80_000): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let size = 0
  for (const d of digests) {
    if (current.length > 0 && size + d.length > maxChars) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(d)
    size += d.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}
