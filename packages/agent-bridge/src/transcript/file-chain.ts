import { homedir } from 'node:os'
import { type ChainEntry, fileIdFor } from '@podium/transcript'
import { harnessAdapterFor } from '../harness/registry.js'

// Compat re-exports: the pure chain primitives moved to @podium/transcript;
// only the per-harness resolution (below, via the adapter registry) stays here.
export { type ChainEntry, fileIdFor } from '@podium/transcript'

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
