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

export const TranscriptItem = z.object({
  /** UNBRANDED: harness-derived and, for some items, SYNTHESIZED by the daemon
   *  parser rather than minted by us — the schema says so two lines down. A
   *  transcript item is per-session detail, not a replicated entity, so it has no
   *  brand and no `MetadataEntityKind` membership. */
  id: z.string(),
  /** Opaque, daemon-defined position anchor for read-from/subscribe-since paging.
   *  Stable across re-reads of the same file bytes (unlike `id`, which is
   *  synthesized for some items). The client treats it as opaque. */
  cursor: z.string().optional(),
  role: TranscriptRole,
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
  /** Full tool input as a JSON string, set only for user-facing prompt tools
   *  (AskUserQuestion) so the chat can render an interactive question card rather
   *  than a collapsed tool row. Omitted for ordinary tools to avoid bloat. */
  toolInputJson: z.string().optional(),
  /** Truncated tool result text (set on role 'tool' result items). */
  toolResult: z.string().optional(),
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
