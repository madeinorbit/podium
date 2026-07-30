import type { TranscriptItem } from '@podium/protocol'

/**
 * Presentation-pure helpers for the chat surface, shared between the web
 * ChatView and (where the same concept applies) mobile: composer text
 * building, duration/elapsed formatting, and machine-authored context block
 * recognition. Nothing here touches the DOM — the web-only, DOM-dependent
 * chat helpers (block pairing, minimap geometry, …) stay in apps/web/src/chat.ts.
 */

/** Build the path-prefixed prompt: image paths prepended newline-separated, then the user text. */
export function buildImagePrompt(paths: string[], text: string): string {
  if (paths.length === 0) return text
  return `${paths.join('\n')}\n${text}`
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i
/** Does this path look like an image we can render inline? */
export function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path)
}

/** "Churned for …" duration, Claude-style: "2s", "18m 24s", "1h 3m". */
export function formatChurn(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/** Live elapsed since an ISO instant, coarse: "5s", "4m 12s", "1h 6m". */
export function formatElapsed(sinceMs: number, nowMs: number): string {
  return formatChurn(Math.max(0, nowMs - sinceMs))
}

/**
 * Returns true when incoming transcript items represent a reset that should
 * force the scroll position back to the bottom (new session load, reconnect
 * snapshot, or Codex session-switch that sends a fresh snapshot).
 */
export function shouldPinOnReset(isReset: boolean, pinnedToBottom: boolean): boolean {
  // A reset always re-pins: the user's scroll offset into the old data is
  // meaningless once the list has been replaced with a fresh snapshot.
  // Incremental appends respect the current pin state (user may have scrolled up).
  return isReset || pinnedToBottom
}

// ---- Tool-call presentation (Flat Field, POD-159) ----
// Pairing, batching, verdicts: shared by the web ChatView and the mobile
// TranscriptList so the two transcripts agree on what a tool run looks like.

export interface ChatBlock {
  item: TranscriptItem
  /** Result text paired onto a tool-call block (toolUseId match). */
  result?: string
}

/** A text-less user item that only carries uploaded-image paths — the
 *  parser's companion to a user turn whose image marker rode in a separate
 *  record. Folded into the preceding user block so the upload renders inside
 *  the turn it belongs to. */
function isUserMediaMarker(item: TranscriptItem): boolean {
  return (
    item.role === 'user' &&
    item.text === '' &&
    (item.toolPaths?.length ?? 0) > 0 &&
    (item.tags ?? []).every((t) => t.kind === 'image')
  )
}

/**
 * Collapse the raw item stream into renderable blocks: tool results fold into
 * their originating tool call; a media-marker user item folds its paths into
 * the preceding user block; everything else passes through in order.
 */
export function pairToolResults(items: TranscriptItem[]): ChatBlock[] {
  const blocks: ChatBlock[] = []
  const callByToolUseId = new Map<string, ChatBlock>()
  for (const item of items) {
    if (isUserMediaMarker(item)) {
      const prev = blocks[blocks.length - 1]
      if (prev && prev.item.role === 'user' && prev.item.event === undefined) {
        prev.item = {
          ...prev.item,
          toolPaths: [...(prev.item.toolPaths ?? []), ...(item.toolPaths ?? [])],
          tags: [...(prev.item.tags ?? []), ...(item.tags ?? [])],
        }
        continue
      }
      // No preceding user turn (window seam) — render it as a media-only turn.
      blocks.push({ item })
      continue
    }
    if (item.role === 'tool' && item.toolResult !== undefined && item.toolUseId) {
      const call = callByToolUseId.get(item.toolUseId)
      if (call) {
        call.result = item.toolResult
        continue
      }
      // Orphan result (call scrolled out of the buffer) — show it standalone.
      blocks.push({ item })
      continue
    }
    const block: ChatBlock = { item }
    if (item.role === 'tool' && item.toolUseId) callByToolUseId.set(item.toolUseId, block)
    blocks.push(block)
  }
  return blocks
}

/**
 * A tool call quiet enough to fold into a batch. AskUserQuestion (the agent
 * prompting the human → interactive card) and SendUserFile (the agent surfacing
 * images/files → inline previews + lightbox) both render richly, so they break a
 * run like any text output instead of collapsing into a summary line.
 */
export function isBatchableTool(item: TranscriptItem): boolean {
  return (
    item.role === 'tool' && item.toolName !== 'AskUserQuestion' && item.toolName !== 'SendUserFile'
  )
}

/** A run of consecutive tool calls, shown collapsed under one summary title. */
export interface ToolBatchRow {
  kind: 'tools'
  blocks: ChatBlock[]
  /** Each child's index in the flat ChatBlock[] — lets search map a hit to its row. */
  blockIndices: number[]
  title: string
}
/** Anything that isn't a quiet tool call: prose, prompts, the AskUserQuestion card. */
export interface SingleRow {
  kind: 'block'
  block: ChatBlock
  blockIndex: number
}
export type ChatRow = SingleRow | ToolBatchRow

/**
 * Group the flat block stream into renderable rows. Maximal runs of consecutive
 * quiet tool calls (no intervening text/prompt) collapse into one summarized
 * batch; every other block stays its own row and breaks a run. Mirrors how the
 * agent works in bursts of tools between bits of narration.
 */
export function buildChatRows(blocks: ChatBlock[]): ChatRow[] {
  const rows: ChatRow[] = []
  let run: { blocks: ChatBlock[]; indices: number[] } | null = null
  const flush = (): void => {
    if (!run) return
    rows.push({
      kind: 'tools',
      blocks: run.blocks,
      blockIndices: run.indices,
      title: toolBatchTitle(run.blocks),
    })
    run = null
  }
  blocks.forEach((block, i) => {
    if (isBatchableTool(block.item)) {
      run ??= { blocks: [], indices: [] }
      run.blocks.push(block)
      run.indices.push(i)
    } else {
      flush()
      rows.push({ kind: 'block', block, blockIndex: i })
    }
  })
  flush()
  return rows
}

// Tool → the verb/noun the summary counts it under. Past tense to read as a log
// of what happened ("Read 3 files", "Created 4 files", "Ran 5 commands").
function toolCategory(item: TranscriptItem): { verb: string; noun: string } {
  switch (item.toolName) {
    case 'Read':
      return { verb: 'Read', noun: 'file' }
    case 'Write':
      return { verb: 'Created', noun: 'file' }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: 'Edited', noun: 'file' }
    case 'Bash':
      return { verb: 'Ran', noun: 'command' }
    case 'Task':
      return { verb: 'Ran', noun: 'agent' }
    case 'Grep':
    case 'Glob':
      return { verb: 'Ran', noun: 'search' }
    default:
      return { verb: 'Ran', noun: 'tool' }
  }
}

const pluralizeNoun = (noun: string): string =>
  /(?:s|x|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`
const articleFor = (noun: string): string => (/^[aeiou]/i.test(noun) ? 'an' : 'a')
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)
const clauseFor = (verb: string, noun: string, count: number): string =>
  count === 1 ? `${verb} ${articleFor(noun)} ${noun}` : `${verb} ${count} ${pluralizeNoun(noun)}`

/**
 * Smart one-line summary for a tool batch: clauses per tool kind in first-
 * appearance order, the first capitalized and the rest lowercased
 * ("Read 2 files, ran a command"). A lone command quotes the agent's own intent
 * (the Bash `description`, falling back to the shell) rather than counting it:
 * `Ran "Render the three chat-view mockups to PNG"`.
 */
export function toolBatchTitle(blocks: ChatBlock[]): string {
  const only = blocks.length === 1 ? blocks[0] : undefined
  if (only && only.item.toolName === 'Bash') {
    const label = (only.item.toolTitle ?? only.item.toolInput ?? '').trim()
    return label ? `Ran "${label}"` : 'Ran a command'
  }
  const order: string[] = []
  const tally = new Map<string, { verb: string; noun: string; count: number }>()
  for (const b of blocks) {
    const { verb, noun } = toolCategory(b.item)
    const key = `${verb}|${noun}`
    const entry = tally.get(key)
    if (entry) entry.count++
    else {
      tally.set(key, { verb, noun, count: 1 })
      order.push(key)
    }
  }
  return order
    .map((key, i) => {
      const { verb, noun, count } = tally.get(key)!
      const clause = clauseFor(verb, noun, count)
      return i === 0 ? clause : lowerFirst(clause)
    })
    .join(', ')
}

/** Per-call outcome shown as a glyph on the collapsed tool row (Flat Field
 *  design, POD-159). The transcript carries no structured error flag, so this
 *  is a conservative heuristic over the result text: only patterns that
 *  reliably open real failure output flag 'err'; anything ambiguous stays
 *  'ok' so successes never read as failures. 'none' = no result captured. */
export type ToolVerdict = 'ok' | 'err' | 'none'

const TOOL_ERR_RE =
  /^\s*(?:error(?::|\b)|[A-Za-z]*Error:|exception\b|traceback \(most recent call last\)|fatal:|command failed|exit code [1-9]|exited with (?:code [1-9]|non-zero))/i

export function toolVerdict(result: string | undefined): ToolVerdict {
  if (result === undefined || result.trim() === '') return 'none'
  const firstLine = result.trimStart().split('\n', 1)[0] ?? ''
  return TOOL_ERR_RE.test(firstLine) ? 'err' : 'ok'
}

/** The line shown inline under a failed tool row: the first non-empty line of
 *  the result, truncated by the renderer. */
export function failLine(result: string | undefined): string {
  if (!result) return ''
  for (const line of result.split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

/** Machine-authored superagent context blocks (seed / re-entry delta), matched
 *  by their leading marker — collapsed into a quiet disclosure row instead of
 *  a giant "You" bubble. */
export const MACHINE_CONTEXT_RE = /^\[(BTW|CONCIERGE) (CONTEXT|UPDATE)/

/** Label for a collapsed machine-context row: repo vs session, context vs update. */
export function machineContextLabel(text: string): string {
  const what = text.startsWith('[CONCIERGE') ? 'repo' : 'session'
  const kind = /^\[(BTW|CONCIERGE) UPDATE/.test(text) ? 'update' : 'context'
  return `${what} ${kind}`
}
