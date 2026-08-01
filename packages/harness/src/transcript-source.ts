import { homedir } from 'node:os'
import {
  type ChainEntry,
  fileChainSource,
  fileIdFor,
  type TranscriptSource,
} from '@podium/transcript'
import { declaredValue } from './manifest.js'
import { manifestFor } from './registry.js'

/** Ordered oldest→newest JSONL files that make up a session's transcript.
 *  Dispatches to the manifest's `transcript.chainPaths` — each file-based
 *  harness resolves the SPECIFIC conversation by its resume value (a cwd bucket
 *  holds many DISTINCT conversations, so globbing would merge unrelated
 *  sessions). No resume value, an unknown kind, a harness whose transcript
 *  support is declared unsupported, or a non-file harness (opencode's SQLite
 *  store) ⇒ []. */
export async function resolveFileChain(input: {
  agentKind: string
  cwd: string
  resumeValue?: string
  pathHint?: string
  homeDir?: string
}): Promise<ChainEntry[]> {
  const manifest = manifestFor(input.agentKind)
  const transcript = manifest && declaredValue(manifest.transcript)
  const chainPaths = transcript && declaredValue(transcript.chainPaths)
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
 * the manifest registry: each manifest's `transcript.sourceFor` knows its storage
 * (file chain vs opencode's SQLite). Unknown kinds (including 'shell') and
 * harnesses whose transcript support is declared unsupported read as an empty
 * file-chain source, matching the pre-registry behavior — the session still runs,
 * it just has no readable history. Async because the file harnesses resolve their
 * chain from disk.
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
  const manifest = manifestFor(input.agentKind)
  const transcript = manifest && declaredValue(manifest.transcript)
  if (!transcript) return fileChainSource([], () => [])
  return transcript.sourceFor({
    cwd: input.cwd,
    ...(input.resumeValue !== undefined ? { resumeValue: input.resumeValue } : {}),
    ...(input.pathHint !== undefined ? { pathHint: input.pathHint } : {}),
    homeDir: input.homeDir ?? homedir(),
  })
}
