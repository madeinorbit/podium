import type { SessionId, TranscriptItem } from '@podium/model'
import type {
  TranscriptCache,
  TranscriptCacheEntry,
  TranscriptCacheWriteOptions,
} from '../transcript/contracts'
import type { StoredTranscriptMessage } from './backend'
import type { TranscriptStore, TranscriptStoreChange, TranscriptStorePage } from './store'

/** Order spacing for new rows, so a message placed between two stored ones fits between them. */
const SEQ_STEP = 1024

interface Known {
  readonly seq: number
  readonly item: TranscriptItem
  readonly json: string
}

export interface StoreTranscriptCache extends TranscriptCache {
  /** Write every coalesced window now (reload, background, close). Never throws. */
  flush(): void
  dispose(): void
}

export interface StoreTranscriptCacheOptions {
  /**
   * Trailing throttle for a chat's writes (POD-5536's 250 ms). The first write
   * arms one timer and later ones only replace the pending window, so a steady
   * stream writes at most about four times a second per chat.
   */
  readonly settleMs?: number
}

/**
 * THE ROW DIFF between what a transcript holds and what the device stores.
 *
 * A transcript hands over its whole trailing window; the store wants one row per
 * changed message. This keeps a mirror of the rows it knows for each held chat
 * (loaded or written this run) and turns each window into the smallest change:
 * new messages and messages whose content changed are upserted, and a message
 * the window dropped from inside the range it covers is removed. Rows older than
 * the window stay — they are the history a reader scrolls back into.
 *
 * Contiguity is the invariant. Stored rows must be one unbroken run of the chat,
 * or scrolling back from disk would silently skip messages. So a window whose
 * oldest messages are NOT stored (a server read that jumped past what the device
 * holds) deletes the stored rows below it, and a window that shares nothing with
 * the stored rows replaces them.
 */
export function planTranscriptWrite(
  mirror: ReadonlyMap<string, Known>,
  items: readonly TranscriptItem[],
  replace: boolean,
): { change: TranscriptStoreChange; mirror: Map<string, Known> } | undefined {
  const known = items.map((item) => mirror.get(item.id)?.seq)
  const first = known.findIndex((seq) => seq !== undefined)
  const seqs = replace || first < 0 ? undefined : placeBetweenKnown(known, first)
  if (!seqs) {
    if (items.length === 0 && mirror.size === 0 && !replace) return undefined
    const next = new Map<string, Known>()
    const upsert = items.map((item, index) => {
      const json = JSON.stringify(item)
      next.set(item.id, { seq: index * SEQ_STEP, item, json })
      return { id: item.id, seq: index * SEQ_STEP, json }
    })
    return { change: { clear: true, upsert }, mirror: next }
  }
  const floor = known[first]!
  const next = new Map<string, Known>()
  const upsert: StoredTranscriptMessage[] = []
  items.forEach((item, index) => {
    const seq = seqs[index]!
    const held = mirror.get(item.id)
    if (held && held.seq === seq && held.item === item) {
      next.set(item.id, held)
      return
    }
    const json = JSON.stringify(item)
    next.set(item.id, { seq, item, json })
    if (!held || held.seq !== seq || held.json !== json) upsert.push({ id: item.id, seq, json })
  })
  const remove = [...mirror.values()]
    .filter((row) => row.seq >= floor && !next.has(row.item.id))
    .map((row) => row.item.id)
  const change: TranscriptStoreChange = {
    ...(first > 0 ? { removeBelow: floor } : {}),
    ...(remove.length > 0 ? { remove } : {}),
    ...(upsert.length > 0 ? { upsert } : {}),
  }
  return { change, mirror: next }
}

/** Orders for every window item, keeping known orders; undefined when they cannot be kept. */
function placeBetweenKnown(
  known: readonly (number | undefined)[],
  first: number,
): number[] | undefined {
  const seqs: number[] = new Array(known.length)
  // An unstored prefix sits below the oldest stored message of the window.
  for (let index = 0; index < first; index++)
    seqs[index] = known[first]! - (first - index) * SEQ_STEP
  let previous = first
  seqs[first] = known[first]!
  for (let index = first + 1; index <= known.length; index++) {
    const seq = known[index]
    if (index < known.length && seq === undefined) continue
    const low = seqs[previous]!
    const gap = index - previous
    if (index === known.length) {
      for (let k = 1; k < gap; k++) seqs[previous + k] = low + k * SEQ_STEP
      break
    }
    if (seq! <= low) return undefined
    const step = (seq! - low) / gap
    for (let k = 1; k < gap; k++) {
      const placed = low + k * step
      if (!(placed > seqs[previous + k - 1]! && placed < seq!)) return undefined
      seqs[previous + k] = placed
    }
    seqs[index] = seq!
    previous = index
  }
  return seqs
}

const toEntry = (page: TranscriptStorePage): TranscriptCacheEntry | undefined =>
  page.messages.length === 0
    ? undefined
    : {
        items: page.messages.map((row) => row.item),
        savedAt: page.savedAt ?? 0,
        hasOlder: page.hasOlder,
      }

/**
 * A {@link TranscriptCache} over this user's {@link TranscriptStore}: the one
 * write path every chat uses, the normal chat and the superagent alike.
 */
export function createStoreTranscriptCache(
  store: TranscriptStore,
  options: StoreTranscriptCacheOptions = {},
): StoreTranscriptCache {
  const settleMs = options.settleMs ?? 250
  const mirrors = new Map<string, Map<string, Known>>()
  const pending = new Map<string, { window: () => readonly TranscriptItem[]; replace: boolean }>()
  const holds = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const remember = (chat: string, page: TranscriptStorePage): void => {
    const mirror = mirrors.get(chat) ?? new Map<string, Known>()
    for (const row of page.messages)
      if (!mirror.has(row.item.id))
        mirror.set(row.item.id, { seq: row.seq, item: row.item, json: JSON.stringify(row.item) })
    mirrors.set(chat, mirror)
  }

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    for (const [chat, write] of pending) {
      pending.delete(chat)
      let items: readonly TranscriptItem[]
      try {
        items = write.window()
      } catch {
        continue
      }
      const plan = planTranscriptWrite(mirrors.get(chat) ?? new Map(), items, write.replace)
      if (!plan) continue
      if (holds.has(chat)) mirrors.set(chat, plan.mirror)
      else mirrors.delete(chat)
      if (Object.keys(plan.change).length > 0) void store.put(chat, plan.change)
    }
  }

  const schedule = (): void => {
    if (timer !== undefined) return
    timer = setTimeout(
      () => {
        timer = undefined
        flush()
      },
      Math.max(0, settleMs),
    )
    ;(timer as { unref?: () => void }).unref?.()
  }

  // A synchronous flush inside `pagehide` issues the writes before navigation
  // where a timer never fires (the side cache's old guard, kept).
  let detachPageHide: (() => void) | undefined
  const target = (
    globalThis as { window?: { addEventListener?: unknown; removeEventListener?: unknown } }
  ).window
  if (
    typeof target?.addEventListener === 'function' &&
    typeof target.removeEventListener === 'function'
  ) {
    const onPageHide = (): void => flush()
    ;(target.addEventListener as (type: string, listener: () => void) => void)(
      'pagehide',
      onPageHide,
    )
    detachPageHide = () =>
      (target.removeEventListener as (type: string, listener: () => void) => void)(
        'pagehide',
        onPageHide,
      )
  }

  return {
    async load(sessionId: SessionId, limit: number) {
      const page = await store.readNewest(sessionId, limit)
      // Remembered even under a pending write: the rows ARE stored, and the
      // write's diff must see them or it would rewrite the whole chat.
      if (page.messages.length > 0) remember(sessionId, page)
      return toEntry(page)
    },
    async loadBefore(sessionId: SessionId, beforeId: string, limit: number) {
      if (pending.has(sessionId)) flush()
      const before = mirrors.get(sessionId)?.get(beforeId)
      if (!before) return undefined
      const page = await store.readBefore(sessionId, before.seq, limit)
      remember(sessionId, page)
      return toEntry(page)
    },
    write(sessionId: SessionId, window, writeOptions?: TranscriptCacheWriteOptions) {
      if (disposed) return
      const replace = (pending.get(sessionId)?.replace ?? false) || writeOptions?.replace === true
      pending.set(sessionId, { window, replace })
      schedule()
    },
    hold(sessionId: SessionId) {
      holds.set(sessionId, (holds.get(sessionId) ?? 0) + 1)
      const release = store.hold(sessionId)
      let released = false
      return () => {
        if (released) return
        released = true
        release()
        const count = (holds.get(sessionId) ?? 1) - 1
        if (count > 0) return void holds.set(sessionId, count)
        holds.delete(sessionId)
        if (!pending.has(sessionId)) mirrors.delete(sessionId)
      }
    },
    flush,
    dispose() {
      if (disposed) return
      flush()
      disposed = true
      detachPageHide?.()
      mirrors.clear()
    },
  }
}

/**
 * The same cache for a conversation whose transcript session changes under a
 * fixed conversation id (the phone's superagent thread): every call goes to the
 * session `resolve` names at that moment, and nothing is stored without one.
 */
export function transcriptCacheFor(
  cache: TranscriptCache,
  resolve: () => SessionId | undefined,
): TranscriptCache {
  return {
    async load(_id, limit) {
      const sid = resolve()
      return sid ? cache.load(sid, limit) : undefined
    },
    async loadBefore(_id, beforeId, limit) {
      const sid = resolve()
      return sid ? cache.loadBefore(sid, beforeId, limit) : undefined
    },
    write(_id, window, options) {
      const sid = resolve()
      if (sid) cache.write(sid, window, options)
    },
    hold(_id) {
      const sid = resolve()
      return sid && cache.hold ? cache.hold(sid) : () => {}
    },
  }
}
