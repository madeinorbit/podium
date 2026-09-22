import type { TranscriptItem } from '@podium/model'

/**
 * TRANSCRIPT GRAMMAR TYPES (this issue): the mechanism-free leaf that `store/`
 * AND `adapters/` may both import (spec §5: nothing inside adapters/ imports
 * a mechanism).
 *
 * Everything here is DATA or a pure function: the `Declared<T>` section
 * wrapper, the cursor codec, the record-reader contracts, the shared poll
 * cadence, and the sqlite locator shape. No file reads, no database, no
 * slice contract — those stay in `store/` (file-chain, slice, tailer,
 * `sources/sqlite.ts`) and the inventory/driver, which adapters must never
 * reach. The dependency points one way: Store → grammar, with values flowing
 * as parameters and types flowing from this leaf.
 *
 * Moved here verbatim from `store/cursor-codec.ts`, `store/runtime.ts`,
 * `store/source.ts`, `store/tailer.ts`, `store/stat-tick.ts`,
 * `adapters/opencode/transcript.ts` and `manifest.ts`; those modules
 * re-export their share so every existing importer keeps working.
 */

// ---------------------------------------------------------------------------
// Declared<T>: a manifest capability that a harness may not implement YET.
// ---------------------------------------------------------------------------

/**
 * A manifest capability that a harness may not implement YET.
 *
 * The registry's totality forces every capability to be DECLARED; this type is
 * what lets a declaration say "not yet" out loud. That is the whole point of the
 * scheme: a new `BuiltinHarnessKind` can land with a minimal manifest — launch
 * and discovery only — and grow state, headless and transcript support in later
 * PRs, without the compiler ever letting someone forget one.
 *
 * Deliberately NOT modelled as `T | undefined` or an optional field. An optional
 * field cannot distinguish "this CLI genuinely has no headless mode" from
 * "somebody added a harness and forgot this line", so the two failure modes get
 * the same silent treatment at every call site. Requiring an explicit `reason`
 * makes the unsupported case self-documenting and makes forgetting it a type
 * error.
 *
 * Consumers MUST branch on `supported`. Degrade the feature — grey out the
 * button, skip the observer, report capabilities unknown — never substitute
 * another harness's behavior as a default.
 */
export type Declared<T> =
  | { readonly supported: true; readonly value: T }
  | { readonly supported: false; readonly reason: string }

/** Declare a capability this harness implements. */
export function supported<T>(value: T): Declared<T> {
  return { supported: true, value }
}

/**
 * Declare a capability this harness does NOT implement, and say why — the reason
 * is surfaced in diagnostics (`podium doctor`, degraded settings UI), so write it
 * for a reader deciding whether the gap is permanent or just unfinished.
 */
export function unsupported(reason: string): Declared<never> {
  return { supported: false, reason }
}

/** The declared value, or `undefined` when unsupported — for the many call sites
 *  whose degraded path is simply "don't do it". Keeps `supported` checks from
 *  sprawling without ever inventing a substitute default. */
export function declaredValue<T>(declared: Declared<T>): T | undefined {
  return declared.supported ? declared.value : undefined
}

// ---------------------------------------------------------------------------
// Cursor codec: pure identity arithmetic over TranscriptItems.
// ---------------------------------------------------------------------------

// Reserved for mapper fallbacks that file readers replace with position identity.
export const SYNTHESIZED_ITEM_ID_PREFIX = 'claude-fallback:'

export interface CursorParts {
  /** Stable id of the JSONL file this item's record lives in. */
  fileId: string
  /** Byte offset of the start of the record's line within that file. */
  offset: number
  /** The record's JSONL `uuid` if present, for drift validation; null otherwise. */
  uuid: string | null
  /** Index of this item among the items the record produced (0-based). */
  sub: number
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function encodeCursor(p: CursorParts): string {
  const json = JSON.stringify([p.fileId, p.offset, p.uuid, p.sub])
  return encodeBase64Url(json)
}

export function decodeCursor(c: string): CursorParts | null {
  if (!c) return null
  try {
    const arr = JSON.parse(decodeBase64Url(c))
    if (!Array.isArray(arr) || arr.length !== 4) return null
    const [fileId, offset, uuid, sub] = arr
    if (typeof fileId !== 'string' || typeof offset !== 'number' || typeof sub !== 'number')
      return null
    if (uuid !== null && typeof uuid !== 'string') return null
    return { fileId, offset, uuid, sub }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Record-reader contracts: pure native-record → neutral-item functions.
// ---------------------------------------------------------------------------

/** Pure parser from one harness-native record to neutral transcript items. The
 * implementations live in this package; selection belongs to the harness
 * manifest so adding a CLI never mutates a second registry here. */
export type TranscriptRecordMapper = (record: unknown) => TranscriptItem[]

/** Runtime facts observed in a harness-native transcript record. Every field is
 * optional because harnesses expose different subsets. In particular, context
 * usage is emitted only when the transcript carries both used tokens and the
 * exact context-window size; Podium does not guess model capacities. */
export interface HarnessRuntimeObservation {
  model?: string
  effort?: string
  contextUsagePercent?: number
}

/** Read one harness's native record for runtime identity/context facts. One
 *  implementation per harness lives in that harness's adapter transcript
 *  module; WHICH one applies is the manifest's answer, not a switch here —
 *  behaviour keyed on a harness belongs in that harness's declaration
 *  (`HarnessTranscript.recordRuntime`), while this reader-side contract type
 *  stays in the Store both sides may reach. */
export type TranscriptRuntimeReader = (record: unknown) => HarnessRuntimeObservation

/**
 * Extract an agent identity colour from a native record, if any. One
 * implementation per harness lives in that harness's adapter transcript
 * module; WHICH one applies is the manifest's answer (`HarnessTranscript.
 * recordColor`), resolved by the caller and passed as `recordColor` — the
 * tailer itself carries no harness default (POD-4471).
 */
export type TranscriptColorReader = (record: unknown) => string | undefined

// ---------------------------------------------------------------------------
// Shared poll cadence for transcript tails and session observers.
// ---------------------------------------------------------------------------

/** A daemon-owned cadence shared by file/DB observers whose hot path begins
 * with a cheap stat/mtime check. Subscriptions do not run immediately: callers
 * retain ownership of their existing seed/discovery read. */
export interface StatTick {
  subscribe(watcher: () => void): () => void
}

export interface SharedStatTick extends StatTick {
  stop(): void
}

// ---------------------------------------------------------------------------
// SQLite transcript locator: the Store-side address of a database session.
// ---------------------------------------------------------------------------

/**
 * One row of opencode's SQLite `part` join (message + part payloads). The type
 * lives here — next to the pure part→items mapper — so the parser package needs
 * no SQLite dependency; @podium/harness's opencode DB reader produces rows
 * of this shape and re-exports the type for compatibility.
 */
export type OpencodeMessagePartRow = {
  messageId: string
  partId: string
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  sessionId: string
  timeCreated: number
  timeUpdated: number
  messageData: string
  partData: string
}

/**
 * The Store-side address of one sqlite-backed transcript session: the locator
 * the adapter's transcript section declares and `transcriptSourceFromGrammar`
 * builds the host-only source from.
 *
 * `sessionKey` is the harness-native session id (KNOWLEDGE: which session);
 * `databasePath` is the adapter's db-path rule resolved for this session
 * (KNOWLEDGE: which store); `homeDir` is the fallback the source opens when
 * no explicit path resolved. The cursor namespace (`opencode:<session>`) is
 * derived inside the source from the key — callers never construct it.
 */
export interface SqliteTranscriptLocator {
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  sessionKey: string
  homeDir?: string
  databasePath?: string
}
