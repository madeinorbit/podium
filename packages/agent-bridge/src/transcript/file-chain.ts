import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
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
  // Every file-based harness resolves the SPECIFIC conversation by its resume value.
  // A cwd bucket holds many DISTINCT conversations (every session ever run in that
  // dir writes its own <id>.jsonl), so globbing the bucket merges unrelated sessions
  // into one transcript — never do that. Without a resume value we can't identify
  // the file, so return [] and let the live tail start from the hook's transcript_path
  // instead of guessing a sibling. opencode is SQLite-backed (separate DB adapter).
  if (!input.resumeValue) return []
  if (input.agentKind === 'claude-code') {
    // The claude session_id (resume value) IS the JSONL basename in the cwd bucket;
    // resolve exactly that file (matching the daemon's tailResumeTranscript path).
    const path = join(
      home,
      '.claude',
      'projects',
      claudeProjectSlug(input.cwd),
      `${input.resumeValue}.jsonl`,
    )
    return (await fileExists(path)) ? [path] : []
  }
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
