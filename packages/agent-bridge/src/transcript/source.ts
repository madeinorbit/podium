import { homedir } from 'node:os'
import { fileChainSource, recordToItemsForKind, type TranscriptSource } from '@podium/transcript'
import { harnessAdapterFor } from '../harness/registry.js'

// Compat re-exports: the storage-neutral source layer moved to @podium/transcript;
// the opencode SQLite binding lives in its harness adapter.
export {
  fileChainSource,
  recordToItemsForKind,
  sliceItemsByAnchor,
  stampOpencodeItems,
  type TranscriptSource,
} from '@podium/transcript'
export { opencodeDbSource } from '../harness/adapters/opencode.js'

/**
 * Resolve the right `TranscriptSource` for a session by harness — a lookup into
 * the adapter registry: each adapter's `transcript.sourceFor` knows its storage
 * (file chain vs opencode's SQLite). Unknown kinds (including 'shell') read as
 * an empty file-chain source, matching the pre-registry behavior. Async because
 * the file harnesses resolve their chain from disk.
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
  const adapter = harnessAdapterFor(input.agentKind)
  if (!adapter) return fileChainSource([], recordToItemsForKind(input.agentKind))
  return adapter.transcript.sourceFor({
    cwd: input.cwd,
    ...(input.resumeValue !== undefined ? { resumeValue: input.resumeValue } : {}),
    ...(input.pathHint !== undefined ? { pathHint: input.pathHint } : {}),
    homeDir: input.homeDir ?? homedir(),
  })
}
