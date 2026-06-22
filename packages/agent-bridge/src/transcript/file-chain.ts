import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeProjectSlug } from '../agent-state/claude-code.js'
import { findCodexRolloutPath } from '../agent-state/codex.js'
import { grokSessionPaths } from '../agent-state/grok.js'
import { cursorSessionPaths } from '../cursor/paths.js'

export interface ChainEntry {
  path: string
  fileId: string
}

export function fileIdFor(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 12)
}

/** Ordered oldest→newest JSONL files that make up a session's transcript. */
export async function resolveFileChain(input: {
  agentKind: string
  cwd: string
  resumeValue?: string
  homeDir?: string
}): Promise<ChainEntry[]> {
  const paths = await resolvePaths(input)
  return paths.map((p) => ({ path: p, fileId: fileIdFor(p) }))
}

async function resolvePaths(input: {
  agentKind: string
  cwd: string
  resumeValue?: string
  homeDir?: string
}): Promise<string[]> {
  const home = input.homeDir ?? homedir()
  if (input.agentKind === 'claude-code') {
    // The cwd bucket holds this conversation's files; a resume rolls into a new
    // file. Chain every .jsonl in the bucket by mtime (oldest→newest). The active
    // file is the newest; older rolls precede it. (Scoping to a single lineage is
    // a future refinement; chaining the bucket is correct because resumes share it.)
    const dir = join(home, '.claude', 'projects', claudeProjectSlug(input.cwd))
    return await sortedJsonlByMtime(dir)
  }
  // codex/grok/cursor are file-based: resolve the single transcript path from the
  // resume value (the same resolvers the daemon's resolveTranscriptSource uses) and
  // return a one-entry chain. One file per resume is the contract today; multi-file
  // rolls for these harnesses are a future refinement. opencode is SQLite-backed and
  // handled by a separate DB adapter — it stays [].
  if (!input.resumeValue) return []
  if (input.agentKind === 'codex') {
    // Codex stores no derivable per-cwd path; resolve the rollout from the resume
    // value (state DB, then filename fallback). null/undefined → no chain.
    const path = await findCodexRolloutPath({ resumeValue: input.resumeValue, homeDir: home })
    return path ? [path] : []
  }
  if (input.agentKind === 'cursor') {
    const path = cursorSessionPaths({
      cwd: input.cwd,
      chatId: input.resumeValue,
      homeDir: home,
    }).transcriptPath
    return (await fileExists(path)) ? [path] : []
  }
  if (input.agentKind === 'grok') {
    const path = grokSessionPaths({
      cwd: input.cwd,
      sessionId: input.resumeValue,
      homeDir: home,
    }).chatHistoryPath
    return (await fileExists(path)) ? [path] : []
  }
  return []
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function sortedJsonlByMtime(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'))
  } catch {
    return []
  }
  const withMtime = await Promise.all(
    names.map(async (n) => {
      const p = join(dir, n)
      try {
        return { p, m: (await stat(p)).mtimeMs }
      } catch {
        return { p, m: 0 }
      }
    }),
  )
  // Deterministic on equal mtimes: filename ascending breaks ties.
  return withMtime.sort((a, b) => a.m - b.m || a.p.localeCompare(b.p)).map((x) => x.p)
}
