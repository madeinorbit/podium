import { AgentKind, ResumeRef, SessionIdField, TranscriptItem } from '@podium/model'
import { z } from 'zod'

// TranscriptItem (and TranscriptRole / TranscriptTag) live in @podium/model
// (POD-300). What stays here is the FRAMES: the delta stream, subscribe /
// unsubscribe, the cursor-based read, and the transcript-mirror pull.

// daemon -> server AND server -> client (identical shape). Streams newly-tailed
// transcript items as they arrive. `tail` is the cursor of the last item in this
// batch (the resume point for a late subscribe). `reset` replaces the client's
// buffer (the tailer switched files, e.g. resume rolled into a fresh transcript).
export const TranscriptDeltaMessage = z.object({
  type: z.literal('transcriptDelta'),
  sessionId: SessionIdField,
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
  sessionId: SessionIdField,
  since: z.string().optional(),
})
export type TranscriptSubscribeMessage = z.infer<typeof TranscriptSubscribeMessage>

export const TranscriptUnsubscribeMessage = z.object({
  type: z.literal('transcriptUnsubscribe'),
  sessionId: SessionIdField,
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
  sessionId: SessionIdField,
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
  sessionId: SessionIdField,
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
