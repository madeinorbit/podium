/**
 * Memory persistence composition. No forwarding methods: consumers must name
 * whether they need summaries, stable identity, mirror cursors, or transcript FTS.
 */
import type { MachineId } from '@podium/model'
import { ConversationIndexRepository } from './conversations/index'
import { TranscriptMirrorRepository } from './conversations/mirror'
import { ConversationRegistryRepository } from './conversations/registry'
import { TranscriptIndexRepository } from './conversations/transcript-index'
import type { StoreQueries } from './executor/sync-drizzle'

export class ConversationsRepository {
  readonly index: ConversationIndexRepository
  readonly registry: ConversationRegistryRepository
  readonly mirror: TranscriptMirrorRepository
  readonly transcriptIndex: TranscriptIndexRepository

  constructor(
    queries: StoreQueries,
    /** This host's minted machine id — the machine a row this composition has to
     *  CONJURE belongs to (POD-318). See {@link ConversationIndexRepository.setMeta}. */
    hostMachineId: MachineId,
  ) {
    // The sub-repositories of this aggregate are composed HERE and nowhere else,
    // so the one query capability this aggregate is handed is passed straight
    // down [POD-3254, spec rule 27b]. They take the same object for the same
    // reason: B1 fills it with the asynchronous pair and none of them changes.
    this.index = new ConversationIndexRepository(queries, hostMachineId)
    this.registry = new ConversationRegistryRepository(queries)
    this.mirror = new TranscriptMirrorRepository(queries)
    this.transcriptIndex = new TranscriptIndexRepository(queries)
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
