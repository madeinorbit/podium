import type { SessionId, TranscriptItem } from '@podium/model'

export {
  dedupeTranscriptItems,
  freshOlderTranscriptPage,
  mergeTranscriptFrame,
  prependTranscriptItems,
  reconcileTranscriptSnapshot,
  sameTranscriptItem,
  sameTranscriptItems,
} from './merge'

export type TranscriptFreshness = 'checking' | 'rendering' | 'saved' | null

export interface TranscriptPage {
  reset?: boolean
  items: TranscriptItem[]
  head?: string
  tail?: string
  hasMore: boolean
  /** The session's machine is offline; this page is the best the server could
   *  do without it (POD-4808). Present even when items are present (mirrored
   *  history) so a live-looking session still names its machine, and present
   *  on an empty page so it does not read as "done". */
  offline?: { machineName: string }
}

export interface TranscriptReadRequest {
  sessionId: SessionId
  anchor?: string
  /** 'after' reads the messages following `anchor` — a reopened chat's delta. */
  direction: 'before' | 'after'
  limit: number
}

export interface TranscriptSource {
  read(request: TranscriptReadRequest): Promise<TranscriptPage>
  subscribe(
    sessionId: SessionId,
    since: string | undefined,
    listener: (items: TranscriptItem[], meta: { reset: boolean }) => void,
  ): () => void
}

export interface TranscriptCacheEntry {
  /** Oldest first. */
  items: TranscriptItem[]
  /** When these were written — the "as of <time>" an offline chat is shown with. */
  savedAt: number
  /** The device holds messages older than these. */
  hasOlder?: boolean
}

export interface TranscriptCacheWriteOptions {
  /** The window no longer continues what was stored (an authoritative reset). */
  replace?: boolean
}

/**
 * The chat history kept on the device (POD-5801), as a transcript sees it.
 *
 * Reads are async: a transcript paints what memory already holds while one is
 * pending, and never blocks the live stream on it. Writes are coalesced by the
 * implementation, so `write` takes the window LAZILY — the newest window is read
 * when the write actually lands, not on every streamed frame.
 */
export interface TranscriptCache {
  /** The newest stored page of a chat. */
  load(sessionId: SessionId, limit: number): Promise<TranscriptCacheEntry | undefined>
  /** Stored messages older than the held item `beforeId`. Empty when the device has none. */
  loadBefore(
    sessionId: SessionId,
    beforeId: string,
    limit: number,
  ): Promise<TranscriptCacheEntry | undefined>
  write(
    sessionId: SessionId,
    window: () => readonly TranscriptItem[],
    options?: TranscriptCacheWriteOptions,
  ): void
  /** The chat is open or warm until the returned release: no clean-up may remove it. */
  hold?(sessionId: SessionId): () => void
}

export interface TranscriptConnection {
  connected(): boolean
  subscribe(listener: (connected: boolean) => void): () => void
}

export interface TranscriptSourceOptions {
  sessionId: SessionId
  source: TranscriptSource
  cache?: TranscriptCache
  connection?: TranscriptConnection
  initialLimit?: number
  pageLimit?: number
  /** Whether the reader can see the transcript now. The live heartbeat skips
   *  a tick nobody would see; absent means always visible. */
  visible?: () => boolean
  /** Keep the loaded prefix during newest reads while a host is reading history.
   * An explicit source reset always replaces the transcript. */
  retainHistory?: () => boolean
  /** Earliest displayed boundary item. Following-window trimming keeps this
   * item and its suffix; unrelated older history still obeys the normal cap. */
  retainFrom?: () => string | undefined
  /** Extra maintained facts declared by the host that consumes them. */
  questions?: readonly ('userEcho' | 'latestRecordedAt')[]
}

/**
 * What the session row says about activity the transcript should be recording
 * — see {@link TranscriptLog.observeActivity}.
 */
export interface TranscriptActivity {
  /** A fingerprint of the row fields that move when the agent does anything;
   *  {@link transcriptActivitySignal} is the one every host uses. */
  signal: string
  /** The session has a process that can append to the transcript. */
  live: boolean
}

/** Trailing settle before a moved row re-reads: a working agent moves the row
 *  several times a second, and the point is to be current, not to re-read on
 *  every tick. */
export const TRANSCRIPT_ACTIVITY_SETTLE_MS = 400
/** The floor under a live transcript: one newest-item probe, escalating to a
 *  full reconcile only when the tail differs [POD-701]. */
export const TRANSCRIPT_LIVE_HEARTBEAT_MS = 6_000

/** The row fields that advance on exactly the activity a transcript records. */
export function transcriptActivitySignal(session: {
  lastActiveAt?: string | null
  busy?: boolean | null
  agentState?: { phase?: string; since?: string } | null
}): string {
  return `${session.lastActiveAt ?? ''}|${session.agentState?.phase ?? ''}|${session.agentState?.since ?? ''}|${session.busy ?? ''}`
}

export interface TranscriptState {
  sessionId: SessionId
  items: TranscriptItem[]
  latestOperatorPrompt: string | null
  pendingQuestion: TranscriptItem | null
  latestRecordedAt: number | null
  head: string | undefined
  tail: string | undefined
  hasMoreOlder: boolean
  loadingOlder: boolean
  initialLoaded: boolean
  /** A non-empty authority read established the current stream, and no reset has broken it. */
  subscriptionHealthy: boolean
  freshness: TranscriptFreshness
  offlineAsOf: number | null
  /** The session's machine is offline as of the last authority read (POD-4808).
   *  Null when the machine is online. Distinct from offlineAsOf, which is the
   *  CLIENT's own replica fallback when the server is unreachable. */
  offlineMachineName: string | null
}

export interface TranscriptRefreshOptions {
  disclose?: boolean
}
