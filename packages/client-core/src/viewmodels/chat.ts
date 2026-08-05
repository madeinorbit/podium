import type { TranscriptItem } from '@podium/model'

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

/**
 * A tool call quiet enough to fold into a batch — i.e. anything that isn't
 * addressing the human.
 */
export function isBatchableTool(item: TranscriptItem): boolean {
  return item.role === 'tool' && !isInteractiveTool(item)
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
export function toolSubject(item: TranscriptItem): string | undefined {
  const name = item.toolName
  // A path-bearing call is named by its file, always — the basename, since the
  // full path is one disclosure away in the expanded row.
  const path = item.toolPaths?.[0]
  if (path && name !== 'Bash') {
    const base = path.split('/').pop()
    if (base) return shorten(base, SUBJECT_MAX)
  }
  if (name && mcpParts(name)) {
    const label = mcpLabel(name)
    if (label) return shorten(label, SUBJECT_MAX)
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
  if (name !== 'Bash') return shorten(first, SUBJECT_MAX)
  // A command speaks for itself and reads as the code it is. The agent's
  // DESCRIPTION of a command does not, so it keeps the quotes it has always had
  // — otherwise "Ran render the mockups to PNG" reads as a shell invocation
  // that was never typed.
  if (item.toolInput) return shorten(significantCommand(first), SUBJECT_MAX)
  return `"${shorten(first, SUBJECT_MAX - 2)}"`
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
  count === 1 ? `${verb} ${articleFor(noun)} ${noun}` : `${verb} ${count} ${pluralizeNoun(noun)}`

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
  const order: string[] = []
  const tally = new Map<string, { verb: string; noun: string; subjects: string[]; count: number }>()
  for (const b of blocks) {
    const { verb, noun } = toolCategory(b.item)
    const key = `${verb}|${noun}`
    const subject = toolSubject(b.item)
    const entry = tally.get(key)
    if (entry) {
      entry.count++
      if (subject) entry.subjects.push(subject)
    } else {
      tally.set(key, { verb, noun, subjects: subject ? [subject] : [], count: 1 })
      order.push(key)
    }
  }

  const clauses = order.map((key) => {
    const { verb, noun, subjects, count } = tally.get(key)!
    // Nothing nameable in this whole clause — count it the old way.
    if (subjects.length === 0) return clauseFor(verb, noun, count)
    // DEDUPE FIRST. An agent re-reading one file four times produced "Read
    // AgentPanel.tsx, AgentPanel.tsx +2", which spends the line's whole budget
    // saying one name twice. Distinct names are the information; the count
    // already carries how much happened.
    const distinct = [...new Set(subjects)]
    const shown = distinct.slice(0, SUBJECTS_PER_CLAUSE)
    // The tail counts every CALL the clause covers, not the names dropped from
    // it, so "+2" never under-reports a run that mixed named and unnamed calls
    // — and repeated work on one file still shows up in the total.
    const rest = count - shown.length
    return `${verb} ${shown.join(', ')}${rest > 0 ? ` +${rest}` : ''}`
  })

  const phrase = clauses.map((c, i) => (i === 0 ? c : lowerFirst(c))).join(', ')
  return phrase.length <= PHRASE_MAX ? phrase : shorten(phrase, PHRASE_MAX)
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
  const target = toolSubject(item)
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
  return blocks.filter((b) => toolVerdict(b.result ?? b.item.toolResult) === 'err').length
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
