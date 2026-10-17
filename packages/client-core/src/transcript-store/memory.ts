import type {
  StoredTranscriptChat,
  StoredTranscriptMessage,
  TranscriptBackendChange,
  TranscriptStoreBackend,
} from './backend'

export interface MemoryTranscriptBackend extends TranscriptStoreBackend {
  /** Make the next `commit` reject with this error (once per call). */
  failNextCommit(error: unknown): void
  readonly erased: boolean
}

/** The backend contract over Maps: tests, demo mode, and the no-database fallback. */
export function createMemoryTranscriptBackend(): MemoryTranscriptBackend {
  const messages = new Map<string, Map<string, StoredTranscriptMessage>>()
  const chats = new Map<string, StoredTranscriptChat>()
  const failures: unknown[] = []
  let erased = false

  const ordered = (chat: string): StoredTranscriptMessage[] =>
    [...(messages.get(chat)?.values() ?? [])].sort((a, b) => a.seq - b.seq)

  return {
    get erased() {
      return erased
    },
    failNextCommit(error) {
      failures.push(error)
    },
    async chats() {
      return [...chats.values()]
    },
    async messages(chat, before, limit) {
      const rows = ordered(chat).filter((row) => before === undefined || row.seq < before)
      return rows.slice(Math.max(0, rows.length - limit))
    },
    async commit(chat, change: TranscriptBackendChange) {
      if (failures.length > 0) throw failures.shift()
      const rows = new Map(messages.get(chat))
      if (change.clear) rows.clear()
      for (const [id, row] of rows) {
        if (change.removeBelow !== undefined && row.seq < change.removeBelow) rows.delete(id)
        else if (change.removeFrom !== undefined && row.seq >= change.removeFrom) rows.delete(id)
      }
      for (const id of change.remove ?? []) rows.delete(id)
      for (const row of change.upsert ?? []) rows.set(row.id, row)
      if (change.keepNewest !== undefined && rows.size > change.keepNewest) {
        const sorted = [...rows.values()].sort((a, b) => a.seq - b.seq)
        for (const row of sorted.slice(0, rows.size - change.keepNewest)) rows.delete(row.id)
      }
      messages.set(chat, rows)
      const prev = chats.get(chat)
      let bytes = 0
      let newestSeq: number | null = null
      for (const row of rows.values()) {
        bytes += row.json.length
        if (newestSeq === null || row.seq > newestSeq) newestSeq = row.seq
      }
      const next: StoredTranscriptChat = {
        chat,
        openedAt: change.openedAt ?? prev?.openedAt ?? 0,
        savedAt: change.savedAt ?? prev?.savedAt ?? 0,
        newestSeq,
        count: rows.size,
        bytes,
      }
      chats.set(chat, next)
      return next
    },
    async remove(ids) {
      for (const chat of ids) {
        messages.delete(chat)
        chats.delete(chat)
      }
    },
    async erase() {
      messages.clear()
      chats.clear()
      erased = true
    },
    close() {},
  }
}
