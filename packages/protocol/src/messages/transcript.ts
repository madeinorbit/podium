import { z } from 'zod'
import { AgentKind, ResumeRef } from './terminal'

// ---- Transcript (structured conversation feed) ----
// Normalized, render-oriented view of the harness transcript JSONL. The daemon
// tails the file (located via hook payloads), parses each record into items,
// and streams them up; the server keeps a bounded per-session buffer for
// late-joining clients. Tool calls and their results are separate items linked
// by toolUseId — the renderer pairs them.
export const TranscriptRole = z.enum(['user', 'assistant', 'tool', 'system'])
export type TranscriptRole = z.infer<typeof TranscriptRole>

export const TranscriptTag = z.object({
  kind: z.enum(['image', 'file']),
  label: z.string().optional(),
})
export type TranscriptTag = z.infer<typeof TranscriptTag>

export const TranscriptItem = z.object({
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
  /** Pairs a tool call with its result item. */
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

// daemon -> server AND server -> client (identical shape). Streams newly-tailed
// transcript items as they arrive. `tail` is the cursor of the last item in this
// batch (the resume point for a late subscribe). `reset` replaces the client's
// buffer (the tailer switched files, e.g. resume rolled into a fresh transcript).
export const TranscriptDeltaMessage = z.object({
  type: z.literal('transcriptDelta'),
  sessionId: z.string(),
  items: z.array(TranscriptItem),
  tail: z.string().optional(),
  reset: z.boolean().optional(),
})
export type TranscriptDeltaMessage = z.infer<typeof TranscriptDeltaMessage>

// client -> server. `since` is the cursor of the last item the client already
// holds; the server streams only items after it (omitted = stream from the live
// tail / send what the server buffers).
export const TranscriptSubscribeMessage = z.object({
  type: z.literal('transcriptSubscribe'),
  sessionId: z.string(),
  since: z.string().optional(),
})
export type TranscriptSubscribeMessage = z.infer<typeof TranscriptSubscribeMessage>

export const TranscriptUnsubscribeMessage = z.object({
  type: z.literal('transcriptUnsubscribe'),
  sessionId: z.string(),
})
export type TranscriptUnsubscribeMessage = z.infer<typeof TranscriptUnsubscribeMessage>

// Unified, cursor-based transcript read (server -> daemon). One request shape for
// both the initial tail and scroll-back paging: the daemon resolves the items
// relative to an opaque `anchor` cursor. `anchor` omitted = read from the tail
// (newest) when direction is 'before', or from the head when 'after'. `direction`
// 'before' walks toward older items (scroll-to-top paging), 'after' toward newer.
// `limit` bounds the page. The server supplies the session metadata the daemon
// needs to RESOLVE the right TranscriptSource (the daemon is keyed by sessionId
// for live PTYs, but a transcript read off disk needs the harness + cwd, and the
// optional resume ref names the on-disk file / DB session): `agentKind` selects
// the source, `cwd` locates the per-cwd file bucket, `resume` (when known) names
// the specific transcript file / opencode session.
export const TranscriptReadRequestMessage = z.object({
  type: z.literal('transcriptRead'),
  requestId: z.string(),
  sessionId: z.string(),
  agentKind: AgentKind,
  cwd: z.string(),
  resume: ResumeRef.optional(),
  // Recorded segment evidence (conversation registry): the absolute transcript
  // path last observed for this conversation. Checked FIRST by the daemon's
  // locator — the cwd-derived bucket and the all-buckets sweep are fallbacks.
  pathHint: z.string().optional(),
  anchor: z.string().optional(),
  direction: z.enum(['before', 'after']),
  // Wire-level guard: the daemon reads `limit` items off disk, so bound it at the
  // boundary (positive integer, capped) — a negative/NaN/huge limit must not reach
  // the slice reader. Mirrors the bound the retired transcriptPageRequest carried.
  limit: z.number().int().positive().max(2000),
})
export type TranscriptReadRequestMessage = z.infer<typeof TranscriptReadRequestMessage>

// Reply to a TranscriptReadRequest (daemon -> server): the requested page of
// items plus the cursors that bound it. `head`/`tail` are the cursors of the
// first/last item in `items` (omitted when the page is empty), and `hasMore`
// says whether further items remain in the requested `direction` (so the client
// can stop paging at the file's head/tail).
export const TranscriptReadResultMessage = z.object({
  type: z.literal('transcriptReadResult'),
  requestId: z.string(),
  sessionId: z.string(),
  items: z.array(TranscriptItem),
  head: z.string().optional(),
  tail: z.string().optional(),
  hasMore: z.boolean(),
})
export type TranscriptReadResultMessage = z.infer<typeof TranscriptReadResultMessage>

// Transcript mirror (docs/spec/transcript-mirror.md): server-driven ranged pull of
// a native transcript file into the server's lake. `path` MUST come from recorded
// discovery evidence — the daemon refuses anything outside its discovery roots, so
// this can never act as an arbitrary file reader.
export const TranscriptMirrorReadMessage = z.object({
  type: z.literal('transcriptMirrorRead'),
  requestId: z.string(),
  path: z.string(),
  offset: z.number().int().nonnegative(),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024),
})
export type TranscriptMirrorReadMessage = z.infer<typeof TranscriptMirrorReadMessage>

export const TranscriptMirrorResultMessage = z.object({
  type: z.literal('transcriptMirrorResult'),
  requestId: z.string(),
  /** Base64 chunk read at `offset` (empty when offset >= fileSize). */
  data: z.string(),
  /** Total file size at read time — lets the server detect rewrites (shrinks). */
  fileSize: z.number().int().nonnegative(),
  /** True when offset + chunk reaches fileSize (nothing further to pull now). */
  eof: z.boolean(),
  /** Refused (outside roots) or unreadable — the server backs off, cursor untouched. */
  error: z.string().optional(),
})
export type TranscriptMirrorResultMessage = z.infer<typeof TranscriptMirrorResultMessage>
