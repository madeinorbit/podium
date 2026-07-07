import {
  fileChainSource,
  type OpencodeMessagePartRow,
  recordToItemsForKind,
  sliceItemsByAnchor,
  stampOpencodeItems,
  type TranscriptSource,
} from '@podium/transcript'
import { loadOpencodeTranscriptTail, openOpencodeDb } from '../opencode/db.js'
import { resolveFileChain } from './file-chain.js'

// Compat re-exports: the storage-neutral source layer moved to @podium/transcript;
// only the per-harness resolution (locators + the opencode SQLite binding) stays here.
export {
  fileChainSource,
  recordToItemsForKind,
  sliceItemsByAnchor,
  stampOpencodeItems,
  type TranscriptSource,
} from '@podium/transcript'

/**
 * Source for opencode. opencode stores transcript "parts" in SQLite ordered by
 * `(time_updated ASC, id ASC)`. A single session's parts are bounded (≤8000, the
 * `loadOpencodeTranscriptTail` cap), so loading them in one indexed query is
 * cheap and IS the bounded read — there is no per-call full-DB scan beyond this
 * one session's capped part list. We then build the full ordered item list and
 * index-slice it in memory, exactly matching `readTranscriptSlice`'s semantics.
 */
export function opencodeDbSource(input: { sessionId: string; homeDir?: string }): TranscriptSource {
  return {
    readSlice: async (opts) => {
      if (opts.limit <= 0) return { items: [], hasMore: false }
      const db = openOpencodeDb(input.homeDir)
      if (!db) return { items: [], hasMore: false }
      let rows: OpencodeMessagePartRow[]
      try {
        rows = loadOpencodeTranscriptTail(db, input.sessionId)
      } catch {
        return { items: [], hasMore: false }
      } finally {
        db.close()
      }
      // ASC by (time_updated, id); each part expands to 0..N stamped items in
      // intra-part order, so `all` is the session's full transcript in total order.
      const all = stampOpencodeItems(rows, input.sessionId)
      return sliceItemsByAnchor(all, opts)
    },
  }
}

/**
 * Resolve the right `TranscriptSource` for a session by harness. opencode is
 * SQLite-backed (no file chain); every other harness resolves a file chain from
 * disk and reads it via the chain reader. Async because the file harnesses
 * resolve their chain from disk.
 */
export async function transcriptSourceFor(input: {
  agentKind: string
  cwd: string
  resumeValue?: string
  /** Recorded segment evidence: absolute transcript path, checked before any
   *  cwd-derived location (conversation registry §3.3). */
  pathHint?: string
  homeDir?: string
}): Promise<TranscriptSource> {
  if (input.agentKind === 'opencode') {
    // No resume value → nothing to read; hand back an inert empty source so the
    // caller need not special-case it.
    if (!input.resumeValue) {
      return { readSlice: async () => ({ items: [], hasMore: false }) }
    }
    return opencodeDbSource({
      sessionId: input.resumeValue,
      ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
    })
  }
  const chain = await resolveFileChain(input)
  return fileChainSource(chain, recordToItemsForKind(input.agentKind))
}
