/**
 * btw-thread seeding (modules/superagent): deterministic, zero-LLM context
 * blocks derived from a chat session's transcript — the seed for a fresh
 * `btw_<sessionId>` thread and the marked delta a re-opened thread gets.
 */
import type { TranscriptItem } from '@podium/protocol'

export interface BtwSessionInfo {
  sessionId: string
  name?: string
  agentKind?: string
  cwd?: string
}

/** One transcript item as a marked, length-bounded line (id + ts for awareness). */
function lineForItem(it: TranscriptItem): string {
  const stamp = `${it.ts ?? '?'} · ${it.id}`
  if (it.role === 'tool') {
    if (it.toolName) return `[${stamp}] ⚙ ${it.toolName} ${it.toolInput ?? ''}`.trim()
    return `[${stamp}] result: ${(it.toolResult ?? '').slice(0, 300)}`
  }
  return `[${stamp}] ${it.role}: ${it.text.slice(0, 600)}`
}

/**
 * Items the btw thread hasn't seen yet. Slices after the watermark item id; if
 * that id has fallen out of the transcript (rolled to a fresh file) or there's no
 * watermark, returns everything so the agent re-seeds rather than silently lose
 * context.
 */
export function transcriptDelta(
  items: TranscriptItem[],
  watermark: { itemId?: string },
): TranscriptItem[] {
  if (!watermark.itemId) return items
  const idx = items.findIndex((i) => i.id === watermark.itemId)
  if (idx === -1) return items
  return items.slice(idx + 1)
}

/**
 * A deterministic, zero-LLM recap of a transcript — turn counts, a tool-usage
 * histogram, and recently-touched files. Inspired by Hermes' build_recap (itself
 * after Claude Code's /recap): cheap, instant grounding so the agent (and the
 * orientation turn) start from facts instead of re-deriving them.
 */
export function buildBtwRecap(items: TranscriptItem[]): string {
  const users = items.filter((i) => i.role === 'user' && i.text.trim()).length
  const assistants = items.filter((i) => i.role === 'assistant' && i.text.trim()).length
  const toolItems = items.filter((i) => i.role === 'tool' && i.toolName)
  const hist = new Map<string, number>()
  for (const it of toolItems) {
    const name = it.toolName as string
    hist.set(name, (hist.get(name) ?? 0) + 1)
  }
  const ranked = [...hist.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  // Files touched (best-effort): toolInput is a one-line preview, not structured
  // args, so pull the first path-like token from file-editing tools, newest first.
  const fileTools = new Set([
    'Edit',
    'Write',
    'Read',
    'MultiEdit',
    'NotebookEdit',
    'str_replace_based_edit_tool',
  ])
  const seen = new Set<string>()
  const files: string[] = []
  for (let i = toolItems.length - 1; i >= 0; i--) {
    const it = toolItems[i]
    if (!it || !fileTools.has(it.toolName as string)) continue
    const m = (it.toolInput ?? '').match(/[\w./@~-]*\.[A-Za-z]\w*/)
    const p = m?.[0]
    if (p && !seen.has(p)) {
      seen.add(p)
      files.push(p)
    }
  }
  const lines = [
    `Recap: ${users} user / ${assistants} assistant turns, ${toolItems.length} tool calls`,
  ]
  if (ranked.length > 0) {
    const top = ranked
      .slice(0, 6)
      .map(([n, c]) => `${n}×${c}`)
      .join(', ')
    const extra = ranked.length - 6
    lines.push(`Tools: ${top}${extra > 0 ? ` (+${extra} more)` : ''}`)
  }
  if (files.length > 0) {
    const extra = files.length - 5
    lines.push(`Files: ${files.slice(0, 5).join(', ')}${extra > 0 ? ` (+${extra} more)` : ''}`)
  }
  return lines.join('\n')
}

/**
 * The opening context for a new btw thread: a deterministic recap, an optional
 * summary, every user message verbatim (cheap + high-signal), and a recent
 * full-detail tail. Each line carries the item id + timestamp so the agent knows
 * how caught-up it is across re-opens. Budget-capped, trimming the tail
 * (oldest-first) before the user messages.
 */
export function buildBtwSeed(opts: {
  session: BtwSessionInfo
  summary?: string
  items: TranscriptItem[]
  maxChars?: number
  tailN?: number
}): string {
  const { session, summary, items } = opts
  const maxChars = opts.maxChars ?? 20_000
  const tailN = opts.tailN ?? 20
  const last = items[items.length - 1]
  const users = items.filter((i) => i.role === 'user' && i.text.trim())
  const head =
    `[BTW CONTEXT]\n` +
    `You were opened from a Podium chat session; help continue or reason about it. ` +
    `This is a digest — use read_session_transcript to pull the full transcript, plus ` +
    `search_conversations, start_agent, etc.\n\n` +
    `Session: ${session.name ?? session.sessionId} · ${session.agentKind ?? '?'} · ` +
    `${session.cwd ?? '?'} (id: ${session.sessionId})\n` +
    `Caught up to item ${last?.id ?? '(none)'} at ${last?.ts ?? '?'}.\n` +
    `\n${buildBtwRecap(items)}\n` +
    (summary ? `\nSummary: ${summary}\n` : '')
  const userBlock =
    `\nUser's messages (oldest→newest):\n` +
    users.map((u) => `- [${u.ts ?? '?'}] ${u.text.slice(0, 2000)}`).join('\n')
  // Tail trims oldest-first if the whole seed is over budget.
  let tail = items.slice(-tailN)
  let body = ''
  while (tail.length > 0) {
    body = `\n\nRecent activity (last ${tail.length} items):\n${tail.map(lineForItem).join('\n')}`
    if (head.length + userBlock.length + body.length <= maxChars) break
    tail = tail.slice(Math.ceil(tail.length / 4))
  }
  return (head + userBlock + body).slice(0, maxChars)
}

/** A re-open update: what changed in the origin session since the agent last looked. */
export function buildBtwDelta(opts: {
  prev: { itemId?: string; ts?: string }
  delta: TranscriptItem[]
  now: string
}): string {
  const last = opts.delta[opts.delta.length - 1]
  return (
    `[BTW UPDATE @ ${opts.now}]\n` +
    `Since you last looked (item ${opts.prev.itemId ?? '?'} at ${opts.prev.ts ?? '?'}), ` +
    `the user continued this session. ${opts.delta.length} new items:\n` +
    opts.delta.map(lineForItem).join('\n') +
    `\nNow caught up to item ${last?.id ?? '?'} at ${last?.ts ?? '?'}.`
  )
}
