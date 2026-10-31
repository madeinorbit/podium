import {
  classifyMailCommand,
  countInboxNotes,
  type MailCommand,
  type MailReceipt,
  mailReceipts,
  mailRecipientLabel,
} from '@podium/commands/mail-command'
import type { MessageRecordWire, TranscriptItem } from '@podium/model'
import { machinePathBasename } from '@podium/model'
import {
  isOperatorQuestion,
  type ParsedEnvelopeBatch,
  parseEnvelopeBatch,
  principalShortName,
} from './message-envelope'

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
  /** The agent's own mail this call sent or read (POD-2146), when it went
   *  through. Set by {@link presentToolBlock}; renderers only read it. */
  mail?: ToolMail
  /** A Codex script's calls as its row lists them, a mail call that went
   *  through named as its note. Set by {@link presentToolBlock}. */
  scriptCalls?: ScriptCallLine[]
}

/** A mail call as the chat shows it: a sent note, or an inbox read. */
export type ToolMail =
  | {
      op: 'note'
      /** The principal label it went to; "the sender" for a reply an older
       *  server did not name. */
      to: string
      /** The new message's id, once the CLI printed it. */
      id?: string
      preview?: string
    }
  | { op: 'inbox'; notes?: number }

/** One line of an expanded Script row. */
export interface ScriptCallLine {
  tool: string
  input: string
}

/** A text-less user item that only carries attached media paths — the parser's
 *  companion to a user turn whose image marker or @-mentioned file rode in a
 *  separate record. Folded into the preceding user block so the attachment
 *  renders inside the turn it belongs to.
 *
 *  Images and files fold alike (POD-1171). The predicate used to accept only
 *  `kind: 'image'`, so an @-mention's file marker fell through and stood alone
 *  as its own right-aligned "You" bubble holding nothing but a chip — a turn the
 *  operator never took. Anything else the parser might one day tag stays
 *  standalone rather than being silently absorbed into someone's prompt. */
export function isUserMediaMarker(item: TranscriptItem): boolean {
  return (
    item.role === 'user' &&
    item.text === '' &&
    (item.toolPaths?.length ?? 0) > 0 &&
    (item.tags ?? []).every((t) => t.kind === 'image' || t.kind === 'file')
  )
}

/** One record of a compaction: its summary, or (Claude) the boundary or the
 *  idle notice written beside it. */
export function isCompactionPart(item: TranscriptItem): boolean {
  return item.role === 'system' && item.systemKind === 'compaction'
}

/** Whether `part` belongs to the compaction note `note` already holds: both are
 *  compaction parts and the note lacks what `part` brings. A second summary,
 *  boundary or notice starts a note of its own. */
export function foldsIntoCompaction(note: TranscriptItem, part: TranscriptItem): boolean {
  if (!isCompactionPart(note) || !isCompactionPart(part)) return false
  const boundary = (item: TranscriptItem) =>
    item.compaction?.trigger !== undefined || item.compaction?.preTokens !== undefined
  if (part.text && note.text) return false
  if (boundary(part) && boundary(note)) return false
  if (part.compaction?.idle && note.compaction?.idle) return false
  return true
}

/** The note with `part` folded in. The note keeps its id and time (the first
 *  record of the compaction); summary text and metadata come from whichever
 *  record carries them. */
export function foldCompaction(note: TranscriptItem, part: TranscriptItem): TranscriptItem {
  const compaction = { ...note.compaction, ...part.compaction }
  return {
    ...note,
    text: note.text || part.text,
    ...(Object.keys(compaction).length ? { compaction } : {}),
  }
}

/**
 * Collapse the raw item stream into renderable blocks: tool results fold into
 * their originating tool call; a media-marker user item folds its paths into
 * the preceding user block; the records of one compaction fold into one note;
 * everything else passes through in order.
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
      // No preceding user turn to fold into (window seam). An IMAGE still earns
      // a turn of its own — the operator uploaded a picture and they want to see
      // it. A marker that is NOTHING BUT file chips does not: it says nothing the
      // reader can use, and standing alone it claims a turn the operator never
      // took, which is the bug this fold exists to close (POD-1171). Tested for
      // narrowly — a tag-less item keeps its old standalone rendering.
      const tags = item.tags ?? []
      if (!(tags.length > 0 && tags.every((t) => t.kind === 'file'))) blocks.push({ item })
      continue
    }
    const prev = blocks[blocks.length - 1]
    if (prev && foldsIntoCompaction(prev.item, item)) {
      prev.item = foldCompaction(prev.item, item)
      continue
    }
    if (item.role === 'tool' && item.toolResult !== undefined && item.toolUseId) {
      const call = callByToolUseId.get(item.toolUseId)
      if (call) {
        call.result = item.toolResult
        if (item.toolEffects) call.item = { ...call.item, toolEffects: item.toolEffects }
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
  return blocks.map(presentToolBlock)
}

/**
 * Tools that ADDRESS THE HUMAN, and so can never fold into a summary line.
 *
 * AskUserQuestion (the agent prompting the human → interactive card) and
 * SendUserFile (the agent surfacing images/files → inline previews + lightbox)
 * are the two the Claude parser names outright. The rest of this list exists
 * because only `claude.ts` has an interactive-tool branch at all: a Codex, Grok,
 * Cursor or OpenCode session — or ANY harness reaching the human through an MCP
 * server — produces an ordinary tool item, which used to batch into "Ran a tool"
 * and read, correctly, as the chat showing nothing at all. See
 * {@link isInteractiveTool}.
 */
const INTERACTIVE_TOOL_NAMES = new Set([
  'AskUserQuestion',
  'SendUserFile',
  'ExitPlanMode',
  'ElicitInput',
])

/** Name shapes that mean "this call went to the operator and waited". Matched
 *  against the BARE tool name (MCP server prefix already stripped), so
 *  `mcp__impeccable__interview` and a native `elicit_input` both qualify. */
const INTERACTIVE_TOOL_RE =
  /^(?:ask|elicit|interview|prompt|confirm|request)[_-]?(?:user|human|input|question|choice)?/i

/**
 * Does this tool call address the human? Such a call is never folded and never
 * anonymous — whatever the harness, whatever the server it came from.
 */
export function isInteractiveTool(item: TranscriptItem): boolean {
  const name = item.toolName
  if (!name) return false
  if (INTERACTIVE_TOOL_NAMES.has(name)) return true
  return INTERACTIVE_TOOL_RE.test(mcpParts(name)?.tool ?? name)
}

/** Shared classification of one transcript item revision. Display mail still
 * depends on the paired result, so only the parsed command belongs here. */
export interface TranscriptActivityFacts {
  readonly envelopes: ParsedEnvelopeBatch | null
  readonly mailCommand: MailCommand | null
  readonly quietNote: boolean
  readonly stretch: boolean
  readonly eventCount: number
}

type ActivityInputs = Pick<
  TranscriptItem,
  'role' | 'text' | 'toolName' | 'toolInput' | 'toolInputJson'
>
interface ActivityRevision extends ActivityInputs {
  readonly facts: TranscriptActivityFacts
}

// Keys are item revisions, never IDs: released records and old revisions are
// collectible. The input guard also invalidates callers that edit an item in place.
const activityRevisions = new WeakMap<TranscriptItem, ActivityRevision>()
const NO_ACTIVITY: TranscriptActivityFacts = {
  envelopes: null,
  mailCommand: null,
  quietNote: false,
  stretch: false,
  eventCount: 1,
}
const TOOL_ACTIVITY: TranscriptActivityFacts = { ...NO_ACTIVITY, stretch: true }

export function transcriptActivityFacts(item: TranscriptItem): TranscriptActivityFacts {
  if (item.role !== 'user' && (item.role !== 'tool' || item.toolName !== 'Bash'))
    return item.role === 'tool' && !isInteractiveTool(item) ? TOOL_ACTIVITY : NO_ACTIVITY
  const held = activityRevisions.get(item)
  if (
    held &&
    held.role === item.role &&
    held.text === item.text &&
    held.toolName === item.toolName &&
    held.toolInput === item.toolInput &&
    held.toolInputJson === item.toolInputJson
  )
    return held.facts
  const envelopes = item.role === 'user' ? parseEnvelopeBatch(item.text) : null
  const mailCommand = readToolMailCommand(item)
  const quietNote =
    envelopes !== null &&
    envelopes.operatorText === '' &&
    envelopes.envelopes.length > 0 &&
    !envelopes.envelopes.some(isOperatorQuestion)
  const facts: TranscriptActivityFacts = {
    envelopes,
    mailCommand,
    quietNote,
    stretch: (item.role === 'tool' && !isInteractiveTool(item)) || quietNote,
    eventCount: envelopes?.envelopes.length ?? 1,
  }
  activityRevisions.set(item, {
    role: item.role,
    text: item.text,
    toolName: item.toolName,
    toolInput: item.toolInput,
    toolInputJson: item.toolInputJson,
    facts,
  })
  return facts
}

/**
 * A tool call quiet enough to fold into a batch — i.e. anything that isn't
 * addressing the human, and isn't the agent's own mail (POD-2146).
 */
export function isBatchableTool(item: TranscriptItem): boolean {
  return item.role === 'tool' && !isInteractiveTool(item) && toolMailCommand(item) === null
}

/**
 * Podium mail with no human text and no question addressed to the operator.
 * Questions between agents stay with the other quiet activity.
 */
export function isQuietNote(item: TranscriptItem): boolean {
  return transcriptActivityFacts(item).quietNote
}

/**
 * ONE STRETCH OF QUIET ACTIVITY (POD-2286). Neighbouring tool calls, the
 * agent's own mail and the notes it received fold into one line ("Ran 5
 * commands, read 6 notes"), so a busy stretch takes one line between two
 * messages instead of a column of them.
 */
export function isStretchItem(item: TranscriptItem): boolean {
  return transcriptActivityFacts(item).stretch
}

/**
 * THE AGENT'S OWN MAIL (POD-2146): the `podium mail send|reply|inbox` a shell
 * call ran, which the chat shows as a "Note to X" card or a "Read N notes" row
 * instead of a command. Pure; a call that never names podium mail costs two
 * substring checks. Callers decide once per item (the graph when it sets an
 * item, {@link presentToolBlock} when it builds a block).
 */
export function toolMailCommand(item: TranscriptItem): MailCommand | null {
  return transcriptActivityFacts(item).mailCommand
}

function readToolMailCommand(item: TranscriptItem): MailCommand | null {
  if (item.role !== 'tool' || item.toolName !== 'Bash') return null
  const text = item.toolInputJson ?? item.toolInput ?? ''
  if (!text.includes('podium') || !text.includes('mail')) return null
  const command = shellCommand(item)
  return command === undefined ? null : classifyMailCommand(command)
}

/** A sent note's line in a script listing. */
function noteLine(mail: Exclude<MailCommand, { op: 'inbox' }>, to: string): string {
  const name = `Note to ${principalShortName(to)}`
  return mail.preview ? `${name} · ${mail.preview}` : name
}

/** The calls a Codex script listed (`kind: 'script-calls'`), a mail call
 *  whose receipt the script's output unambiguously carries named as its note.
 *  A failed script, or a call whose receipt it cannot place, keeps its shell
 *  line. */
function scriptCallLines(
  item: TranscriptItem,
  result: string | undefined,
): ScriptCallLine[] | undefined {
  if (!item.toolInputJson) return undefined
  let calls: unknown
  try {
    const payload: unknown = JSON.parse(item.toolInputJson)
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('kind' in payload) ||
      payload.kind !== 'script-calls'
    )
      return undefined
    calls = 'calls' in payload ? payload.calls : undefined
  } catch {
    return undefined
  }
  if (!Array.isArray(calls)) return []
  const lines = calls.flatMap((call: unknown): ScriptCallLine[] => {
    if (!call || typeof call !== 'object' || !('tool' in call) || typeof call.tool !== 'string')
      return []
    return [
      {
        tool: call.tool,
        input: 'input' in call && typeof call.input === 'string' ? call.input : '',
      },
    ]
  })
  if (toolVerdict(result, item.toolEffects) === 'err' || !result) return lines
  const receipts = mailReceipts(result)
  if (receipts.length === 0) return lines
  // Per-call output is merged, so a receipt is only that call's when nothing
  // else could own it: exactly one call and exactly one receipt with its kind
  // and recipient. Two sends to one recipient where one failed stay shell lines.
  const mails = lines.map((line) => (line.tool === 'Bash' ? classifyMailCommand(line.input) : null))
  const callKey = (mail: MailCommand | null): string | undefined =>
    mail?.op === 'send' ? `send\0${mail.to}` : mail?.op === 'reply' ? 'reply' : undefined
  const receiptKey = (r: MailReceipt): string | undefined =>
    r.op === 'reply' ? 'reply' : r.to ? `send\0${mailRecipientLabel(r.to)}` : undefined
  const tally = (keys: (string | undefined)[]): Map<string | undefined, number> => {
    const counts = new Map<string | undefined, number>()
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
    return counts
  }
  const callCounts = tally(mails.map(callKey))
  const receiptCounts = tally(receipts.map(receiptKey))
  return lines.map((line, at) => {
    const mail = mails[at] ?? null
    const key = callKey(mail)
    if (!mail || mail.op === 'inbox' || key === undefined) return line
    if (callCounts.get(key) !== 1 || receiptCounts.get(key) !== 1) return line
    const receipt = receipts.find((r) => receiptKey(r) === key)
    const to =
      mail.op === 'send' ? mail.to : receipt?.to ? mailRecipientLabel(receipt.to) : 'the sender'
    return { tool: 'Mail', input: noteLine(mail, to) }
  })
}

/** The mail a lone call sent or read, or undefined when it failed or is not
 *  mail: once there is output, a send must carry its receipt. */
function toolMail(item: TranscriptItem, result: string | undefined): ToolMail | undefined {
  const mail = toolMailCommand(item)
  if (!mail || toolVerdict(result, item.toolEffects) === 'err') return undefined
  if (mail.op === 'inbox') {
    const notes = result ? countInboxNotes(result) : undefined
    return notes === undefined ? { op: 'inbox' } : { op: 'inbox', notes }
  }
  const receipt = result ? mailReceipts(result)[0] : undefined
  if (result?.trim() && !receipt) return undefined
  const to =
    mail.op === 'send' ? mail.to : receipt?.to ? mailRecipientLabel(receipt.to) : 'the sender'
  return {
    op: 'note',
    to,
    ...(receipt ? { id: receipt.id } : {}),
    ...(mail.preview ? { preview: mail.preview } : {}),
  }
}

/** A tool block with what its row shows precomputed (POD-2146): the mail it
 *  sent or read, and a script's call list. Computed once per block in the
 *  compute path, so the result crosses a worker as plain data. */
export function presentToolBlock(block: ChatBlock): ChatBlock {
  const { item } = block
  if (item.role !== 'tool') return block
  const result = block.result ?? item.toolResult
  if (item.toolName === 'Script') {
    const scriptCalls = scriptCallLines(item, result)
    return scriptCalls ? { ...block, scriptCalls } : block
  }
  const mail = toolMail(item, result)
  return mail ? { ...block, mail } : block
}

/** The full command a shell call ran: the retained `shell-command` payload, or
 *  the input preview older records and other harnesses keep it in. */
function shellCommand(item: TranscriptItem): string | undefined {
  if (item.toolInputJson) {
    try {
      const payload: unknown = JSON.parse(item.toolInputJson)
      if (
        payload &&
        typeof payload === 'object' &&
        'kind' in payload &&
        payload.kind === 'shell-command' &&
        'command' in payload &&
        typeof payload.command === 'string'
      )
        // A truncated command may have lost what follows the send.
        return 'truncated' in payload && payload.truncated ? undefined : payload.command
    } catch {
      // Fall back to the preview below.
    }
  }
  return item.toolInput
}

/**
 * Split an MCP tool id into its server and tool halves.
 *
 * MCP names arrive as `mcp__<server>__<tool>` and used to fall through every
 * switch in this file to the default arm, so a whole class of calls rendered as
 * "Ran a tool" with no server, no verb and no object. Returns null for an
 * ordinary native tool name.
 */
export function mcpParts(toolName: string): { server: string; tool: string } | null {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName)
  if (!m) return null
  const [, server, tool] = m
  if (!server || !tool) return null
  return { server, tool }
}

/** Human-facing label for an MCP tool: `mcp__claude_ai_Gmail__send` →
 *  "Gmail · send". Underscores become spaces so the tool half reads as words. */
export function mcpLabel(toolName: string): string | null {
  const parts = mcpParts(toolName)
  if (!parts) return null
  const server = parts.server.split('_').filter(Boolean).pop() ?? parts.server
  return `${server} · ${parts.tool.replace(/_/g, ' ')}`
}

/** A stretch of neighbouring commands and notes, folded under one summary. */
export interface ActivityStretchRow {
  kind: 'tools'
  blocks: ChatBlock[]
  /** Each child's index in the flat ChatBlock[] — lets search map a hit to its row. */
  blockIndices: number[]
  title: string
  /** The folded face's count-only line ("Ran 4 commands"); `title` names subjects. */
  summary?: string
}
/** Source compatibility for consumers of the existing tools-row API. */
export type ToolBatchRow = ActivityStretchRow
/** Anything that isn't a quiet tool call: prose, prompts, the AskUserQuestion card. */
export interface SingleRow {
  kind: 'block'
  block: ChatBlock
  blockIndex: number
}
export type ChatRow = SingleRow | ActivityStretchRow

/** One delivered transcript item can hold several notes. Count the notes. */
export function toolActivityCount(item: TranscriptItem): number {
  return transcriptActivityFacts(item).eventCount
}

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
      ...toolBatchTitles(run.blocks),
    })
    run = null
  }
  blocks.forEach((block, i) => {
    if (isStretchItem(block.item)) {
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
export function toolCategory(item: TranscriptItem): { verb: string; noun: string } {
  if (item.role === 'user') return { verb: 'Read', noun: 'note' }
  const mail = toolMailCommand(item)
  if (mail)
    return mail.op === 'inbox' ? { verb: 'Checked', noun: 'inbox' } : { verb: 'Sent', noun: 'note' }
  switch (item.toolName) {
    case 'Read':
    case 'NotebookRead':
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
    case 'Agent':
      return { verb: 'Delegated', noun: 'agent' }
    case 'Grep':
    case 'Glob':
      return { verb: 'Searched', noun: 'search' }
    case 'list_dir':
    case 'list_directory':
      return { verb: 'Listed', noun: 'directory' }
    case 'WebSearch':
      return { verb: 'Searched the web', noun: 'search' }
    case 'WebFetch':
      return { verb: 'Fetched', noun: 'page' }
    case 'TodoWrite':
      return { verb: 'Updated', noun: 'todo list' }
    default:
      // An MCP call is named by its server, never counted as "a tool" — the
      // default arm used to swallow every MCP name whole (see mcpParts).
      if (item.toolName && mcpParts(item.toolName))
        return { verb: 'Used', noun: mcpParts(item.toolName)?.server ?? 'tool' }
      return { verb: 'Ran', noun: 'tool' }
  }
}

/** How much of one subject a collapsed line can afford before it starts
 *  crowding out the ones after it. */
const SUBJECT_MAX = 30
/** Subjects named per clause before the rest become a "+n" tail. */
const SUBJECTS_PER_CLAUSE = 2
/** The whole collapsed phrase's budget — past this the last clause elides. */
const PHRASE_MAX = 78

const shorten = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`

/**
 * THE OBJECT OF THE VERB (POD-376) — what a single tool call was actually about,
 * named the way the operator would name it.
 *
 * This is the whole point of the work line's rewrite. The batch title used to
 * tally verbs and discard objects ("Ran a tool, read a file, ran 2 commands"),
 * which is a sentence about grammar rather than about the repository. Every
 * field read here was already on the item; none of it is new data.
 *
 * Returns undefined when the call genuinely has no nameable subject, so the
 * caller can fall back to counting rather than print an empty clause.
 */
export function toolSubject(item: TranscriptItem, max: number = SUBJECT_MAX): string | undefined {
  // `max` exists because the same sentence serves two places with different
  // room. Batch titles pack several subjects onto one line and cap each;
  // live work lines and unfolded rows pass Infinity so CSS clips only at the
  // actual column edge.
  // A note is counted, not named: its sender and subject are its own row's.
  if (item.role === 'user' || toolMailCommand(item)) return undefined
  const name = item.toolName
  // A path-bearing call is named by its file, always — the basename, since the
  // full path is one disclosure away in the expanded row.
  const path = item.toolPaths?.[0]
  if (path && name !== 'Bash') {
    const base = machinePathBasename(path)
    if (base) return shorten(base, max)
  }
  if (name && mcpParts(name)) {
    const label = mcpLabel(name)
    if (label) return shorten(label, max)
  }
  // Bash prefers the COMMAND (toolInput) over the agent's description
  // (toolTitle): the command is the object, it is verifiable, and its first
  // tokens survive truncation as the meaningful part. The description still
  // wins when no command was captured, and still owns the expanded row.
  // First line only — heredocs and multi-line scripts would otherwise drag a
  // paragraph onto a one-line summary.
  const raw =
    (name === 'Bash' ? (item.toolInput ?? item.toolTitle) : (item.toolTitle ?? item.toolInput)) ??
    ''
  const first = raw.split('\n', 1)[0]?.trim() ?? ''
  if (!first) return undefined
  if (name !== 'Bash') return shorten(first, max)
  // A command speaks for itself and reads as the code it is. The agent's
  // DESCRIPTION of a command does not, so it keeps the quotes it has always had
  // — otherwise "Ran render the mockups to PNG" reads as a shell invocation
  // that was never typed.
  if (item.toolInput) return shorten(significantCommand(first), max)
  return `"${shorten(first, max - 2)}"`
}

/** Leading `cd <somewhere> ;` / `&&` — preamble, not the command. */
const CD_PREAMBLE_RE = /^cd\s+[^;&|]+(?:;|&&)\s*/i
/** Leading `VAR=value ` environment assignments — also preamble. */
const ENV_PREAMBLE_RE = /^[A-Za-z_][\w]*=(?:"[^"]*"|'[^']*'|\S*)\s+/

/**
 * The part of a shell command a reader is actually looking for.
 *
 * A one-line summary truncates at thirty characters, and agents habitually
 * prefix commands with a `cd` into the worktree and a run of environment
 * assignments — so the whole budget went to preamble and the row read
 * "Ran cd /home/podium/podium; WT=/t…" or, worse, started mid-variable:
 * "Running S=/tmp/claude-1000/-home-podi…". Strip the preamble and the
 * remaining text is the command that ran.
 *
 * Falls back to the original whenever stripping would leave nothing, so a bare
 * `cd somewhere` still names itself rather than vanishing.
 */
export function significantCommand(command: string): string {
  let out = command.trim()
  // Loop: `cd x && FOO=1 BAR=2 bun test` is all four shapes in sequence.
  for (let i = 0; i < 8; i++) {
    const stripped = out.replace(CD_PREAMBLE_RE, '').replace(ENV_PREAMBLE_RE, '')
    if (stripped === out) break
    if (stripped.trim() === '') return out
    out = stripped.trim()
  }
  return out || command.trim()
}

const pluralizeNoun = (noun: string): string =>
  /(?:s|x|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`
const articleFor = (noun: string): string => (/^[aeiou]/i.test(noun) ? 'an' : 'a')
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)
const clauseFor = (verb: string, noun: string, count: number): string =>
  noun === 'inbox'
    ? `${verb} the inbox${count > 1 ? ` ${count} times` : ''}`
    : count === 1
      ? `${verb} ${articleFor(noun)} ${noun}`
      : `${verb} ${count} ${pluralizeNoun(noun)}`

/**
 * Smart one-line summary for a tool batch — clauses per tool kind in first-
 * appearance order, the first capitalized and the rest lowercased.
 *
 * ---------------------------------------------------------------------------
 * IT NAMES THE OBJECT, NOT JUST THE VERB (POD-376)
 * ---------------------------------------------------------------------------
 *
 * This line used to read "Ran a tool, read a file, ran 2 commands" — a tally of
 * grammatical kinds, from which no reader could tell which file, which command,
 * or whether their repository had changed. It now reads
 * "Read ChatView.tsx, TranscriptFeed.tsx +4, ran bun test".
 *
 * The row is the same height and folds the same way; the reduction the fold buys
 * is untouched. What changed is that the surviving text is specific. Where a
 * clause has no nameable subject at all it falls back to the old counting form,
 * so a transcript with sparse inputs degrades to what it printed before rather
 * than to nothing.
 */
export function toolBatchTitle(blocks: ChatBlock[]): string {
  return toolBatchTitles(blocks).title
}

/**
 * The named title and the count-only summary a folded run shows ("Ran 4
 * commands", POD-2076), from ONE walk of the run: the calm transcript keeps
 * the named title for the tooltip and the unfolded rows.
 */
export function toolBatchTitles(blocks: ChatBlock[]): { title: string; summary: string } {
  const order: string[] = []
  const tally = new Map<string, { verb: string; noun: string; subjects: string[]; count: number }>()
  for (const b of blocks) {
    const { verb, noun } = toolCategory(b.item)
    const key = `${verb}|${noun}`
    const subject = toolSubject(b.item)
    const count = toolActivityCount(b.item)
    const entry = tally.get(key)
    if (entry) {
      entry.count += count
      if (subject) entry.subjects.push(subject)
    } else {
      tally.set(key, { verb, noun, subjects: subject ? [subject] : [], count })
      order.push(key)
    }
  }

  const clauses = order.map((key) => {
    const { verb, noun, subjects, count } = tally.get(key)!
    // DEDUPE FIRST. An agent re-reading one file four times produced "Read
    // AgentPanel.tsx, AgentPanel.tsx +2", which spends the line's whole budget
    // saying one name twice. Distinct names are the information; the count
    // already carries how much happened.
    const distinct = [...new Set(subjects)]
    return { verb, noun, subjects: distinct.slice(0, SUBJECTS_PER_CLAUSE), count }
  })
  return {
    title: toolBatchTitleFromClauses(clauses),
    summary: toolBatchTitleFromClauses(clauses.map((clause) => ({ ...clause, subjects: [] }))),
  }
}

export interface ToolTitleClause {
  verb: string
  noun: string
  subjects: readonly string[]
  count: number
}

/** Clauses may be demanded from a retained tally. Stop at the display budget. */
export function toolBatchTitleFromClauses(clauses: Iterable<ToolTitleClause>): string {
  let phrase = ''
  for (const { verb, noun, subjects: shown, count } of clauses) {
    // The tail counts every CALL the clause covers, not the names dropped from
    // it, so "+2" never under-reports a run that mixed named and unnamed calls
    // — and repeated work on one file still shows up in the total.
    const rest = count - shown.length
    const clause =
      shown.length === 0
        ? clauseFor(verb, noun, count)
        : `${verb} ${shown.join(', ')}${rest > 0 ? ` +${rest}` : ''}`
    phrase += phrase ? `, ${lowerFirst(clause)}` : clause
    if (phrase.length > PHRASE_MAX) return shorten(phrase, PHRASE_MAX)
  }
  return phrase
}

// Tool → the present-participle phrase shown on a LIVE work line, which names
// what the agent is doing right now rather than what it has done ("Editing
// ChatView.tsx"). Past-tense counting is the settled row's job (toolBatchTitle).
function toolGerund(toolName: string | undefined): string {
  switch (toolName) {
    case 'Read':
    case 'NotebookRead':
      return 'Reading'
    case 'Write':
      return 'Writing'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'Editing'
    case 'Bash':
      return 'Running'
    case 'Task':
      return 'Delegating to'
    case 'Grep':
    case 'Glob':
      return 'Searching'
    case 'list_dir':
    case 'list_directory':
      return 'Listing'
    case 'WebFetch':
      return 'Fetching'
    case 'WebSearch':
      return 'Searching the web for'
    case 'TodoWrite':
      return 'Updating'
    default:
      return 'Running'
  }
}

/**
 * What the work line says while a run is still going: the call in flight, named
 * the way the operator would name it. Prefers the file the call touches (its
 * basename — the full path is in the expanded row), then the agent's own
 * one-line description, then the raw input preview. With no target at all it
 * falls back to the tool's own name so the line is never empty.
 */
export function toolCallPhrase(item: TranscriptItem): string {
  const target = toolSubject(item, Number.POSITIVE_INFINITY)
  // An MCP call names its server as the subject already ("Gmail · send"), so a
  // gerund in front of it would read as "Running Gmail · send".
  if (target && item.toolName && mcpParts(item.toolName)) return `Using ${target}`
  const gerund = toolGerund(item.toolName)
  if (!target) return `${gerund} ${item.toolName ?? 'a tool'}`
  return `${gerund} ${target}`
}

/**
 * Wall-clock span of a tool run, in ms, from the first call's timestamp to
 * `nowMs` while it is still live — or to the last call's timestamp once it has
 * settled, which is a LOWER BOUND (it cannot see how long the final call itself
 * took). Returns undefined when the run has no usable timestamps, so a
 * transcript without them shows no timer rather than a wrong one.
 */
export function toolRunElapsedMs(blocks: ChatBlock[], nowMs?: number): number | undefined {
  const first = blocks[0]?.item.ts
  if (first === undefined) return undefined
  const start = Date.parse(first)
  if (Number.isNaN(start)) return undefined
  let end: number
  if (nowMs !== undefined) end = nowMs
  else {
    const last = blocks[blocks.length - 1]?.item.ts
    if (last === undefined) return undefined
    end = Date.parse(last)
    if (Number.isNaN(end)) return undefined
  }
  return Math.max(0, end - start)
}

/** How many calls in a run failed — surfaced on the COLLAPSED work line, because
 *  a failure hidden behind a disclosure is a failure the operator never sees. */
export function toolRunFailures(blocks: ChatBlock[]): number {
  return blocks.filter(
    (b) => toolVerdict(b.result ?? b.item.toolResult, b.item.toolEffects) === 'err',
  ).length
}

/** Per-call outcome shown as a glyph on the collapsed tool row (Flat Field
 *  design, POD-159). Structured termination takes precedence; otherwise use
 *  a conservative heuristic over the result text: only patterns that
 *  reliably open real failure output flag 'err'; anything ambiguous stays
 *  'ok' so successes never read as failures. 'none' = no result captured. */
export type ToolVerdict = 'ok' | 'err' | 'none'

const TOOL_ERR_RE =
  /^\s*(?:error(?::|\b)|[A-Za-z]*Error:|exception\b|traceback \(most recent call last\)|fatal:|command failed|script failed\b|exit code [1-9]|exited with (?:code [1-9]|non-zero))/i

export function toolVerdict(
  result: string | undefined,
  effects?: TranscriptItem['toolEffects'],
): ToolVerdict {
  if (effects?.some((effect) => effect.kind === 'termination')) return 'err'
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

/**
 * The result preview an EXPANDED tool row carries (POD-376): the first non-empty
 * line, plus how many lines follow it.
 *
 * A reader who unfolded a work line has already asked for detail, and making
 * them click a second time per row to see whether a command printed anything is
 * the "third click" the teardown named. Nothing is shown for a result that is
 * empty or a single blank line, so quiet calls stay quiet.
 */
export function resultPreview(
  result: string | undefined,
): { line: string; more: number } | undefined {
  if (!result) return undefined
  const lines = result.split('\n')
  const firstIdx = lines.findIndex((l) => l.trim() !== '')
  if (firstIdx === -1) return undefined
  // Count only lines that carry something, so trailing newlines don't inflate
  // "+n more" on a one-line result.
  const more = lines.slice(firstIdx + 1).filter((l) => l.trim() !== '').length
  return { line: lines[firstIdx]!.trim(), more }
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

const STAGED_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9]{1,8}$/i

/** The attachment id a chat upload was staged under, read off its staged path
 *  (`…/uploads/<session>/<id>.<ext>`, the daemon's `uploadFilePath`). Undefined
 *  for any other path, so an agent's own files never resolve as uploads
 *  (POD-2148). */
export function stagedAttachmentId(path: string): string | undefined {
  const parts = path.split(/[\\/]/)
  if (parts.length < 3 || parts[parts.length - 3] !== 'uploads') return undefined
  return STAGED_NAME.exec(parts[parts.length - 1] ?? '')?.[1]?.toLowerCase()
}

/** Display cleanup only. Receipt correlation must keep using `item.text`.
 * Remove a leading upload path only when the matched message owns its id and
 * the remaining text is exactly the person's saved body. A path in that body,
 * including a quote of a previous upload, is always preserved. */
export function messageAttachmentText(
  item: Pick<TranscriptItem, 'id' | 'role' | 'text'>,
  message:
    | (Pick<MessageRecordWire, 'body' | 'attachments' | 'transcriptItem'> & { sessionId?: string })
    | undefined,
): string {
  if (
    item.role !== 'user' ||
    message?.transcriptItem?.id !== item.id ||
    !message.attachments?.length
  )
    return item.text
  const body = message.body.trimEnd()
  if (item.text === message.body.trim()) return item.text
  const prefix =
    body === ''
      ? item.text
      : item.text.endsWith(`\n${body}`)
        ? item.text.slice(0, -body.length - 1)
        : undefined
  if (prefix) {
    const ids = new Set(
      message.attachments.flatMap((attachment) => (attachment.id ? [attachment.id] : [])),
    )
    const ownedPaths = prefix.split('\n').every((path) => {
      const id = stagedAttachmentId(path)
      return (
        /^(?:\/|[A-Za-z]:[\\/])/.test(path) &&
        path.split(/[\\/]/).at(-2) === message.sessionId &&
        !!id &&
        ids.delete(id)
      )
    })
    if (ownedPaths) return body
  }
  // Codex can turn an image-only paste into numbered placeholders, with no
  // image tags or paths in its normalized item. A saved empty body proves
  // these are transport text rather than words the person wrote.
  if (body === '' && /^(?:\[Image #\d+\]\s*)+$/.test(item.text)) {
    const count = item.text.match(/\[Image #\d+\]/g)!.length
    if (count === message.attachments.filter((attachment) => attachment.kind === 'image').length)
      return ''
  }
  return item.text
}
