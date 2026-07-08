import type {
  AgentKind,
  ControlMessage,
  ConversationDiagnosticWire,
  ConversationSummaryWire,
  MetadataChange,
  ServerMessage,
  TranscriptItem,
} from '@podium/protocol'
import { MirrorService } from '@podium/sync'
import { fileChainSource, fileIdFor, recordToItemsForKind } from '@podium/transcript'
import type { SessionStore } from '../../store'
import { TranscriptIndexer } from '../../transcript-indexer'

const MIRROR_READ_TIMEOUT_MS = 10_000

export interface ConversationsDeps {
  store: SessionStore
  now(): number
  /** The write funnel's conversation face: oplog append → broadcast (bus + WS). */
  publish(
    rows: { id: string; value: ConversationSummaryWire }[],
    snapshot: ServerMessage,
    opts?: { snapshotToCapClients?: boolean },
  ): void
  /** The registry's shared daemon request/response plumbing. */
  daemonRequest<T>(
    pending: Map<string, (r: T) => void>,
    prefix: string,
    timeoutMs: number,
    onTimeout: () => T,
    buildMsg: (requestId: string) => ControlMessage,
    machineId?: string,
  ): Promise<T>
}

/** The session fields the lake-fallback transcript read needs. */
export interface LakeReadSession {
  machineId: string
  agentKind: AgentKind
  resume?: { value: string } | undefined
}

/**
 * Conversation index + upstream mirror + transcript lake (issue #13 Phase 2 —
 * peeled off SessionRegistry): daemon discovery pushes land here, get identity-
 * stamped into the store, and fan out; the MirrorService/TranscriptIndexer pair
 * (opt-in via `mirrorLakeDir`) keeps the lake + FTS index fed.
 */
export class ConversationsService {
  private latestConversations: ConversationSummaryWire[] = []
  private latestConversationDiagnostics: ConversationDiagnosticWire[] = []
  // Diagnostics ride the conversationsChanged snapshot, not the delta stream — track
  // their last serialization so cap clients still get a snapshot when ONLY diagnostics
  // changed (rare: scan problems), without re-sending the list on every conversation delta.
  private lastDiagnosticsBroadcast = ''
  // Entities mirrored FROM the hub this node syncs against (node-hub-sync §2.3):
  // display/read surfaces, never pushed back upstream.
  private readonly upstreamConversations = new Map<string, ConversationSummaryWire>()
  private readonly pendingMirrorReads = new Map<
    string,
    (r: { data: string; fileSize: number; eof: boolean; error?: string }) => void
  >()
  // Transcript lake mirror (docs/spec/transcript-mirror.md) — constructed only when
  // mirrorLakeDir is set; undefined means zero mirror traffic (tests default).
  private readonly mirror: MirrorService | undefined
  // Mirror-fed FTS indexer (docs/spec/search-v1.md §2.3) — exists iff the mirror does.
  private readonly transcriptIndexer: TranscriptIndexer | undefined

  constructor(
    private readonly deps: ConversationsDeps,
    options: { mirrorLakeDir?: string } = {},
  ) {
    if (options.mirrorLakeDir) {
      // The FTS indexer feeds off the mirror's chunk hooks (search-v1 §2.3) — it
      // exists only alongside the lake, and MirrorService stays indexing-free.
      const indexer = new TranscriptIndexer(this.deps.store)
      this.transcriptIndexer = indexer
      this.mirror = new MirrorService(
        this.deps.store.conversations,
        options.mirrorLakeDir,
        (machineId, req) => this.mirrorRead(machineId, req),
        this.deps.now,
        {
          onBytes: (machineId, nativeId, lakePath) =>
            indexer.onBytes(machineId, nativeId, lakePath),
          onTruncate: (machineId, nativeId) => indexer.onTruncate(machineId, nativeId),
        },
      )
    } else {
      this.mirror = undefined
      this.transcriptIndexer = undefined
    }
  }

  /** Local ∪ upstream conversations — what attach/broadcast/changesSince serve. */
  allConversations(): ConversationSummaryWire[] {
    if (this.upstreamConversations.size === 0) return this.latestConversations
    const localIds = new Set(this.latestConversations.map((c) => c.id))
    return [
      ...this.latestConversations,
      ...[...this.upstreamConversations.values()].filter((c) => !localIds.has(c.id)),
    ]
  }

  diagnostics(): ConversationDiagnosticWire[] {
    return this.latestConversationDiagnostics
  }

  /** Replace the mirrored conversation list (same pipeline as sessions). Conversations
   *  carry no machineId on the wire, so the echo filter here is id-based: a locally
   *  known conversation id wins over the hub copy. */
  setUpstreamConversations(list: ConversationSummaryWire[]): void {
    this.upstreamConversations.clear()
    const localIds = new Set(this.latestConversations.map((c) => c.id))
    for (const c of list) {
      if (localIds.has(c.id)) continue
      this.upstreamConversations.set(c.id, c)
    }
    this.broadcastConversations()
  }

  /** Hub-staleness flip rebroadcast: only meaningful while upstream entries exist. */
  rebroadcastUpstream(): void {
    if (this.upstreamConversations.size > 0) this.broadcastConversations()
  }

  /** A daemon discovery push (scanResult / conversationsChanged): index FIRST so
   *  latestConversations (and the broadcast) carry podiumId, then fan out. */
  onDiscovery(
    machineId: string,
    conversations: ConversationSummaryWire[],
    diagnostics: ConversationDiagnosticWire[],
    removed: string[] = [],
  ): void {
    this.latestConversations = this.indexConversations(conversations, machineId, removed)
    this.latestConversationDiagnostics = diagnostics
    this.broadcastConversations()
  }

  /**
   * Persist scanned conversations and attach registry identities (docs/spec/
   * conversation-registry.md §3.1): every native conversation maps to a stable
   * podium id — minted on first sight, resolved thereafter — and subagent parents
   * resolve to parent PODIUM ids. Returns the wire list enriched with `podiumId`
   * so broadcasts carry stable identity alongside the native id. Tagged with the
   * reporting machineId so a conversation is attributable to (and resumable on)
   * the machine that owns its on-disk transcript. `removed` drops conversations
   * the daemon reports as deleted (incremental delta indexing).
   */
  private indexConversations(
    conversations: ConversationSummaryWire[],
    machineId: string,
    removed: string[] = [],
  ): ConversationSummaryWire[] {
    // Parents first, so a child's mint can point at its parent's identity. A
    // parent that is itself in this batch resolves in the first loop; one that
    // isn't (child-only rescan) is ensured on demand in the second.
    const podiumIds = new Map<string, string>()
    for (const c of conversations) {
      if (c.parentConversationId) continue
      podiumIds.set(
        c.id,
        this.deps.store.conversations.ensureConversationIdentity({
          machineId,
          nativeId: c.id,
          providerId: c.providerId,
          ...(c.path ? { path: c.path } : {}),
          ...(c.sizeBytes !== undefined ? { sizeBytes: c.sizeBytes } : {}),
        }),
      )
    }
    for (const c of conversations) {
      if (!c.parentConversationId) continue
      const parentPodiumId =
        podiumIds.get(c.parentConversationId) ??
        this.deps.store.conversations.ensureConversationIdentity({
          machineId,
          nativeId: c.parentConversationId,
          providerId: c.providerId,
        })
      podiumIds.set(
        c.id,
        this.deps.store.conversations.ensureConversationIdentity({
          machineId,
          nativeId: c.id,
          providerId: c.providerId,
          parentPodiumId,
          ...(c.path ? { path: c.path } : {}),
          ...(c.sizeBytes !== undefined ? { sizeBytes: c.sizeBytes } : {}),
        }),
      )
    }
    this.deps.store.conversations.upsertConversations(
      conversations.map((c) => ({
        id: c.id,
        agentKind: c.agentKind,
        providerId: c.providerId,
        machineId,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(c.projectPath !== undefined ? { projectPath: c.projectPath } : {}),
        ...(c.resume ? { resumeKind: c.resume.kind, resumeValue: c.resume.value } : {}),
        ...(c.createdAt !== undefined ? { createdAt: c.createdAt } : {}),
        ...(c.updatedAt !== undefined ? { updatedAt: c.updatedAt } : {}),
        ...(c.messageCount !== undefined ? { messageCount: c.messageCount } : {}),
        ...(c.parentConversationId !== undefined
          ? { parentConversationId: c.parentConversationId }
          : {}),
      })),
    )
    if (removed.length) this.deps.store.conversations.deleteConversations(removed)
    // Scan trigger (transcript-mirror spec §2.3): the segments just upserted may have
    // grown/appeared — pull their new bytes into the lake. No-op without a lake dir.
    this.triggerLakeSweep(machineId)
    return conversations.map((c) => {
      const podiumId = podiumIds.get(c.id)
      return podiumId ? { ...c, podiumId } : c
    })
  }

  private broadcastConversations(): void {
    // Local ∪ upstream: hub-mirrored conversations ride the same snapshot + oplog
    // pipeline as local ones (node-hub-sync §2.3), so node clients see them live.
    const conversations = this.allConversations()
    const msg: ServerMessage = {
      type: 'conversationsChanged',
      conversations,
      diagnostics: this.latestConversationDiagnostics,
    }
    // Diagnostics don't ride the delta stream (they're scan-level, not per-entity):
    // when they changed, cap clients need the snapshot too. Applying it as a full
    // replace on the client is safe — it's built from the same state as any delta
    // in flight, and later deltas re-apply idempotently by id.
    const diagKey = JSON.stringify(this.latestConversationDiagnostics)
    const diagnosticsChanged = diagKey !== this.lastDiagnosticsBroadcast
    this.lastDiagnosticsBroadcast = diagKey
    this.deps.publish(
      conversations.map((c) => ({ id: c.id, value: c })),
      msg,
      { snapshotToCapClients: diagnosticsChanged },
    )
  }

  searchConversations(opts: { query?: string; projectPath?: string; limit?: number }) {
    return this.deps.store.conversations.searchConversations(opts)
  }

  setConversationMeta(input: { id: string; name?: string; summary?: string }): void {
    this.deps.store.conversations.setConversationMeta(input.id, input)
  }

  /** The lake maintenance pass behind every scan/attach trigger: mirror-pull the
   *  machine's DIRTY segments (spec §2.3 "Dirty-driven": reported size ≠ mirrored
   *  cursor — NOT a full sweep, which cost one daemon eof-check round trip per
   *  segment even when fully caught up) AND FTS-backfill segments whose lake copy
   *  is ahead of the index cursor. Both self-noop cheaply when caught up. On
   *  attach, before any scan, the LAST-KNOWN reported sizes persisted in the store
   *  cover the offline gap; the first scan (~15s later) refreshes them. */
  triggerLakeSweep(machineId: string): void {
    const mirror = this.mirror
    if (!mirror) return
    mirror.enqueueDirty(machineId)
    this.transcriptIndexer?.backfillMachine(machineId, (nativeId) =>
      mirror.lakePath(machineId, nativeId),
    )
  }

  /** Lake-fallback transcript read (docs/spec/search-v1.md §2.2): serve the window
   *  from the server's mirrored copy when the daemon couldn't (detached machine,
   *  pruned native file, timeout). The lake file IS the native JSONL byte-verbatim,
   *  so the harness's own record→items mapper applies unchanged. Cursors are
   *  stamped against the LAKE path's fileId, so an anchor minted by a daemon read
   *  won't match here — the slice then serves its default window, the standard
   *  drifted-anchor degradation. Resolves undefined when there is nothing mirrored
   *  (no lake, no resume value, cursor at 0, or an unparseable/empty file). */
  async readTranscriptFromLake(
    session: LakeReadSession,
    input: { anchor?: string; direction: 'before' | 'after'; limit: number },
  ): Promise<
    { items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean } | undefined
  > {
    const nativeId = session.resume?.value
    if (!this.mirror || !nativeId) return undefined
    if (this.deps.store.conversations.mirrorCursor(session.machineId, nativeId) <= 0)
      return undefined
    const path = this.mirror.lakePath(session.machineId, nativeId)
    const source = fileChainSource(
      [{ path, fileId: fileIdFor(path) }],
      recordToItemsForKind(session.agentKind),
    )
    const slice = await source.readSlice({
      ...(input.anchor ? { anchor: input.anchor } : {}),
      direction: input.direction,
      limit: input.limit,
    })
    return slice.items.length > 0 ? slice : undefined
  }

  /** One transcript-mirror ranged read against a specific machine — MirrorService's
   *  read seam. A timeout resolves an error result (never rejects), so the pull loop
   *  backs the segment off instead of hanging (docs/spec/transcript-mirror.md §2.3). */
  private mirrorRead(
    machineId: string,
    req: { path: string; offset: number; maxBytes: number },
  ): Promise<{ data: string; fileSize: number; eof: boolean; error?: string }> {
    return this.deps.daemonRequest(
      this.pendingMirrorReads,
      'mr',
      MIRROR_READ_TIMEOUT_MS,
      () => ({ data: '', fileSize: 0, eof: false, error: 'timeout' }),
      (requestId) => ({
        type: 'transcriptMirrorRead',
        requestId,
        path: req.path,
        offset: req.offset,
        maxBytes: req.maxBytes,
      }),
      machineId,
    )
  }

  /** Resolver for the daemon's transcriptMirrorResult reply. */
  onTranscriptMirrorResult(msg: {
    requestId: string
    data: string
    fileSize: number
    eof: boolean
    error?: string
  }): void {
    const resolve = this.pendingMirrorReads.get(msg.requestId)
    if (resolve) {
      this.pendingMirrorReads.delete(msg.requestId)
      resolve({
        data: msg.data,
        fileSize: msg.fileSize,
        eof: msg.eof,
        ...(msg.error !== undefined ? { error: msg.error } : {}),
      })
    }
  }
}
