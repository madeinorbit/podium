import { homedir } from 'node:os'
import {
  type ChainEntry,
  fileChainSource,
  fileIdFor,
  recordToItemsForKind,
  type TranscriptSource,
} from '@podium/transcript'
import { harnessAdapterFor } from './registry.js'

/** Ordered oldest→newest JSONL files that make up a session's transcript.
 *  Dispatches to the harness adapter's `transcript.chainPaths` — each file-based
 *  harness resolves the SPECIFIC conversation by its resume value (a cwd bucket
 *  holds many DISTINCT conversations, so globbing would merge unrelated
 *  sessions). No resume value, an unknown kind, or a non-file harness
 *  (opencode's SQLite store) ⇒ []. */
export async function resolveFileChain(input: {
  agentKind: string
  cwd: string
  resumeValue?: string
  pathHint?: string
  homeDir?: string
}): Promise<ChainEntry[]> {
  const chainPaths = harnessAdapterFor(input.agentKind)?.transcript.chainPaths
  if (!chainPaths) return []
  const paths = await chainPaths({
    cwd: input.cwd,
    ...(input.resumeValue !== undefined ? { resumeValue: input.resumeValue } : {}),
    ...(input.pathHint !== undefined ? { pathHint: input.pathHint } : {}),
    homeDir: input.homeDir ?? homedir(),
  })
  return paths.map((p) => ({ path: p, fileId: fileIdFor(p) }))
}

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
