import { createLogger } from '@podium/logger'
import type { TranscriptItem } from '@podium/model'
import {
  isTranscriptQuotaError,
  type StoredTranscriptChat,
  type StoredTranscriptMessage,
  type TranscriptBackendChange,
  type TranscriptStoreBackend,
} from './backend'

const log = createLogger('client-core:transcript-store')

/** Newest messages kept per chat; older rows are trimmed in the write that goes over. */
export const TRANSCRIPT_CHAT_MESSAGE_LIMIT = 2_000
/** A chat not opened for this long is deleted by the sweep. */
export const TRANSCRIPT_CHAT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Stored bytes per user (the length of the rows we write). */
export const TRANSCRIPT_STORE_BUDGET_BYTES = 10 * 1024 * 1024
/** Over the budget, whole chats go until the total is under this. */
export const TRANSCRIPT_STORE_TARGET_BYTES = 9 * 1024 * 1024

export interface TranscriptStoreLimits {
  readonly messagesPerChat: number
  readonly maxAgeMs: number
  readonly budgetBytes: number
  readonly targetBytes: number
}

export const DEFAULT_TRANSCRIPT_STORE_LIMITS: TranscriptStoreLimits = {
  messagesPerChat: TRANSCRIPT_CHAT_MESSAGE_LIMIT,
  maxAgeMs: TRANSCRIPT_CHAT_MAX_AGE_MS,
  budgetBytes: TRANSCRIPT_STORE_BUDGET_BYTES,
  targetBytes: TRANSCRIPT_STORE_TARGET_BYTES,
}

export interface StoredTranscriptItem {
  readonly seq: number
  readonly item: TranscriptItem
}

export interface TranscriptStorePage {
  /** Oldest first. */
  readonly messages: readonly StoredTranscriptItem[]
  /** The store holds messages older than this page. */
  readonly hasOlder: boolean
  /** When the chat was last written, or null when nothing is stored. */
  readonly savedAt: number | null
}

/** The writer's part of a change; limits and timestamps are the store's. */
export type TranscriptStoreChange = Pick<
  TranscriptBackendChange,
  'clear' | 'removeBelow' | 'removeFrom' | 'remove' | 'upsert'
>

/** Reported once through `onDegraded`, after which this run stops writing to disk. */
export interface TranscriptStoreDegradation {
  readonly kind: 'transcript-store-degraded'
  readonly reason: 'unavailable' | 'quota' | 'write-failed'
  readonly error: unknown
}

/** The one interface both platforms' transcript databases are used through. */
export interface TranscriptStore {
  readNewest(chat: string, n: number): Promise<TranscriptStorePage>
  readBefore(chat: string, seq: number, n: number): Promise<TranscriptStorePage>
  put(chat: string, change: TranscriptStoreChange): Promise<void>
  /** Record that the chat was opened now. */
  touch(chat: string): void
  /** Keep the chat out of every clean-up while it is open or warm. */
  hold(chat: string): () => void
  delete(chat: string): Promise<void>
  /** Age and size clean-up. Run after startup when idle, never during first paint. */
  sweep(): Promise<void>
  /** Delete this user's whole transcript database (sign-out). */
  erase(): Promise<void>
  /** Resolves once every write issued so far has landed or failed. */
  settled(): Promise<void>
  close(): void
}

export interface TranscriptStoreInit {
  /** Opened per signed-in user. A rejected open leaves chat working from memory. */
  readonly backend: TranscriptStoreBackend | Promise<TranscriptStoreBackend>
  readonly now?: () => number
  readonly limits?: Partial<TranscriptStoreLimits>
  readonly onDegraded?: (degradation: TranscriptStoreDegradation) => void
  /** Deletes the database without opening it — what `erase` falls back to when the open failed. */
  readonly deleteDatabase?: () => Promise<void>
}

const EMPTY_PAGE: TranscriptStorePage = { messages: [], hasOlder: false, savedAt: null }

/**
 * THE RULES OF THE TRANSCRIPT DATABASE, once for every platform (POD-5801).
 *
 * Everything this enforces happens inside the transcript database and nowhere
 * else: the trims, the age sweep and the size budget delete transcript rows and
 * never touch sync records, drafts, the outbox or UI state, because those live in
 * other databases and this object holds no handle to them.
 *
 * Writes are serialized in issue order. Chat rows (one per chat) are read once at
 * open and mirrored here, so the 10 MB budget is a sum over a small map rather
 * than a scan. A quota failure earns exactly one size clean-up and retry; a
 * second failure — or any other write failure — is reported once and turns disk
 * writes off for this run. Chat keeps working from memory and the server.
 */
export function createTranscriptStore(init: TranscriptStoreInit): TranscriptStore {
  const now = init.now ?? Date.now
  const limits: TranscriptStoreLimits = { ...DEFAULT_TRANSCRIPT_STORE_LIMITS, ...init.limits }
  const chats = new Map<string, StoredTranscriptChat>()
  const holds = new Map<string, number>()
  let writable = true
  let degradedReported = false
  let erased = false
  let closed = false
  let queue: Promise<void> = Promise.resolve()

  const degrade = (reason: TranscriptStoreDegradation['reason'], error: unknown): void => {
    writable = false
    if (degradedReported) return
    degradedReported = true
    log.warn('transcript store degraded; chat history is kept in memory only', {
      reason,
      err: error,
    })
    init.onDegraded?.({ kind: 'transcript-store-degraded', reason, error })
  }

  const ready: Promise<TranscriptStoreBackend | undefined> = (async () => {
    try {
      const backend = await init.backend
      for (const chat of await backend.chats()) chats.set(chat.chat, chat)
      return backend
    } catch (error) {
      degrade('unavailable', error)
      return undefined
    }
  })()

  /** Serialize a mutation behind every earlier one; failures never break the chain. */
  const enqueue = (op: (backend: TranscriptStoreBackend) => Promise<void>): Promise<void> => {
    const run = queue.then(async () => {
      const backend = await ready
      if (!backend || closed) return
      await op(backend)
    })
    queue = run.catch((error) => log.warn('transcript store operation failed', { err: error }))
    return queue
  }

  const totalBytes = (): number => {
    let total = 0
    for (const chat of chats.values()) total += chat.bytes
    return total
  }

  /** Delete whole chats, oldest-opened first, until the total is at or under `target`. */
  const evictTo = async (backend: TranscriptStoreBackend, target: number): Promise<void> => {
    let total = totalBytes()
    if (total <= target) return
    const victims: string[] = []
    const candidates = [...chats.values()]
      .filter((chat) => !holds.has(chat.chat))
      .sort((a, b) => a.openedAt - b.openedAt)
    for (const chat of candidates) {
      if (total <= target) break
      victims.push(chat.chat)
      total -= chat.bytes
    }
    if (victims.length === 0) return
    await backend.remove(victims)
    for (const chat of victims) chats.delete(chat)
  }

  const read = async (chat: string, before: number | undefined, n: number) => {
    const backend = await ready
    if (!backend || closed || n <= 0) return EMPTY_PAGE
    let rows: StoredTranscriptMessage[]
    try {
      rows = await backend.messages(chat, before, n + 1)
    } catch (error) {
      log.warn('transcript store read failed', { err: error })
      return EMPTY_PAGE
    }
    const hasOlder = rows.length > n
    const messages: StoredTranscriptItem[] = []
    for (const row of hasOlder ? rows.slice(1) : rows) {
      try {
        messages.push({ seq: row.seq, item: JSON.parse(row.json) as TranscriptItem })
      } catch {
        // A row that does not parse reads as absent; the server has it.
      }
    }
    return { messages, hasOlder, savedAt: chats.get(chat)?.savedAt ?? null }
  }

  const touch = (chat: string): void => {
    // Stamped now, not when the queued write runs.
    const openedAt = now()
    void enqueue(async (backend) => {
      if (!writable || !chats.has(chat)) return
      try {
        chats.set(chat, await backend.commit(chat, { openedAt }))
      } catch (error) {
        log.warn('transcript store touch failed', { err: error })
      }
    })
  }

  return {
    readNewest: (chat, n) => read(chat, undefined, n),
    readBefore: (chat, seq, n) => read(chat, seq, n),
    put(chat, change) {
      const at = now()
      return enqueue(async (backend) => {
        if (!writable) return
        const full: TranscriptBackendChange = {
          ...change,
          keepNewest: limits.messagesPerChat,
          savedAt: at,
          // A chat written for the first time is being looked at now.
          ...(chats.has(chat) ? {} : { openedAt: at }),
        }
        try {
          chats.set(chat, await backend.commit(chat, full))
        } catch (error) {
          if (!isTranscriptQuotaError(error)) return degrade('write-failed', error)
          try {
            await evictTo(backend, limits.targetBytes)
            chats.set(chat, await backend.commit(chat, full))
          } catch (retryError) {
            return degrade('quota', retryError)
          }
        }
        if (totalBytes() > limits.budgetBytes) await evictTo(backend, limits.targetBytes)
      })
    },
    touch,
    hold(chat) {
      holds.set(chat, (holds.get(chat) ?? 0) + 1)
      touch(chat)
      let released = false
      return () => {
        if (released) return
        released = true
        const count = (holds.get(chat) ?? 1) - 1
        if (count > 0) holds.set(chat, count)
        else holds.delete(chat)
      }
    },
    delete(chat) {
      return enqueue(async (backend) => {
        await backend.remove([chat])
        chats.delete(chat)
      })
    },
    sweep() {
      return enqueue(async (backend) => {
        const cutoff = now() - limits.maxAgeMs
        const stale = [...chats.values()]
          .filter((chat) => chat.openedAt < cutoff && !holds.has(chat.chat))
          .map((chat) => chat.chat)
        if (stale.length > 0) {
          await backend.remove(stale)
          for (const chat of stale) chats.delete(chat)
        }
        if (totalBytes() > limits.budgetBytes) await evictTo(backend, limits.targetBytes)
      })
    },
    async erase() {
      writable = false
      erased = true
      await queue
      chats.clear()
      const backend = await ready
      // The open may have failed; an erase must still delete the database.
      if (backend) await backend.erase()
      else await init.deleteDatabase?.()
    },
    settled: () => queue,
    close() {
      if (closed) return
      closed = true
      void queue.then(async () => {
        if (erased) return
        ;(await ready)?.close()
      })
    },
  }
}
