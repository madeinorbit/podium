/**
 * THE TRANSCRIPT STORE (POD-4471): the one reader over an abstract record
 * store, taking the harness grammar as a parameter.
 *
 * Grammars (native-record parsers, store layouts, runtime/color readers,
 * locators) live in `../adapters/<h>/transcript.ts`, one authoritative
 * definition per harness (spec §4): data plus pure functions, never a source.
 * This module keeps the source construction — the file-chain reader and the
 * host-only sqlite source — parameterized by the adapter's transcript section
 * (a narrow typed SUBSET of the adapter, never the whole Adapter): the Store
 * takes the grammar as its parameter, never the reverse (spec §5).
 *
 * Both sides construct their Store here: the daemon resolves the live session's
 * grammar from the adapter registry and reads the live source; the server's
 * transcript lake reads its mirror source through the same file-chain reader
 * with the same grammar, which is what makes live and mirrored ids identical
 * (spec rule 8).
 */
import type { HarnessTranscript, TranscriptSourceInput } from '../manifest.js'
import { declaredValue } from '../transcript-types.js'
import { fileIdFor } from './file-chain.js'
import { fileChainSource, type TranscriptSource } from './source.js'
import { sqliteTranscriptSource } from './sources/sqlite.js'

/**
 * Resolve a session's live transcript source from its adapter grammar — the
 * Store over the live record store. `file` grammars resolve their chain
 * through the section's `chainPaths` and read through the file-chain source;
 * `sqlite` grammars resolve through the section's `sqliteLocator` and read
 * through the host-only sqlite source. `stream` (no declarer yet) and unknown
 * harnesses (including shells) read as an empty file-chain source, so the
 * session runs with no readable history rather than failing the read.
 */
export async function transcriptSourceFromGrammar(
  grammar: HarnessTranscript,
  input: TranscriptSourceInput,
): Promise<TranscriptSource> {
  if (grammar.storage === 'sqlite') {
    // No resume value → nothing to read; hand back an inert empty source so
    // the caller need not special-case it.
    const locator = declaredValue(grammar.sqliteLocator)?.(input)
    if (!locator) return fileChainSource([], () => [])
    return sqliteTranscriptSource(locator)
  }
  const recordToItems = declaredValue(grammar.recordToItems)
  const chainPaths = declaredValue(grammar.chainPaths)
  const sessionIdentity = input.resumeValue
  if (!recordToItems || !chainPaths || !sessionIdentity) {
    return fileChainSource([], () => [])
  }
  const chain = (await chainPaths(input)).map((path) => ({
    path,
    fileId: fileIdFor(sessionIdentity),
  }))
  return fileChainSource(chain, recordToItems)
}
