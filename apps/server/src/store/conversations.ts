/**
 * Memory persistence composition. No forwarding methods: consumers must name
 * whether they need summaries, stable identity, mirror cursors, or transcript FTS.
 */
import type { MachineId } from '@podium/model'
import { ConversationIndexRepository } from './conversations/index'
import { TranscriptMirrorRepository } from './conversations/mirror'
import { ConversationRegistryRepository } from './conversations/registry'
import { TranscriptIndexRepository } from './conversations/transcript-index'
import type { QueryClient, StoreExecutor } from './executor'

export class ConversationsRepository {
  readonly index: ConversationIndexRepository
  readonly registry: ConversationRegistryRepository
  readonly mirror: TranscriptMirrorRepository
  readonly transcriptIndex: TranscriptIndexRepository

  constructor(
    executor: StoreExecutor<QueryClient>,
    /** This host's minted machine id — the machine a row this composition has to
     *  CONJURE belongs to (POD-318). See {@link ConversationIndexRepository.setMeta}. */
    hostMachineId: MachineId,
  ) {
    // The sub-repositories of this aggregate are composed HERE and nowhere else,
    // so the Stage A seam is unwrapped once and handed down rather than each of
    // them taking the executor [POD-3254, spec rule 27a]. Asserted here for the
    // same reason: the failure names this aggregate rather than the store.
    if (!executor.stageA) {
      throw new Error("ConversationsRepository needs the executor's Stage A drizzle instance")
    }
    const { db, spans } = executor.stageA
    this.index = new ConversationIndexRepository(db, spans, hostMachineId)
    this.registry = new ConversationRegistryRepository(db)
    this.mirror = new TranscriptMirrorRepository(db, spans)
    this.transcriptIndex = new TranscriptIndexRepository(db, spans)
  }

  /**
   * Per-boot full-text setup, gated by the `command-palette` flag (PDM-25).
   * Enabled: tables, triggers and a rebuild. Disabled: the conversations
   * triggers are dropped so writes stop paying for an index nobody reads, and
   * both repositories report unavailable, which turns search into its LIKE
   * fallback and the transcript indexer into a no-op.
   */
  ensureFts(enabled: boolean): void {
    if (enabled) {
      this.index.enableFts()
      this.transcriptIndex.enableFts()
      return
    }
    this.index.disableFts()
    this.transcriptIndex.disableFts()
  }
}
