/**
 * Memory persistence composition. No forwarding methods: consumers must name
 * whether they need summaries, stable identity, mirror cursors, or transcript FTS.
 */
import type { MachineId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { ConversationIndexRepository } from './conversations/index'
import { TranscriptMirrorRepository } from './conversations/mirror'
import { ConversationRegistryRepository } from './conversations/registry'
import { TranscriptIndexRepository } from './conversations/transcript-index'
import { legacyHandle, type QueryClient, type StoreExecutor } from './executor'

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
    // so they stay on the raw handle until their own conversion; only the set
    // `SessionStore` builds takes the executor [POD-3254].
    const db: SqlDatabase = legacyHandle(executor)
    this.index = new ConversationIndexRepository(db, hostMachineId)
    this.registry = new ConversationRegistryRepository(db)
    this.mirror = new TranscriptMirrorRepository(db)
    this.transcriptIndex = new TranscriptIndexRepository(db)
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
