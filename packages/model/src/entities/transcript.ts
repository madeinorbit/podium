/**
 * Transcript items — relocated verbatim from `@podium/protocol`'s
 * `messages/transcript.ts` at POD-300. Field names, order and optionality are
 * unchanged; byte-identical on the wire, pinned by
 * `packages/protocol/src/messages/wire-golden.json`. The frames that carry
 * them (delta / subscribe / read / mirror) stay in protocol.
 *
 * Normalized, render-oriented view of the harness transcript JSONL. The daemon
 * tails the file (located via hook payloads), parses each record into items,
 * and streams them up; the server keeps a bounded per-session buffer for
 * late-joining clients. Tool calls and their results are separate items linked
 * by toolUseId — the renderer pairs them.
 *
 * A transcript item is per-SESSION detail: it inherits its session's scoping
 * (`docs/multi-user-readiness.md` §3.1.1 personal set) and carries no owner of
 * its own. No owner/visibility/grant/instance_id field was added; the schema is
 * flat, so those stay purely additive later (POD-1075 / POD-1071).
 */

import { z } from 'zod'

export const TranscriptRole = z.enum(['user', 'assistant', 'tool', 'system'])
export type TranscriptRole = z.infer<typeof TranscriptRole>

export const TranscriptTag = z.object({
  kind: z.enum(['image', 'file']),
  label: z.string().optional(),
})
export type TranscriptTag = z.infer<typeof TranscriptTag>

/** A bounded, discriminated account of observed tool effects, separate from intent. */
export const TranscriptToolEffect = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file-edit'),
    edit: z.object({
      kind: z.literal('file-edit'),
      path: z.string().optional(),
      mode: z.enum(['replace', 'write', 'patch']),
      hunks: z.array(
        z.object({
          path: z.string().optional(),
          oldText: z.string().optional(),
          newText: z.string().optional(),
        }),
      ),
      patch: z.string().optional(),
      added: z.number(),
      removed: z.number(),
      changedFileCount: z.number().optional(),
      moreFiles: z.number().optional(),
      unavailable: z.boolean().optional(),
      truncated: z.boolean().optional(),
    }),
    userModified: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('git-operation'),
    operation: z.object({
      commit: z
        .object({
          sha: z.string().optional(),
          kind: z.string().optional(),
          branch: z.string().optional(),
        })
        .optional(),
      branch: z.object({ ref: z.string().optional(), action: z.string().optional() }).optional(),
    }),
  }),
  z.object({ kind: z.literal('background-task'), taskId: z.string() }),
  z.object({
    kind: z.literal('termination'),
    interrupted: z.literal(true).optional(),
    timedOutAfterMs: z.number().optional(),
    interpretation: z.string().optional(),
  }),
  z.object({ kind: z.literal('unknown'), key: z.string() }),
])

/**
 * Identity contract: id is stable across re-reads of the same content and never
 * derived from item text; use the harness UUID/provider identity first, otherwise
 * record position plus item slot; cursor is an opaque position anchor consumers
 * never decode.
 *
 * The cursor producer derives fileId from the harness SESSION IDENTITY, never
 * from a storage location. It is stable for the lifetime of that session:
 * reading the same session at any path produces the same namespace. Each archived
 * generation has a distinct namespace, unequal to the live session and to other
 * generations, even when their bytes are identical.
 * fileId has a free-form encoding with no width or prefix guarantee; hashes and
 * provider-prefixed strings are valid. Consumers may compare it for equality but
 * MUST NOT decode it or infer meaning from its structure. Producers should weigh
 * length carefully: the namespace is repeated inside every cursor on every page.
 * UUID-bearing anchors survive rewrites; byte offsets are seek hints. Without a
 * UUID, position is authoritative. Paging and stream identities are distinct;
 * delta/complete consumers join through streamItemIdOf, never cursor arithmetic.
 */
export const TranscriptItem = z.object({
  /** UNBRANDED: harness-derived and, for some items, SYNTHESIZED by the daemon
   *  parser rather than minted by us — the schema says so two lines down. A
   *  transcript item is per-session detail, not a replicated entity, so it has no
   *  brand and no `MetadataEntityKind` membership. */
  id: z.string(),
  /** Opaque position anchor for read-from/subscribe-since paging. Stable across
   *  re-reads of the same bytes in the same session namespace, independent of path. */
  cursor: z.string().optional(),
  role: TranscriptRole,
  /** Reader-declared prompt eligibility for receipt matching. True identifies a
   *  recorded submit; false excludes generated entries, actions and unverified
   *  legacy formats. Absent means the reader has not classified the item.
   *  Display role alone does not establish eligibility. */
  promptEntry: z.boolean().optional(),
  /** Native submit identity carried by this recorded prompt. A terminal hook
   * must first be bound to our Enter and text before this id proves receipt. */
  harnessRef: z.lazy(() => HarnessRef).optional(),
  /** PROOF-ONLY, NEVER SHOWN (POD-4905): the program's own record that it took
   *  the prompt in `text` into its queue and has not put it in the
   *  conversation yet — Claude's `queue-operation enqueue`. The terminal
   *  driver reads it as a held receipt (spec §4 `accepted`); only the daemon's
   *  live tail produces it, and the daemon strips it before anything is
   *  displayed or leaves the machine. Never a prompt entry. */
  queued: z.boolean().optional(),
  /** PROOF-ONLY, NEVER SHOWN (POD-4887): the program's own record that it
   *  DROPPED the prompt in `text` before its conversation took it — Claude's
   *  `queue-operation remove` with `reason: "dropped_by_hook"`, or its
   *  "blocked by hook" record for an idle prompt. The terminal driver reads it
   *  as a proven "no" (spec §6.1 N2b); produced and stripped like `queued`. */
  dropped: z.boolean().optional(),
  ts: z.string().optional(), // ISO 8601
  /** Markdown body. Empty for pure tool-call items. */
  text: z.string(),
  toolName: z.string().optional(),
  /** Compact one-line preview of the tool input. */
  toolInput: z.string().optional(),
  /** Human-readable one-line summary the agent attached to the call (the Bash
   *  `description`), when present. Used for the collapsed tool-batch summary so a
   *  lone command reads as its intent rather than its shell; the chat falls back
   *  to `toolInput` when absent. */
  toolTitle: z.string().optional(),
  /** Full tool input as a JSON string, set only when the renderer needs more
   *  than the one-line preview: AskUserQuestion (the interactive card) and
   *  file-edit calls (`kind: "file-edit"` — the unfoldable diff). Omitted for
   *  ordinary tools to avoid bloat. */
  toolInputJson: z.string().optional(),
  /** Truncated tool result text (set on role 'tool' result items). */
  toolResult: z.string().optional(),
  /** Observed effects on result records; the mapper caps the whole list at 24,000. */
  toolEffects: z.array(TranscriptToolEffect).optional(),
  /** Pairs a tool call with its result item. UNBRANDED: the HARNESS's tool-use
   *  id, in the provider's namespace. */
  toolUseId: z.string().optional(),
  tags: z.array(TranscriptTag).optional(),
  /** Absolute file paths this item structurally references (tool file_path
   *  inputs and @-mention / edit / compact attachment filenames). Drives
   *  clickable file chips and the native-terminal link allow-set. */
  toolPaths: z.array(z.string()).optional(),
  /** A recognized non-conversational user *action* surfaced inline rather than as
   *  a chat bubble — the role stays its true value ('user'); this only changes how
   *  it's shown. 'interrupt' = the user stopped the agent mid-run
   *  ("[Request interrupted by user]"). Shared signal: a transcript-reading agent
   *  state detector can treat an interrupt as a user action without mistaking it
   *  for a typed prompt. */
  event: z.enum(['interrupt']).optional(),
  /** Set on the assistant text that ENDED the turn (transcript stop_reason
   *  'end_turn'/'stop_sequence') — i.e. the final, user-facing answer, as opposed
   *  to the intermediate narration the agent emits between tool calls. The UI
   *  elevates it (distinct bubble + minimap accent). Note: a *buried* answer in an
   *  intermediate block carries no transcript marker, so it can't be flagged here. */
  answer: z.boolean().optional(),
  /** Distinguishes special system items so the chat can render them apart from a
   *  generic "System" line: 'recap' = Claude Code's away/while-you-were-gone
   *  summary (subtype away_summary); 'duration' = a turn's churn time (subtype
   *  turn_duration), carried in `durationMs`. Absent on plain system messages. */
  systemKind: z.enum(['recap', 'duration']).optional(),
  /** Wall-clock duration of the turn in ms (set with systemKind 'duration'),
   *  surfaced as "Churned for Xm Ys". */
  durationMs: z.number().optional(),
})
export type TranscriptItem = z.infer<typeof TranscriptItem>

/** A proof-only item (POD-4905, POD-4887): read by the terminal driver as a
 *  receipt, never part of the conversation, never shown or sent upstream. */
export const isProofOnlyItem = (item: Pick<TranscriptItem, 'queued' | 'dropped'>): boolean =>
  item.queued === true || item.dropped === true

/**
 * WHICH TRANSCRIPT ITEM A DELIVERED MESSAGE BECAME (POD-4774).
 *
 * The daemon already pairs a typed message with the agent's own record of it to
 * prove delivery; this is that pairing, kept. Everything downstream matches a
 * message to its transcript entry by this id and never by text. `id` and
 * `cursor` are the item's own (see {@link TranscriptItem}); absent entirely
 * when the harness gave no way to identify the item — never guessed.
 */
export const TranscriptItemRef = z.object({
  id: z.string().min(1),
  cursor: z.string().optional(),
})
export type TranscriptItemRef = z.infer<typeof TranscriptItemRef>

/** The ref for an item, or undefined when it carries no usable id. */
export function transcriptItemRefOf(item: {
  id: string
  cursor?: string | undefined
}): TranscriptItemRef | undefined {
  if (!item.id) return undefined
  return { id: item.id, ...(item.cursor ? { cursor: item.cursor } : {}) }
}

/**
 * THE AGENT PROGRAM'S OWN IDS FOR A MESSAGE (POD-4841).
 *
 * Beside the transcript entry ({@link TranscriptItemRef}), a program often
 * names our message in ids of its own: the turn it opened, the prompt id its
 * hooks and records carry, the id it echoed back. Each is a way to find the
 * message in that program's history later — after a restart, by the daemon or
 * the server — without its text. Only ids the program gave for THIS message:
 * never guessed, and never an id that might name another message.
 *
 * `kind` says whose id it is and what it names; `id` is the program's value,
 * verbatim. The kinds a driver writes today are {@link HARNESS_REF_KINDS}; the
 * wire keeps `kind` an open string, so a kind a newer daemon adds reaches an
 * older server as data, never as a frame it rejects.
 */
export const HARNESS_REF_KINDS = [
  /** Codex app-server: the turn id its `turn/start` or `turn/steer` answered. */
  'codex-turn',
  /** Codex app-server: our `clientUserMessageId`, as the recorded
   *  `userMessage` item echoed it back in `clientId`. */
  'codex-client-message',
  /** Claude Code: the `prompt_id` of the prompt (the `UserPromptSubmit` hook,
   *  `promptId` on its transcript records). */
  'claude-prompt',
  /** Claude SDK: the `uuid` the user line was typed, and is recorded, under. */
  'claude-uuid',
  /** Grok: the `promptId` the prompt runs under (ACP `_meta.promptId`). */
  'grok-prompt',
  /** OpenCode: the message id the prompt is stored under. */
  'opencode-message',
  /** OpenCode: the id of the prompt's text part. */
  'opencode-part',
] as const
export type HarnessRefKind = (typeof HARNESS_REF_KINDS)[number]

export const HarnessRefEntry = z.object({
  kind: z.string().min(1).max(64),
  id: z.string().min(1).max(512),
})
export type HarnessRefEntry = z.infer<typeof HarnessRefEntry>

/** At most this many ids per message: a message has a handful, and a list
 *  that grew past this would be a driver bug, not more knowledge. */
export const HARNESS_REF_MAX = 16

export const HarnessRef = z.array(HarnessRefEntry).max(HARNESS_REF_MAX)
export type HarnessRef = z.infer<typeof HarnessRef>

/**
 * Every id in the lists, each once, in the order first seen, capped at
 * {@link HARNESS_REF_MAX}; undefined when there are none. Ids are learned at
 * different moments (the answer to a send, the record that follows it), so a
 * message's list only ever grows: nothing already known is dropped or changed.
 */
export function mergeHarnessRefs(
  ...lists: ReadonlyArray<readonly HarnessRefEntry[] | undefined>
): HarnessRef | undefined {
  const merged: HarnessRefEntry[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const entry of list ?? []) {
      if (!entry.kind || !entry.id) continue
      const key = `${entry.kind}\u0000${entry.id}`
      if (seen.has(key)) continue
      if (merged.length >= HARNESS_REF_MAX) return merged
      seen.add(key)
      merged.push({ kind: entry.kind, id: entry.id })
    }
  }
  return merged.length > 0 ? merged : undefined
}
