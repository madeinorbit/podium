import type {
  ConversationDiagnosticWire,
  ConversationId,
  ConversationSummaryWire,
} from '@podium/model'
import type { MetadataChange } from '@podium/protocol'
import type { EntityChangeSpec } from '@podium/sync'
import type { SessionStore } from '../../store'
import type { DaemonRequestPort } from '../daemon-request'
import { type LakeReadSession, TranscriptLake } from './lake'
import { MemorySearchService } from './search'
import type { MemoryReader } from './types'
import { MemoryVisibilityPolicy } from './visibility'

export type { LakeReadSession } from './lake'
export type { MemoryReader } from './types'

export interface MemoryLedger {
  commit<T>(operation: { write: () => T; changes: (result: T) => EntityChangeSpec[] }): {
    result: T
    changes: MetadataChange[]
  }
  reconcile(entity: 'conversation', rows: { id: string; value: unknown }[]): MetadataChange[]
}

export interface MemoryServiceDeps {
  store: SessionStore
  now(): number
  ledger: MemoryLedger
  onDiagnosticsChanged(diagnostics: readonly ConversationDiagnosticWire[]): void
  /** The ONE daemon-RPC correlator (POD-318) — the broker's exported port,
   *  passed straight through to the lake's ranged reads. */
  daemonRequest: DaemonRequestPort
}

/**
 * One read-side memory service: stable conversation registry, transcript lake,
 * transcript index, subagent evidence repair, and visibility-scoped omni-search.
 */
export class MemoryService {
  private latestConversations: ConversationSummaryWire[] = []
  private latestDiagnostics: ConversationDiagnosticWire[] = []
  private readonly machineByConversation = new Map<string, string>()
  private lastDiagnosticsBroadcast = JSON.stringify([])
  private readonly visibility: MemoryVisibilityPolicy
  private readonly searcher: MemorySearchService
  private readonly lake: TranscriptLake

  constructor(
    private readonly deps: MemoryServiceDeps,
    options: { mirrorLakeDir?: string } = {},
  ) {
    this.visibility = new MemoryVisibilityPolicy(deps.store)
    this.searcher = new MemorySearchService(deps.store, this.visibility)
    this.lake = new TranscriptLake(
      {
        store: deps.store.conversations,
        now: deps.now,
        daemonRequest: deps.daemonRequest,
      },
      options,
    )
    // The repair is memory-owned now, rather than a SessionStore boot side effect.
    deps.store.conversations.registry.repairSubagentSegmentPaths()
  }

  forReader(reader: MemoryReader): MemoryReaderView {
    return new MemoryReaderView(this, reader)
  }

  allConversations(): ConversationSummaryWire[] {
    return this.latestConversations
  }

  diagnostics(): ConversationDiagnosticWire[] {
    return this.latestDiagnostics
  }

  onDiscovery(
    machineId: string,
    conversations: ConversationSummaryWire[],
    diagnostics: ConversationDiagnosticWire[],
    removed: string[] = [],
  ): void {
    for (const conversation of conversations)
      this.machineByConversation.set(conversation.id, machineId)
    for (const id of removed) this.machineByConversation.delete(id)
    this.latestConversations = this.indexConversations(conversations, machineId, removed)
    this.latestDiagnostics = diagnostics
    this.broadcastDiagnostics()
  }

  private indexConversations(
    conversations: ConversationSummaryWire[],
    machineId: string,
    removed: string[],
  ): ConversationSummaryWire[] {
    const podiumIds = new Map<string, ConversationId>()
    for (const conversation of conversations) {
      if (conversation.parentConversationId) continue
      podiumIds.set(
        conversation.id,
        this.ensureConversationIdentity({
          machineId,
          nativeId: conversation.id,
          providerId: conversation.providerId,
          ...(conversation.path ? { path: conversation.path } : {}),
          ...(conversation.sizeBytes !== undefined ? { sizeBytes: conversation.sizeBytes } : {}),
        }),
      )
    }
    for (const conversation of conversations) {
      if (!conversation.parentConversationId) continue
      const parentPodiumId =
        podiumIds.get(conversation.parentConversationId) ??
        this.ensureConversationIdentity({
          machineId,
          nativeId: conversation.parentConversationId,
          providerId: conversation.providerId,
        })
      podiumIds.set(
        conversation.id,
        this.ensureConversationIdentity({
          machineId,
          nativeId: conversation.id,
          providerId: conversation.providerId,
          parentPodiumId,
          ...(conversation.path ? { path: conversation.path } : {}),
          ...(conversation.sizeBytes !== undefined ? { sizeBytes: conversation.sizeBytes } : {}),
        }),
      )
    }

    const curated = this.deps.store.conversations.index.curatedMeta()
    const enriched = conversations.map((conversation) => ({
      ...conversation,
      ...(podiumIds.get(conversation.id)
        ? { podiumId: podiumIds.get(conversation.id) as ConversationId }
        : {}),
      ...(curated.get(conversation.id) ?? {}),
    }))
    this.deps.ledger.commit({
      write: () => {
        this.deps.store.conversations.index.upsert(
          conversations.map((conversation) => ({
            id: conversation.id,
            agentKind: conversation.agentKind,
            providerId: conversation.providerId,
            machineId,
            ...(conversation.title !== undefined ? { title: conversation.title } : {}),
            ...(conversation.projectPath !== undefined
              ? { projectPath: conversation.projectPath }
              : {}),
            ...(conversation.resume
              ? { resumeKind: conversation.resume.kind, resumeValue: conversation.resume.value }
              : {}),
            ...(conversation.createdAt !== undefined ? { createdAt: conversation.createdAt } : {}),
            ...(conversation.updatedAt !== undefined ? { updatedAt: conversation.updatedAt } : {}),
            ...(conversation.messageCount !== undefined
              ? { messageCount: conversation.messageCount }
              : {}),
            ...(conversation.parentConversationId !== undefined
              ? { parentConversationId: conversation.parentConversationId }
              : {}),
          })),
        )
        if (removed.length) this.deps.store.conversations.index.delete(removed)
      },
      changes: () => [
        ...enriched.map(
          (conversation): EntityChangeSpec => ({
            entity: 'conversation',
            id: conversation.id,
            op: 'upsert',
            value: conversation,
          }),
        ),
        ...removed.map(
          (id): EntityChangeSpec => ({
            entity: 'conversation',
            id,
            op: 'remove',
          }),
        ),
      ],
    })
    this.triggerLakeSweep(machineId)
    return enriched
  }

  reconcileConversationList(): void {
    this.deps.ledger.reconcile(
      'conversation',
      this.latestConversations.map((conversation) => ({
        id: conversation.id,
        value: conversation,
      })),
    )
    this.broadcastDiagnostics()
  }

  private broadcastDiagnostics(): void {
    const key = JSON.stringify(this.latestDiagnostics)
    if (key === this.lastDiagnosticsBroadcast) return
    this.lastDiagnosticsBroadcast = key
    this.deps.onDiagnosticsChanged(this.latestDiagnostics)
  }

  searchConversations(
    reader: MemoryReader,
    opts: { query?: string; projectPath?: string; limit?: number },
  ) {
    return this.searcher.searchConversations(reader, opts)
  }

  search(reader: MemoryReader, opts: { text: string; limit?: number; now?: () => number }) {
    return this.searcher.search(reader, opts)
  }

  setConversationMeta(
    reader: MemoryReader,
    input: { id: string; name?: string; summary?: string },
  ): void {
    const current = this.latestConversations.find((conversation) => conversation.id === input.id)
    // Both come from the same `onDiscovery` push (POD-318): there is no
    // placeholder machine to fall back to any more, so a conversation with no
    // known machine is as unreadable as one that does not exist.
    const machineId = this.machineByConversation.get(input.id)
    if (
      !current ||
      !machineId ||
      !this.visibility.mayRead(reader, {
        class: 'conversation',
        machineId,
        nativeId: input.id,
      })
    ) {
      // Invisible and nonexistent are deliberately identical.
      throw new Error('conversation not found')
    }
    const next = {
      ...current,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    }
    this.deps.ledger.commit({
      write: () => this.deps.store.conversations.index.setMeta(input.id, input),
      changes: () => [
        {
          entity: 'conversation',
          id: input.id,
          op: 'upsert',
          value: next,
        },
      ],
    })
    this.latestConversations = this.latestConversations.map((conversation) =>
      conversation.id === input.id ? next : conversation,
    )
  }

  ensureConversationIdentity(
    input: Parameters<SessionStore['conversations']['registry']['ensure']>[0],
  ) {
    return this.deps.store.conversations.registry.ensure(input)
  }

  linkConversationSegment(
    input: Parameters<SessionStore['conversations']['registry']['linkSegment']>[0],
  ) {
    return this.deps.store.conversations.registry.linkSegment(input)
  }

  conversationPodiumId(
    reader: MemoryReader,
    machineId: string,
    nativeId: string,
  ): ConversationId | undefined {
    if (!this.visibility.mayRead(reader, { class: 'conversation', machineId, nativeId })) {
      return undefined
    }
    return this.deps.store.conversations.registry.podiumId(machineId, nativeId)
  }

  canReadSession(reader: MemoryReader, sessionId: string): boolean {
    return this.visibility.mayReadSession(reader, sessionId)
  }

  transcriptPathHint(
    reader: MemoryReader,
    session: { id: string; machineId: string; resume?: { value: string } },
  ): { pathHint: string } | undefined {
    if (!this.canReadSession(reader, session.id)) return undefined
    const nativeId = session.resume?.value
    return nativeId ? this.lake.pathHint(session.machineId, nativeId) : undefined
  }

  triggerLakeSweep(machineId: string): void {
    this.lake.triggerSweep(machineId)
  }

  /** Drain and pause transcript mirroring before the transfer's final snapshot. */
  pauseMirroringForTransfer(): Promise<void> {
    return this.lake.pauseMirroring()
  }

  /** Resume transcript mirroring after a transfer abort releases the source fence. */
  resumeMirroringAfterTransfer(): void {
    this.lake.resumeMirroring()
  }

  /**
   * Stop the paced, store-touching work this service owns. Called from
   * SessionRegistry.dispose(), i.e. while the store is still open and BEFORE
   * store.close() — the ordering the whole point depends on.
   */
  dispose(): void {
    this.lake.dispose()
  }

  /** Lake reads still outstanding against a daemon — shutdown/test seam. */
  get pendingLakeReads(): number {
    return this.lake.pendingReads
  }

  readTranscriptFromLake(
    session: LakeReadSession,
    input: { anchor?: string; direction: 'before' | 'after'; limit: number },
  ) {
    return this.lake.readWindow(session, input)
  }

  /** `machineId` is the machine that ANSWERED (from the authenticated transport,
   *  never a frame body): the broker refuses a reply from any machine other than
   *  the one the ranged read was sent to (POD-1175). */
  onTranscriptMirrorResult(
    machineId: string,
    message: {
      requestId: string
      data: string
      fileSize: number
      eof: boolean
      error?: string
    },
  ): void {
    this.lake.onMirrorResult(machineId, message)
  }
}

export class MemoryReaderView {
  constructor(
    private readonly memory: MemoryService,
    readonly reader: MemoryReader,
  ) {}

  searchConversations(opts: { query?: string; projectPath?: string; limit?: number }) {
    return this.memory.searchConversations(this.reader, opts)
  }

  search(opts: { text: string; limit?: number; now?: () => number }) {
    return this.memory.search(this.reader, opts)
  }

  setConversationMeta(input: { id: string; name?: string; summary?: string }): void {
    this.memory.setConversationMeta(this.reader, input)
  }
}
