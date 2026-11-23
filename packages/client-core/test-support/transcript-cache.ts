import type { SessionId, TranscriptItem } from '@podium/model'
import type {
  TranscriptCache,
  TranscriptCacheEntry,
  TranscriptCacheWriteOptions,
} from '../src/transcript/contracts'

export interface FakeTranscriptCache extends TranscriptCache {
  /** Every write, with its window read at the moment of the write. */
  readonly writes: {
    sessionId: SessionId
    items: readonly TranscriptItem[]
    options?: TranscriptCacheWriteOptions
  }[]
  /** The window of the newest write. */
  lastWindow(): readonly TranscriptItem[] | undefined
}

/** A device store that answers `load` with `stored` and keeps nothing else. */
export function fakeTranscriptCache(stored?: TranscriptCacheEntry): FakeTranscriptCache {
  const writes: FakeTranscriptCache['writes'] = []
  return {
    writes,
    lastWindow: () => writes.at(-1)?.items,
    load: async () => stored,
    loadBefore: async () => undefined,
    write: (sessionId, window, options) => {
      writes.push({ sessionId, items: window(), ...(options ? { options } : {}) })
    },
  }
}

/** Let a transcript's stored-page read land (it is async since POD-5801). */
export async function storedReadSettled(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}
