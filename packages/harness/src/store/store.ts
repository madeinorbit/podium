/**
 * THE TRANSCRIPT STORE (POD-4471): the one reader over an abstract record
 * store, taking the harness grammar as a parameter.
 *
 * Grammars (native-record parsers, store layouts, runtime/color readers) live
 * in `../adapters/<h>/transcript.ts`, one authoritative definition per harness
 * (spec §4). This module keeps only the reader — tailer, slice + cache,
 * sources, cursor codec, identity stamping — and never names a harness: every
 * constructor below receives the adapter's transcript section (a narrow typed
 * SUBSET of the adapter, never the whole Adapter) and reads through it.
 *
 * Both sides construct their Store here: the daemon resolves the live session's
 * grammar from the adapter registry and reads the live source; the server's
 * transcript lake reads its mirror source through the same file-chain reader
 * with the same grammar, which is what makes live and mirrored ids identical
 * (spec rule 8).
 */
import type { HarnessTranscript, TranscriptSourceInput } from '../manifest.js'
import type { TranscriptSource } from './source.js'

/**
 * Resolve a session's live transcript source from its adapter grammar — the
 * Store over the live record store. The grammar carries its own `sourceFor`
 * (file chain or SQLite); the Store supplies the slice contract both serve.
 * Unknown harnesses (including shells) never reach here: the caller hands back
 * an empty file-chain source instead, so the session runs with no readable
 * history rather than failing the read.
 */
export function transcriptSourceFromGrammar(
  grammar: HarnessTranscript,
  input: TranscriptSourceInput,
): Promise<TranscriptSource> {
  return grammar.sourceFor(input)
}
