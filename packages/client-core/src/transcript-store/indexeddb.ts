import type {
  StoredTranscriptChat,
  StoredTranscriptMessage,
  TranscriptBackendChange,
  TranscriptStoreBackend,
} from './backend'

/*
 * The IndexedDB surface this adapter names, structurally — the same reason as
 * `@podium/sync`'s `idb.ts`: client-core carries no DOM lib, and tests pass
 * fake-indexeddb through the same seam. Wider than that file's types because the
 * transcript store needs an index and cursors.
 */
interface IdbRequest<T> {
  result: T
  error: { name: string; message: string } | null
  onsuccess: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}
interface IdbCursor {
  readonly value: unknown
  continue(): void
  delete(): IdbRequest<unknown>
}
interface IdbIndex {
  openCursor(range?: unknown, direction?: 'next' | 'prev'): IdbRequest<IdbCursor | null>
}
interface IdbStore {
  put(value: unknown): IdbRequest<unknown>
  get(key: unknown): IdbRequest<unknown>
  getAll(): IdbRequest<unknown[]>
  delete(key: unknown): IdbRequest<unknown>
  index(name: string): IdbIndex
  createIndex(name: string, keyPath: string | string[], options?: { unique?: boolean }): unknown
}
interface IdbTransaction {
  objectStore(name: string): IdbStore
  error: { name: string; message: string } | null
  oncomplete: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  onabort: ((ev: unknown) => void) | null
}
interface IdbDatabase {
  readonly objectStoreNames: { contains(name: string): boolean }
  createObjectStore(name: string, options?: { keyPath?: string | string[] }): IdbStore
  transaction(names: string | string[], mode?: 'readonly' | 'readwrite'): IdbTransaction
  close(): void
  onversionchange: ((ev: unknown) => void) | null
}
interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  onupgradeneeded: ((ev: unknown) => void) | null
  onblocked?: ((ev: unknown) => void) | null
}
export interface TranscriptIdbFactory {
  open(name: string, version?: number): IdbOpenRequest
  deleteDatabase(name: string): IdbOpenRequest
}
export interface TranscriptIdbKeyRange {
  bound(lower: unknown, upper: unknown, lowerOpen?: boolean, upperOpen?: boolean): unknown
}

export interface IndexedDbTranscriptBackendInit {
  readonly factory: TranscriptIdbFactory
  readonly keyRange: TranscriptIdbKeyRange
  /** One database per signed-in user, e.g. `podium-transcripts:<namespace>`. */
  readonly databaseName: string
}

const MESSAGES = 'messages'
const CHATS = 'chats'
const ORDER = 'order'
const VERSION = 1

interface MessageRow {
  chat: string
  id: string
  seq: number
  json: string
  bytes: number
}

function request<T>(req: IdbRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Run `step(next)` callbacks in order inside one live transaction: each step issues
 *  its requests and calls `next` from its last callback, never across an await. */
function sequence(steps: ((next: () => void) => void)[]): void {
  const run = (index: number): void => {
    const step = steps[index]
    if (step) step(() => run(index + 1))
  }
  run(0)
}

/** Walk a cursor to its end (or until `visit` returns false), then call `done`. */
function walk(
  req: IdbRequest<IdbCursor | null>,
  visit: (cursor: IdbCursor) => boolean,
  done: () => void,
): void {
  req.onsuccess = () => {
    const cursor = req.result
    if (cursor && visit(cursor)) cursor.continue()
    else done()
  }
}

/** Web and desktop: this user's chat history in a database of its own. */
export async function openIndexedDbTranscriptBackend(
  init: IndexedDbTranscriptBackendInit,
): Promise<TranscriptStoreBackend> {
  const { factory, keyRange, databaseName } = init
  const openReq = factory.open(databaseName, VERSION)
  openReq.onupgradeneeded = () => {
    const db = openReq.result
    if (!db.objectStoreNames.contains(MESSAGES)) {
      const messages = db.createObjectStore(MESSAGES, { keyPath: ['chat', 'id'] })
      messages.createIndex(ORDER, ['chat', 'seq'], { unique: false })
    }
    if (!db.objectStoreNames.contains(CHATS)) db.createObjectStore(CHATS, { keyPath: 'chat' })
  }
  let db: IdbDatabase | undefined = await request(openReq)
  // Another tab erasing this user's history must not wait on this connection.
  db.onversionchange = () => {
    db?.close()
    db = undefined
  }

  const live = (): IdbDatabase => {
    if (!db) throw new Error('transcript database is closed')
    return db
  }
  const allOf = (chat: string) => keyRange.bound([chat], [chat, []])
  const orderOf = (chat: string, from = -Infinity, to = Infinity, toOpen = false) =>
    keyRange.bound([chat, from], [chat, to], false, toOpen)

  return {
    async chats() {
      const tx = live().transaction(CHATS, 'readonly')
      return (await request(tx.objectStore(CHATS).getAll())) as StoredTranscriptChat[]
    },
    messages(chat, before, limit) {
      if (limit <= 0) return Promise.resolve([])
      return new Promise((resolve, reject) => {
        const tx = live().transaction(MESSAGES, 'readonly')
        const rows: StoredTranscriptMessage[] = []
        const range = before === undefined ? orderOf(chat) : orderOf(chat, -Infinity, before, true)
        const req = tx.objectStore(MESSAGES).index(ORDER).openCursor(range, 'prev')
        req.onerror = () => reject(req.error)
        walk(
          req,
          (cursor) => {
            const row = cursor.value as MessageRow
            rows.push({ id: row.id, seq: row.seq, json: row.json })
            return rows.length < limit
          },
          () => resolve(rows.reverse()),
        )
      })
    },
    commit(chat, change: TranscriptBackendChange) {
      return new Promise((resolve, reject) => {
        const tx = live().transaction([MESSAGES, CHATS], 'readwrite')
        const messages = tx.objectStore(MESSAGES)
        const chats = tx.objectStore(CHATS)
        let prev: StoredTranscriptChat | undefined
        let count = 0
        let bytes = 0
        let newestSeq: number | null = null
        let result: StoredTranscriptChat | undefined
        tx.oncomplete = () => resolve(result!)
        tx.onabort = () => reject(tx.error ?? new Error('transcript write aborted'))
        tx.onerror = () => {}
        const subtract = (row: MessageRow | undefined): void => {
          if (!row) return
          count -= 1
          bytes -= row.bytes
        }
        const deleteRange = (range: unknown) => (next: () => void) =>
          walk(
            messages.index(ORDER).openCursor(range),
            (cursor) => {
              subtract(cursor.value as MessageRow)
              cursor.delete()
              return true
            },
            next,
          )
        sequence([
          (next) => {
            const req = chats.get(chat)
            req.onsuccess = () => {
              prev = req.result as StoredTranscriptChat | undefined
              count = prev?.count ?? 0
              bytes = prev?.bytes ?? 0
              next()
            }
          },
          (next) => {
            if (!change.clear) return next()
            messages.delete(allOf(chat)).onsuccess = () => {
              count = 0
              bytes = 0
              next()
            }
          },
          (next) =>
            change.removeBelow === undefined
              ? next()
              : deleteRange(orderOf(chat, -Infinity, change.removeBelow, true))(next),
          (next) =>
            change.removeFrom === undefined
              ? next()
              : deleteRange(orderOf(chat, change.removeFrom))(next),
          (next) => {
            const ids = change.remove ?? []
            let pending = ids.length
            if (pending === 0) return next()
            for (const id of ids) {
              const req = messages.get([chat, id])
              req.onsuccess = () => {
                if (req.result) {
                  subtract(req.result as MessageRow)
                  messages.delete([chat, id])
                }
                if (--pending === 0) next()
              }
            }
          },
          (next) => {
            const rows = change.upsert ?? []
            let pending = rows.length
            if (pending === 0) return next()
            for (const row of rows) {
              const req = messages.get([chat, row.id])
              req.onsuccess = () => {
                subtract(req.result as MessageRow | undefined)
                const stored: MessageRow = { chat, ...row, bytes: row.json.length }
                messages.put(stored)
                count += 1
                bytes += stored.bytes
                if (--pending === 0) next()
              }
            }
          },
          (next) => {
            const keep = change.keepNewest
            if (keep === undefined || count <= keep) return next()
            let excess = count - keep
            walk(
              messages.index(ORDER).openCursor(orderOf(chat)),
              (cursor) => {
                subtract(cursor.value as MessageRow)
                cursor.delete()
                return --excess > 0
              },
              next,
            )
          },
          (next) => {
            const req = messages.index(ORDER).openCursor(orderOf(chat), 'prev')
            req.onsuccess = () => {
              newestSeq = (req.result?.value as MessageRow | undefined)?.seq ?? null
              next()
            }
          },
          () => {
            result = {
              chat,
              openedAt: change.openedAt ?? prev?.openedAt ?? 0,
              savedAt: change.savedAt ?? prev?.savedAt ?? 0,
              newestSeq,
              count,
              bytes,
            }
            chats.put(result)
          },
        ])
      })
    },
    remove(ids) {
      return new Promise((resolve, reject) => {
        if (ids.length === 0) return resolve()
        const tx = live().transaction([MESSAGES, CHATS], 'readwrite')
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error ?? new Error('transcript delete aborted'))
        for (const chat of ids) {
          tx.objectStore(MESSAGES).delete(allOf(chat))
          tx.objectStore(CHATS).delete(chat)
        }
      })
    },
    async erase() {
      db?.close()
      db = undefined
      await request(factory.deleteDatabase(databaseName))
    },
    close() {
      db?.close()
      db = undefined
    },
  }
}
