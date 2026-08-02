/**
 * Memory persistence composition. No forwarding methods: consumers must name
 * whether they need summaries, stable identity, mirror cursors, or transcript FTS.
 */
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { ConversationIndexRepository } from './conversations/index'
import { TranscriptMirrorRepository } from './conversations/mirror'
import { ConversationRegistryRepository } from './conversations/registry'
import { TranscriptIndexRepository } from './conversations/transcript-index'

export class ConversationsRepository {
  readonly index: ConversationIndexRepository
  readonly registry: ConversationRegistryRepository
  readonly mirror: TranscriptMirrorRepository
  readonly transcriptIndex: TranscriptIndexRepository

  constructor(db: SqlDatabase) {
    this.index = new ConversationIndexRepository(db)
    this.registry = new ConversationRegistryRepository(db)
    this.mirror = new TranscriptMirrorRepository(db)
    this.transcriptIndex = new TranscriptIndexRepository(db)
  }

  ensureFts(): void {
    this.index.ensureFts()
    this.transcriptIndex.ensureFts()
  }

  adoptLocalRows(machineId: string): void {
    this.index.adoptLocalRows(machineId)
  }
}
