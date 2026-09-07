import { asSessionId } from '@podium/model'
import type {
  ConversationDiagnosticWire,
  ConversationId,
  ConversationSummaryWire,
  MachineId,
  SessionId,
} from '@podium/model'
import type { MetadataChange } from '@podium/protocol'
import {
  type BaselineFoldPort,
  type EntityChangeSpec,
  type LedgerCommitOp,
  type LedgerCommitResult,
  StagedProjection,
} from '@podium/sync'
import type { SessionStore } from '../../store'
import type { DaemonRequestPort } from '../daemon-request'
import { type LakeReadSession, TranscriptLake } from './lake'
import { MemorySearchService } from './search'
import type { MemoryReader } from './types'
import { MemoryVisibilityPolicy } from './visibility'

export type { LakeReadSession } from './lake'
export type { MemoryReader } from './types'

export interface MemoryLedger {
  commit<T>(operation: LedgerCommitOp<T>): LedgerCommitResult<T> | Promise<LedgerCommitResult<T>>
  reconcile(
    entity: 'conversation',
    rows: { id: string; value: unknown }[],
  ): MetadataChange[] | Promise<MetadataChange[]>
}

export interface MemoryServiceDeps {
  store: SessionStore
  now(): number
  ledger: MemoryLedger
  onDiagnosticsChanged(diagnostics: readonly ConversationDiagnosticWire[]): void
  /**
   * Where the conversation list waits for the OUTERMOST commit [POD-3366].
   *
   * The list is process-owned memory installed on the success path of a
   * `ledger.commit` that may be a SAVEPOINT inside a caller's wider span, and a
   * savepoint release is not a commit. Unset means every install is immediate,
   * which is what a unit test with a pass-through `transact` wants.
   */
  applyCommit?: BaselineFoldPort
  /** The ONE daemon-RPC correlator (POD-318) — the broker's exported port,
   *  passed straight through to the lake's ranged reads. */
  daemonRequest: DaemonRequestPort
}

/**
 * One read-side memory service: stable conversation registry, transcript lake,
 * transcript index, subagent evidence repair, and visibility-scoped omni-search.
 */
export class MemoryService {
  /**
   * THE CONVERSATION LIST SERVED TO CLIENTS, installed only once the commit
   * behind it is durable [POD-3366].
   *
   * A `StagedProjection` rather than a bare field because this list has
   * IN-WINDOW READERS and they are not hypothetical: `setConversationMeta`
   * reads it as its own precondition, so two meta writes inside one enclosing
   * span would lose the first if the install were merely deferred, and
   * `reconcileConversationList` diffs full truth against it. The staged layer
   * is what lets those reads see this span's own work while the committed slot
   * still holds only what the database kept.
   */
  private readonly latestConversations: StagedProjection<ConversationSummaryWire[]>
  private latestDiagnostics: ConversationDiagnosticWire[] = []
  private readonly machineByConversation = new Map<string, MachineId>()
  private lastDiagnosticsBroadcast = JSON.stringify([])
  private readonly visibility: MemoryVisibilityPolicy
  private readonly searcher: MemorySearchService
  private readonly lake: TranscriptLake

  /** Whether the boot repair is permitted; a query-only recovery assembly opts out. */
  private readonly repairsSubagentEvidence: boolean

  constructor(
    private readonly deps: MemoryServiceDeps,
    options: { mirrorLakeDir?: string; repairSubagentSegmentPaths?: boolean } = {},
  ) {
    this.latestConversations = new StagedProjection<ConversationSummaryWire[]>(
      [],
      deps.applyCommit,
      'memory-conversation-list',
    )
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
    this.repairsSubagentEvidence = options.repairSubagentSegmentPaths !== false
  }

  /**
   * THE ONE WRITE THIS SERVICE OWNS AT BOOT — the subagent evidence repair,
   * memory-owned rather than a SessionStore boot side effect.
   *
   * It is a boot STEP rather than a line in the constructor (POD-3256): the
   * composition root runs it after the object exists, so constructing a memory
   * service never touches the database. The order the root calls it in is the
   * order the constructor established.
   *
   * Recovery-only assembly holds a query-only connection, so its composition
   * root explicitly disables this boot writer; every writable boot keeps the
   * default and repairs before serving conversation reads.
   */
  async repairSubagentEvidence(): Promise<void> {
    if (!this.repairsSubagentEvidence) return
    await this.deps.store.conversations.registry.repairSubagentSegmentPaths()
  }

  forReader(reader: MemoryReader): MemoryReaderView {
    return new MemoryReaderView(this, reader)
  }

  allConversations(): ConversationSummaryWire[] {
    return this.latestConversations.read()
  }

  diagnostics(): ConversationDiagnosticWire[] {
    return this.latestDiagnostics
  }

  async onDiscovery(
    machineId: MachineId,
    conversations: ConversationSummaryWire[],
    diagnostics: ConversationDiagnosticWire[],
    removed: string[] = [],
  ): Promise<void> {
    for (const conversation of conversations)
      this.machineByConversation.set(conversation.id, machineId)
    for (const id of removed) this.machineByConversation.delete(id)
    this.latestConversations.install(await this.indexConversations(conversations, machineId, removed))
    this.latestDiagnostics = diagnostics
    this.broadcastDiagnostics()
  }

  private async indexConversations(
    conversations: ConversationSummaryWire[],
    machineId: MachineId,
    removed: string[],
  ): Promise<ConversationSummaryWire[]> {
    const podiumIds = new Map<string, ConversationId>()
    for (const conversation of conversations) {
      if (conversation.parentConversationId) continue
      podiumIds.set(
        conversation.id,
        await this.ensureConversationIdentity({
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
        await this.ensureConversationIdentity({
          machineId,
          nativeId: conversation.parentConversationId,
          providerId: conversation.providerId,
        })
      podiumIds.set(
        conversation.id,
        await this.ensureConversationIdentity({
          machineId,
          nativeId: conversation.id,
          providerId: conversation.providerId,
          parentPodiumId,
          ...(conversation.path ? { path: conversation.path } : {}),
          ...(conversation.sizeBytes !== undefined ? { sizeBytes: conversation.sizeBytes } : {}),
        }),
      )
    }

    const curated = await this.deps.store.conversations.index.curatedMeta()
    const enriched = conversations.map((conversation) => ({
      ...conversation,
      ...(podiumIds.get(conversation.id)
        ? { podiumId: podiumIds.get(conversation.id) as ConversationId }
        : {}),
      ...(curated.get(conversation.id) ?? {}),
    }))
    await this.deps.ledger.commit({
      write: async () => {
        await this.deps.store.conversations.index.upsert(
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
        if (removed.length) await this.deps.store.conversations.index.delete(removed)
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
    await this.triggerLakeSweep(machineId)
    return enriched
  }

  async reconcileConversationList(): Promise<void> {
    await this.deps.ledger.reconcile(
      'conversation',
      this.latestConversations.read().map((conversation) => ({
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

  async searchConversations(
    reader: MemoryReader,
    opts: { query?: string; projectPath?: string; limit?: number },
  ) {
    return await this.searcher.searchConversations(reader, opts)
  }

  async search(reader: MemoryReader, opts: { text: string; limit?: number; now?: () => number }) {
    return await this.searcher.search(reader, opts)
  }

  async setConversationMeta(
    reader: MemoryReader,
    input: { id: string; name?: string; summary?: string },
  ): Promise<void> {
    const current = this.latestConversations
      .read()
      .find((conversation) => conversation.id === input.id)
    // Both come from the same `onDiscovery` push (POD-318): there is no
    // placeholder machine to fall back to any more, so a conversation with no
    // known machine is as unreadable as one that does not exist.
    const machineId = this.machineByConversation.get(input.id)
    if (
      !current ||
      !machineId ||
      !await this.visibility.mayRead(reader, {
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
    await this.deps.ledger.commit({
      write: async () => await this.deps.store.conversations.index.setMeta(input.id, input),
      changes: () => [
        {
          entity: 'conversation',
          id: input.id,
          op: 'upsert',
          value: next,
        },
      ],
    })
    // Installed through the projection, not assigned: with an enclosing span
    // open the row this describes is not durable yet, and the assignment that
    // used to sit here claimed it was.
    this.latestConversations.update((list) =>
      list.map((conversation) => (conversation.id === input.id ? next : conversation)),
    )
  }

  async ensureConversationIdentity(
    input: Parameters<SessionStore['conversations']['registry']['ensure']>[0],
  ) {
    return await this.deps.store.conversations.registry.ensure(input)
  }

  async linkConversationSegment(
    input: Parameters<SessionStore['conversations']['registry']['linkSegment']>[0],
  ) {
    return await this.deps.store.conversations.registry.linkSegment(input)
  }

  async conversationPodiumId(
    reader: MemoryReader,
    machineId: MachineId,
    nativeId: string,
  ): Promise<ConversationId | undefined> {
    if (!await this.visibility.mayRead(reader, { class: 'conversation', machineId, nativeId })) {
      return undefined
    }
    return await this.deps.store.conversations.registry.podiumId(machineId, nativeId)
  }

  async canReadSession(reader: MemoryReader, sessionId: SessionId): Promise<boolean> {
    return await this.visibility.mayReadSession(reader, sessionId)
  }

  async transcriptPathHint(
    reader: MemoryReader,
    session: { id: string; machineId: MachineId; resume?: { value: string } },
  ): Promise<{ pathHint: string } | undefined> {
    if (!await this.canReadSession(reader, asSessionId(session.id))) return undefined
    const nativeId = session.resume?.value
    return nativeId ? await this.lake.pathHint(session.machineId, nativeId) : undefined
  }

  async triggerLakeSweep(machineId: MachineId): Promise<void> {
    await this.lake.triggerSweep(machineId)
  }

  /** Drain and pause transcript mirroring before the transfer's final snapshot. */
  async pauseMirroringForTransfer(): Promise<void> {
    return await this.lake.pauseMirroring()
  }

  /** Resume transcript mirroring after a transfer abort releases the source fence. */
  async resumeMirroringAfterTransfer(): Promise<void> {
    await this.lake.resumeMirroring()
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

  async readTranscriptFromLake(
    session: LakeReadSession,
    input: { anchor?: string; direction: 'before' | 'after'; limit: number },
  ) {
    return await this.lake.readWindow(session, input)
  }

  async transcriptHasPredecessors(session: LakeReadSession): Promise<boolean> {
    const nativeId = session.resume?.value
    return nativeId ? await this.lake.hasPredecessors(session.machineId, nativeId) : false
  }

  /** `machineId` is the machine that ANSWERED (from the authenticated transport,
   *  never a frame body): the broker refuses a reply from any machine other than
   *  the one the ranged read was sent to (POD-1175). */
  onTranscriptMirrorResult(
    machineId: MachineId,
    message: {
      requestId: string
      data: string
      fileSize: number
      eof: boolean
      device?: string
      inode?: string
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

  async searchConversations(opts: { query?: string; projectPath?: string; limit?: number }) {
    return await this.memory.searchConversations(this.reader, opts)
  }

  async search(opts: { text: string; limit?: number; now?: () => number }) {
    return await this.memory.search(this.reader, opts)
  }

  async setConversationMeta(input: { id: string; name?: string; summary?: string }): Promise<void> {
    await this.memory.setConversationMeta(this.reader, input)
  }
}
