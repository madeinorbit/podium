/**
 * Issue-topic entry recap [spec:SP-62c3]: last few conversational messages from
 * the bound agent transcript, truncated for phone chat.
 */
import type { TranscriptItem } from '@podium/protocol'

/** How many conversational turns to show on topic entry. */
export const TOPIC_RECAP_MESSAGE_COUNT = 3
/** Per-message body cap — phone-friendly (~300 chars per the coordinator brief). */
export const TOPIC_RECAP_MAX_CHARS = 300
/** Idle gap before a user message re-triggers a recap (no Telegram topic-open). */
export const TOPIC_INACTIVITY_MS = 30 * 60 * 1000

export interface TopicRecapLine {
  role: 'user' | 'assistant'
  text: string
}

/** Prefer the superagent harness session; btw may fall back to the origin agent. */
export function transcriptSessionIdForThread(
  thread:
    | {
        podiumSessionId?: string | null
        originSessionId?: string | null
      }
    | undefined,
  superagentThreadId: string,
): string | undefined {
  if (thread?.podiumSessionId) return thread.podiumSessionId
  if (thread?.originSessionId) return thread.originSessionId
  if (superagentThreadId.startsWith('btw_')) return superagentThreadId.slice(4)
  return undefined
}

/** Last N user/assistant items that have text (skips tools/system/empty). */
export function pickRecapMessages(
  items: TranscriptItem[],
  count = TOPIC_RECAP_MESSAGE_COUNT,
): TopicRecapLine[] {
  const out: TopicRecapLine[] = []
  for (let i = items.length - 1; i >= 0 && out.length < count; i--) {
    const it = items[i]!
    if (it.role !== 'user' && it.role !== 'assistant') continue
    const text = it.text.trim()
    if (!text) continue
    out.push({ role: it.role, text })
  }
  return out.reverse()
}

export function truncatePhoneText(text: string, maxChars = TOPIC_RECAP_MAX_CHARS): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= maxChars) return oneLine
  if (maxChars <= 1) return '…'
  return `${oneLine.slice(0, maxChars - 1)}…`
}

/**
 * Phone-friendly recap block, or undefined when there is nothing to show.
 * Pure: no I/O — callers load the transcript via modules.rpc.readTranscript.
 */
export function formatTopicRecap(
  items: TranscriptItem[],
  opts?: { count?: number; maxChars?: number },
): string | undefined {
  const lines = pickRecapMessages(items, opts?.count ?? TOPIC_RECAP_MESSAGE_COUNT)
  if (lines.length === 0) return undefined
  const maxChars = opts?.maxChars ?? TOPIC_RECAP_MAX_CHARS
  const body = lines
    .map((l) => {
      const who = l.role === 'user' ? 'You' : 'Agent'
      return `${who}: ${truncatePhoneText(l.text, maxChars)}`
    })
    .join('\n')
  return `Recent in this conversation:\n${body}`
}
