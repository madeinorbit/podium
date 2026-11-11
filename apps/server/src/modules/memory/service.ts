import type {
  ConversationDiagnosticWire,
  ConversationDiscoveryWire,
  ConversationId,
  ConversationRecordWire,
  MachineId,
  SessionId,
} from '@podium/model'
import { asSessionId } from '@podium/model'
import type { MetadataChange } from '@podium/protocol'
import type { LedgerCommitOp, LedgerCommitResult, LedgerWriter } from '@podium/sync'
import { transcriptRecordMapperFor } from '../../harness-manifest'
import type { SessionStore } from '../../store'
import type { ConversationPageCursor } from '../../store/conversations/index'
import type { DaemonRequestPort } from '../daemon-request'
import { type LakeReadSession, TranscriptLake } from './lake'
import { MemorySearchService } from './search'
import type { MemoryReader } from './types'
import { MemoryVisibilityPolicy } from './visibility'

export type { LakeReadSession } from './lake'
export type { MemoryReader } from './types'

/** A conversation the reader cannot see, or that does not exist: deliberately
 *  one answer. Named so a transport can tell it from a failure (POD-6412). */
export class ConversationNotFound extends Error {
  constructor() {
    super('conversation not found')
    this.name = 'ConversationNotFound'
  }
}

/** What a conversation command writes through: the command's own writer. */
export type ConversationCommandWriter = Pick<LedgerWriter, 'commit'>

/**
 * The memory service's own writer, a `server` origin (`conversations.discovery`):
 * a daemon's discovery report, its list reconcile. Never a command's.
 */
export interface MemoryLedger {
  commit<T>(operation: LedgerCommitOp<T>): LedgerCommitResult<T> | Promise<LedgerCommitResult<T>>
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
  private latestDiagnostics: ConversationDiagnosticWire[] = []
  private lastDiagnosticsBroadcast = JSON.stringify([])
  private readonly visibility: MemoryVisibilityPolicy
  private readonly searcher: MemorySearchService
  private readonly lake: TranscriptLake

  /** Whether the boot repair is permitted; a query-only recovery assembly opts out. */

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
        // The Store's grammar parameter (POD-4471): declaration lookup stays
        // here at the composition root; the lake parses only through the Store.
        parseForAgentKind: (agentKind) => transcriptRecordMapperFor(agentKind),
        findSessionByNativeId: async (_machineId, nativeId) => {
          const row = (await deps.store.sessions.findSessionsByResumeValues([nativeId])).get(
            nativeId,
          )
          return row ? { agentKind: row.agentKind as LakeReadSession['agentKind'] } : undefined
        },
      },
      options,
    )
  }

  forReader(reader: MemoryReader): MemoryReaderView {
    return new MemoryReaderView(this, reader)
  }

  /** A reader's view that may also write, through the writer of the command
   *  that asked (ADR 12 D9, POD-6594). */
  forCommand(reader: MemoryReader, writer: ConversationCommandWriter): MemoryCommandView {
    return new MemoryCommandView(this, reader, writer)
  }

  async allConversations(): Promise<ConversationRecordWire[]> {
    const rows: ConversationRecordWire[] = []
    for await (const page of this.deps.store.conversations.index.recordPages()) rows.push(...page)
    return rows
  }

  diagnostics(): ConversationDiagnosticWire[] {
    return this.latestDiagnostics
  }

  async onDiscovery(
    machineId: MachineId,
    conversations: ConversationDiscoveryWire[],
    diagnostics: ConversationDiagnosticWire[],
    removed: string[] = [],
  ): Promise<void> {
    await this.indexConversations(conversations, machineId, removed)
    this.latestDiagnostics = diagnostics
    this.broadcastDiagnostics()
  }

  private async indexConversations(
    conversations: ConversationDiscoveryWire[],
    machineId: MachineId,
    removed: string[],
  ): Promise<void> {
    // Three batches, in the order the parent links need [POD-6227]: the
    // top-level conversations, then any parent a child names that the report
    // left out, then the children with their parents' ids. Each is a fixed
    // number of statements, whatever the size of the report.
    const registry = this.deps.store.conversations.registry
    const fileOf = (conversation: ConversationDiscoveryWire) => ({
      ...(conversation.path ? { path: conversation.path } : {}),
      ...(conversation.sizeBytes !== undefined ? { sizeBytes: conversation.sizeBytes } : {}),
    })
    const roots = conversations.filter((conversation) => !conversation.parentConversationId)
    const children = conversations.filter((conversation) => conversation.parentConversationId)
    const podiumIds = await registry.ensureMany(
      machineId,
      roots.map((conversation) => ({
        nativeId: conversation.id,
        providerId: conversation.providerId,
        ...fileOf(conversation),
      })),
    )
    const unreported = children.filter(
      (conversation) => !podiumIds.has(conversation.parentConversationId!),
    )
    if (unreported.length > 0) {
      const parents = await registry.ensureMany(
        machineId,
        unreported.map((conversation) => ({
          nativeId: conversation.parentConversationId!,
          providerId: conversation.providerId,
        })),
      )
      for (const [nativeId, podiumId] of parents) podiumIds.set(nativeId, podiumId)
    }
    if (children.length > 0) {
      const ids = await registry.ensureMany(
        machineId,
        children.map((conversation) => ({
          nativeId: conversation.id,
          providerId: conversation.providerId,
          parentPodiumId: podiumIds.get(conversation.parentConversationId!)!,
          ...fileOf(conversation),
        })),
      )
      for (const conversation of children) podiumIds.set(conversation.id, ids.get(conversation.id)!)
    }

    await this.deps.ledger.commit({
      // The scanned conversations and the ones the scan no longer lists:
      // each record is built around the write (compare at save, POD-6770).
      affects: [...conversations.map(({ id }) => id), ...removed].map((id) => ({
        entity: 'conversation' as const,
        id,
      })),
      write: async (scope) => {
        await this.deps.store.conversations.index.upsert(
          scope,
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
        await this.deps.store.conversations.index.delete(scope, machineId, removed)
      },
    })
    await this.triggerLakeSweep(machineId)
  }

  private broadcastDiagnostics(): void {
    const key = JSON.stringify(this.latestDiagnostics)
    if (key === this.lastDiagnosticsBroadcast) return
    this.lastDiagnosticsBroadcast = key
    this.deps.onDiagnosticsChanged(this.latestDiagnostics)
  }

  async searchConversations(
    reader: MemoryReader,
    opts: { query?: string; projectPath?: string; after?: ConversationPageCursor; limit?: number },
  ) {
    return await this.searcher.searchConversations(reader, opts)
  }

  async search(reader: MemoryReader, opts: { text: string; limit?: number; now?: () => number }) {
    return await this.searcher.search(reader, opts)
  }

  async setConversationMeta(
    writer: ConversationCommandWriter,
    reader: MemoryReader,
    input: { id: string; name?: string; summary?: string },
  ): Promise<void> {
    const entry = (await this.deps.store.conversations.index.recordEntries([input.id]))[0]
    const current = entry?.value
    const machineId = entry?.machineId
    if (
      !current ||
      !machineId ||
      !(await this.visibility.mayRead(reader, {
        class: 'conversation',
        machineId,
        nativeId: input.id,
      }))
    ) {
      // Invisible and nonexistent are deliberately identical.
      throw new ConversationNotFound()
    }
    await writer.commit({
      affects: [{ entity: 'conversation', id: input.id }],
      write: async (scope) => {
        await this.deps.store.conversations.index.setMeta(scope, input.id, input)
      },
    })
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
    if (!(await this.visibility.mayRead(reader, { class: 'conversation', machineId, nativeId }))) {
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
    if (!(await this.canReadSession(reader, asSessionId(session.id)))) return undefined
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

  async searchConversations(opts: {
    query?: string
    projectPath?: string
    after?: ConversationPageCursor
    limit?: number
  }) {
    return await this.memory.searchConversations(this.reader, opts)
  }

  async search(opts: { text: string; limit?: number; now?: () => number }) {
    return await this.memory.search(this.reader, opts)
  }
}

/** A reader's view with the writer of one command: the only way a conversation
 *  command writes (ADR 12 D9, POD-6594). */
export class MemoryCommandView extends MemoryReaderView {
  constructor(
    private readonly service: MemoryService,
    reader: MemoryReader,
    private readonly writer: ConversationCommandWriter,
  ) {
    super(service, reader)
  }

  async setConversationMeta(input: { id: string; name?: string; summary?: string }): Promise<void> {
    await this.service.setConversationMeta(this.writer, this.reader, input)
  }
}
