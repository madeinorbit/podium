import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeProjectSlug } from '../agent-state/claude-code.js'

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
}): Promise<ChainEntry[]> {
  const paths = await resolvePaths(input)
  return paths.map((p) => ({ path: p, fileId: fileIdFor(p) }))
}

async function resolvePaths(input: {
  agentKind: string
  cwd: string
  resumeValue?: string
}): Promise<string[]> {
  if (input.agentKind === 'claude-code') {
    // The cwd bucket holds this conversation's files; a resume rolls into a new
    // file. Chain every .jsonl in the bucket by mtime (oldest→newest). The active
    // file is the newest; older rolls precede it. (Scoping to a single lineage is
    // a future refinement; chaining the bucket is correct because resumes share it.)
    const dir = join(homedir(), '.claude', 'projects', claudeProjectSlug(input.cwd))
    return await sortedJsonlByMtime(dir)
  }
  // codex/grok/cursor/opencode: their existing discovery already finds the active
  // rollout/session file. Reuse the single resolved path; chaining is per-harness
  // and added in their resolver (Task B2b wires each harness's discovery here).
  return []
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
  return withMtime.sort((a, b) => a.m - b.m).map((x) => x.p)
}
