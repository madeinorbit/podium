import type { TranscriptItem, TranscriptTag } from '@podium/model'
import { safeToolEditJsonFromInput } from './tool-edit'

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

/**
 * The model that actually produced this record, if it is an assistant turn —
 * `message.model` (e.g. "claude-fable-5"). This is the OBSERVED model: it
 * resolves a spawn-time `auto` selection to the concrete id, and follows
 * mid-session `/model` switches. Claude stamps API-error placeholder records
 * with the sentinel `<synthetic>`; those aren't a real model, so they're
 * filtered here rather than at every consumer.
 */
export function claudeRecordModel(record: unknown): string | undefined {
  if (typeof record !== 'object' || record === null) return undefined
  const r = record as Record<string, unknown>
  if (r.type !== 'assistant') return undefined
  const message = r.message
  if (typeof message !== 'object' || message === null) return undefined
  const model = (message as Record<string, unknown>).model
  if (typeof model !== 'string' || model === '' || model.startsWith('<')) return undefined
  return model
}

/**
 * The reasoning-effort tier this assistant record ran at — Claude stamps it
 * top-level on assistant lines (`"effort":"medium"`). The OBSERVED counterpart
 * to the spawn-time effort request: it also covers sessions Podium never
 * spawned (CLI attach) and follows mid-session changes.
 */
export function claudeRecordEffort(record: unknown): string | undefined {
  if (typeof record !== 'object' || record === null) return undefined
  const r = record as Record<string, unknown>
  if (r.type !== 'assistant') return undefined
  return typeof r.effort === 'string' && r.effort !== '' ? r.effort : undefined
}

const IMAGE_SOURCE_MARKER_RE = /\[Image(?: #\d+)?: source: ([^\]\n]+)\]/g

/**
 * A pasted/uploaded image's file path arrives as a SEPARATE isMeta user record
 * — `[Image: source: /abs/path.png]` — following the user turn that carries
 * the image block. isMeta records are otherwise dropped (injected content),
 * but a marker-ONLY record is surfaced as a text-less user item carrying the
 * paths: the chat folds it into the preceding user block as an inline
 * thumbnail, and the server's file-relay policy allow-lists exactly the paths
 * a transcript references. Any other isMeta content stays dropped.
 */
function metaImageSourceItems(
  uuid: string | undefined,
  ts: string | undefined,
  r: Record<string, unknown>,
): TranscriptItem[] {
  if (r.type !== 'user') return []
  const message = (r.message ?? {}) as Record<string, unknown>
  const content = message.content
  let text: string
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      const b = block as Record<string, unknown> | null
      if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      else return [] // any non-text block → not a pure marker record
    }
    text = parts.join('\n')
  } else return []
  if (!/^\s*(?:\[Image(?: #\d+)?: source: [^\]\n]+\]\s*)+$/.test(text)) return []
  const paths = [...text.matchAll(IMAGE_SOURCE_MARKER_RE)].map((m) => (m[1] ?? '').trim())
  if (paths.length === 0) return []
  return [
    {
      id: uuid ?? freshId('u'),
      role: 'user',
      ts,
      text: '',
      toolPaths: paths,
      tags: paths.map((p) => ({
        kind: 'image' as const,
        ...(p.split('/').pop() ? { label: p.split('/').pop() as string } : {}),
      })),
    },
  ]
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
  if (r.isMeta === true)
    return metaImageSourceItems(
      typeof r.uuid === 'string' ? r.uuid : undefined,
      typeof r.timestamp === 'string' ? r.timestamp : undefined,
      r,
    )
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
    const subtype = typeof r.subtype === 'string' ? r.subtype : undefined
    // turn_duration carries the turn's churn time (durationMs) and no content —
    // surface it as a 'duration' item ("Churned for Xm Ys") instead of dropping it.
    if (subtype === 'turn_duration' && typeof r.durationMs === 'number') {
      return [
        {
          id: uuid ?? `dur-${ts ?? Math.random()}`,
          role: 'system',
          ts,
          text: '',
          systemKind: 'duration',
          durationMs: r.durationMs,
        },
      ]
    }
    const text = typeof r.content === 'string' ? r.content : ''
    if (!text.trim()) return []
    // away_summary is Claude Code's while-you-were-gone recap — tag it so the chat
    // renders a distinct "Recap" block rather than a generic "System" line.
    if (subtype === 'away_summary') {
      return [
        { id: uuid ?? `sys-${ts ?? Math.random()}`, role: 'system', ts, text, systemKind: 'recap' },
      ]
    }
    return [{ id: uuid ?? `sys-${ts ?? Math.random()}`, role: 'system', ts, text }]
  }
  if (r.type === 'attachment') {
    const att = (r as { attachment?: Record<string, unknown> }).attachment
    // A prompt the human sent MID-TURN is here and nowhere else (POD-1468).
    if (att?.type === 'queued_command') return queuedCommandItems(uuid, ts, att)
    // ONLY WHAT THE HUMAN ATTACHED (POD-1171). Claude Code writes many
    // `attachment` subtypes and all of them are context bookkeeping except one:
    // 'file' is a path the operator named in the composer (@mention), so it
    // belongs to their turn. The other two file-bearing subtypes are the harness
    // talking to itself — 'edited_text_file' re-attaches a file whose bytes
    // changed on disk after a tool call (Claude Code's own UI shows nothing),
    // and 'compact_file_reference' carries a path across a compaction seam.
    // Emitting those as role:'user' put an empty "You" bubble holding a file
    // chip into the feed seconds after the AGENT edited the file, which reads as
    // the human having sent it. Same call the string-content branch already
    // makes for `promptSource: 'system'`: drop it rather than render a lie.
    // Their paths need no allow-listing either — the tool_use that touched the
    // file already contributed it (see knownPathsFor).
    if (att?.type === 'file' && typeof att.filename === 'string') {
      const filename = att.filename
      return [
        {
          id: freshId(`att-${filename}`),
          role: 'user',
          ts,
          text: '',
          toolPaths: [filename],
          tags: [{ kind: 'file', label: filename.split('/').pop() ?? filename }],
        },
      ]
    }
    return []
  }
  return []
}

let fallbackCounter = 0
const freshId = (prefix: string): string => `${prefix}-${++fallbackCounter}`

// The user stopping the agent mid-run is written as a normal user turn whose only
// text is this marker. It IS a user action (role stays 'user'), but it isn't a
// chat message — flag it so the UI shows it inline and a state detector can read
// it as an interrupt rather than a typed prompt.
//
// Claude Code writes more than one wording. A plain stop is
// "[Request interrupted by user]"; stopping while a tool call is in flight is
// "[Request interrupted by user for tool use]", and that second turn arrives as
// ARRAY content (a lone text block) rather than a string, so it reaches this
// module by a different path. An exact-equality check matched only the first
// wording, which left the tool-use interrupt rendering as an ordinary "You"
// bubble and left the agent-state classifier reading the session as still
// working (POD-605). Match the stable prefix and let the suffix vary, so a
// future qualifier does not silently reopen the same hole.
const INTERRUPT_MARKER_RE = /^\[Request interrupted by user\b[^\]]*\]$/

/** True for every wording of Claude Code's stop marker. Exported because the
 *  harness classifier must agree with the parser about what an interrupt is —
 *  when the two disagreed, the feed and the state badge told different stories. */
export function isClaudeInterruptMarker(text: string): boolean {
  return INTERRUPT_MARKER_RE.test(text.trim())
}

// Claude Code injects <system-reminder> blocks INTO user turns (timestamps,
// context nudges) — sometimes prepended/appended to a real prompt, sometimes a
// turn is nothing but a reminder. They aren't user-authored, so strip them: the
// chat shows only what the user wrote, a turn that was wholly a reminder drops
// out, and the cleaned text matches the optimistic-bubble draft for reconciliation.
function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

// Pasted/uploaded images ride in as an image block plus a text marker
// `[Image: source: /abs/path.png]` (numbered `[Image #N: …]` when several).
// Harvest the paths into toolPaths — the web renders them as inline thumbnails
// and the server's file-relay policy allow-lists exactly the paths a transcript
// references — and strip the raw markers from the shown text.
function harvestImageMarkers(raw: string): { text: string; paths: string[] } {
  const paths: string[] = []
  const text = stripSystemReminders(raw)
    .replace(/\[Image(?: #\d+)?: source: ([^\]\n]+)\]/g, (_, p: string) => {
      paths.push(p.trim())
      return ''
    })
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  return { text, paths }
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
        ...(isClaudeInterruptMarker(text) ? { event: 'interrupt' as const } : {}),
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
  // Paths label the image tags in order (uploads and markers are emitted
  // pairwise).
  const { text, paths: imagePaths } = harvestImageMarkers(textParts.join('\n'))
  const imageTags = tags.filter((t) => t.kind === 'image')
  imagePaths.forEach((p, i) => {
    const tag = imageTags[i]
    const label = p.split('/').pop()
    if (tag && label && tag.label === undefined) tag.label = label
  })
  if (text || tags.length > 0) {
    items.unshift({
      id: uuid ?? freshId('u'),
      role: 'user',
      ts,
      text,
      ...(tags.length > 0 ? { tags } : {}),
      ...(imagePaths.length > 0 ? { toolPaths: imagePaths } : {}),
      ...(isClaudeInterruptMarker(text) ? { event: 'interrupt' as const } : {}),
    })
  }
  return items
}

/**
 * THE PROMPT SENT WHILE THE AGENT WAS BUSY (POD-1468). Claude Code takes a
 * prompt typed mid-turn as QUEUED INPUT and folds it into the turn already in
 * flight, so it never becomes a `type:'user'` record. It is written once, at the
 * moment the turn swallows it, as `attachment: { type: 'queued_command' }` —
 * and this parser dropped every attachment subtype but 'file', so the message
 * had no row in the feed at all.
 *
 * Two things went wrong downstream, and both are this record. The reader saw an
 * answer with no question above it. And the chat's optimistic bubble, which
 * retires only when a matching user item lands, never retired — it sat in the
 * feed's tail slot, BELOW the answers it had prompted, for as long as the turn
 * ran. A 38-minute turn left the question 38 minutes out of place.
 *
 * Only a real prompt qualifies:
 *   commandMode  'prompt' is the human's. The same record carries the harness's
 *                own background-task wakeups ('task-notification' — nine in ten
 *                of them), the queued-input twin of the `promptSource:'system'`
 *                turns `userItems` already drops for exactly this reason.
 *   origin       'human' is the operator (podium types their bytes into the PTY,
 *                so their mail arrives this way too). A 'peer' origin is another
 *                session's cross-session message: real, but not the operator, and
 *                a "You" bubble would claim it was. Absent origin is treated as
 *                human — older transcripts wrote none, and commandMode has
 *                already excluded the injected kinds by then.
 *
 * The item takes the attachment's own timestamp: the ENQUEUE moment, when the
 * human pressed send, not the later moment the turn consumed it. That is what
 * sorts the prompt back above the reply it caused.
 */
function queuedCommandItems(
  uuid: string | undefined,
  ts: string | undefined,
  att: Record<string, unknown>,
): TranscriptItem[] {
  if (att.commandMode !== 'prompt' || att.isMeta === true) return []
  const origin = att.origin as Record<string, unknown> | undefined
  if (origin?.kind !== undefined && origin.kind !== 'human') return []
  const { text, paths } = harvestImageMarkers(typeof att.prompt === 'string' ? att.prompt : '')
  if (!text && paths.length === 0) return []
  return [
    {
      id: uuid ?? freshId('u'),
      role: 'user',
      ts: typeof att.timestamp === 'string' ? att.timestamp : ts,
      text,
      ...(paths.length > 0
        ? {
            toolPaths: paths,
            tags: paths.map((path) => ({
              kind: 'image' as const,
              ...(path.split('/').pop() ? { label: path.split('/').pop() as string } : {}),
            })),
          }
        : {}),
    },
  ]
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
      const paths = toolPathsFromInput(b.input)
      const title = isAsk ? undefined : toolTitleFromInput(b.input)
      const toolInputJson = isAsk
        ? safeAskQuestionInputJson(b.input)
        : safeToolEditJsonFromInput(b.name, b.input)
      items.push({
        id: toolUseId ?? freshId('t'),
        role: 'tool',
        ts,
        text: '',
        toolName: b.name,
        toolInput: isAsk ? askQuestionPreview(b.input) : toolInputPreview(b.input),
        ...(title ? { toolTitle: title } : {}),
        ...(toolInputJson ? { toolInputJson } : {}),
        ...(toolUseId ? { toolUseId } : {}),
        ...(paths.length ? { toolPaths: paths } : {}),
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

const FILE_PATH_KEYS = [
  'file_path',
  'target_file',
  'path',
  'target_directory',
  'notebook_path',
] as const

function toolPathsFromInput(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const rec = input as Record<string, unknown>
  const out: string[] = []
  for (const k of FILE_PATH_KEYS) if (typeof rec[k] === 'string') out.push(rec[k] as string)
  // SendUserFile (and similar) surface files via a `files` array of paths — carry
  // them so the chat can render the images/files the agent sent to the user.
  if (Array.isArray(rec.files)) for (const f of rec.files) if (typeof f === 'string') out.push(f)
  return out
}

/** The agent's own one-line intent for the call — the Bash `description`, or the
 *  SendUserFile `caption`. The chat shows it instead of the raw input (a
 *  lone-command batch summary, or the caption above shared files). */
function toolTitleFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const rec = input as Record<string, unknown>
  const d = typeof rec.description === 'string' ? rec.description : rec.caption
  return typeof d === 'string' && d.trim() ? d.trim() : undefined
}

/** One-line, human-scannable summary of a tool input, biased to the fields that matter. */
export function toolInputPreview(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const i = input as Record<string, unknown>
  for (const key of [
    'command',
    'cmd',
    'file_path',
    'target_file',
    'path',
    'target_directory',
    'pattern',
    'query',
    'url',
    'description',
  ]) {
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
export function askQuestionPreview(input: unknown): string {
  if (typeof input !== 'object' || input === null) return 'AskUserQuestion'
  const qs = (input as Record<string, unknown>).questions
  const first = Array.isArray(qs) ? (qs[0] as Record<string, unknown> | undefined) : undefined
  const q = first && typeof first.question === 'string' ? first.question : undefined
  return q ? truncate(q, 160) : 'AskUserQuestion'
}

/** How much stored JSON one AskUserQuestion may spend. Generous, because option
 *  previews are legitimately large — a mockup runs to a few kB on its own. */
const ASK_INPUT_MAX = 32_000
/** Preview budgets tried in turn once a payload is over the cap, shortest last.
 *  0 removes the field. */
const PREVIEW_BUDGETS = [4000, 1200, 300, 0]

/**
 * JSON-stringify an AskUserQuestion input, capped so a pathological payload
 * can't bloat the transcript.
 *
 * The cap sheds content rather than dropping the payload, because the payload IS
 * the card: `toolInputJson` is what makes chat render an answerable question
 * instead of a collapsed tool row, so returning undefined costs the operator the
 * ability to answer at all — a far worse outcome than a shortened mockup. Option
 * previews are the heavy part and the least load-bearing, so they are trimmed
 * (then removed) first, and only a payload whose questions alone overflow gives
 * up. Returns undefined on failure.
 */
export function safeAskQuestionInputJson(input: unknown): string | undefined {
  try {
    const s = JSON.stringify(input)
    if (s === undefined) return undefined
    if (s.length <= ASK_INPUT_MAX) return s
  } catch {
    return undefined
  }
  for (const budget of PREVIEW_BUDGETS) {
    try {
      const s = JSON.stringify(withPreviewBudget(input, budget))
      if (s !== undefined && s.length <= ASK_INPUT_MAX) return s
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Copy an ask input with every option preview cut to `budget` characters (0
 *  drops the field). Anything not shaped like questions/options is passed
 *  through untouched — this is a size valve, not a validator. */
function withPreviewBudget(input: unknown, budget: number): unknown {
  if (typeof input !== 'object' || input === null) return input
  const root = input as Record<string, unknown>
  if (!Array.isArray(root.questions)) return input
  const questions = root.questions.map((q) => {
    if (typeof q !== 'object' || q === null) return q
    const question = q as Record<string, unknown>
    if (!Array.isArray(question.options)) return q
    const options = question.options.map((o) => {
      if (typeof o !== 'object' || o === null) return o
      const option = o as Record<string, unknown>
      if (typeof option.preview !== 'string') return o
      const { preview, ...rest } = option
      if (budget <= 0) return rest
      return preview.length <= budget
        ? option
        : { ...rest, preview: `${preview.slice(0, budget)}\n…` }
    })
    return { ...question, options }
  })
  return { ...root, questions }
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
