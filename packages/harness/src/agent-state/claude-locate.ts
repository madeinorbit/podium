import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** Claude's per-project transcript dir name: the cwd with every non-alphanumeric
 *  character flattened to '-' (verified against real hook payloads, CLI 2.1.173). */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Locate a Claude Code session's JSONL (docs/spec/conversation-registry.md §3.3).
 *
 * Claude buckets transcripts by the cwd the conversation was CREATED under
 * (`~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl`), while Podium's
 * `session.cwd` is mutable — it restamps when the agent moves worktrees. Deriving
 * the path from the current cwd therefore looks in the wrong bucket after a move
 * (or after the original worktree was deleted) — the "transcript can't be loaded"
 * bug. The filename, however, IS the native session id, which is unique across
 * buckets — so on an exact-path miss, sweep every bucket for it.
 *
 * Resolution order: exact derived path (the overwhelmingly common case — one
 * stat) → bucket sweep (one readdir + one stat per bucket, miss path only).
 * Newest mtime wins the freak case of the same id in two buckets.
 */
export async function locateClaudeSessionFile(opts: {
  cwd: string
  resumeValue: string
  /** Recorded segment evidence (server-known absolute path) — checked FIRST, so
   *  the common moved-worktree read costs one stat instead of a bucket sweep. */
  pathHint?: string
  homeDir?: string
}): Promise<string | null> {
  // The hint is evidence for WHERE the file lives (moved worktrees), never for
  // WHICH file the session is: a poisoned registry path (e.g. a subagent
  // transcript once registered under the parent's native id, issue #94) must not
  // make boot classification read a different conversation's timestamps.
  if (
    opts.pathHint &&
    basename(opts.pathHint) === `${opts.resumeValue}.jsonl` &&
    (await isFile(opts.pathHint))
  )
    return opts.pathHint
  const home = opts.homeDir ?? homedir()
  const projects = join(home, '.claude', 'projects')
  const exact = join(projects, claudeProjectSlug(opts.cwd), `${opts.resumeValue}.jsonl`)
  if (await isFile(exact)) return exact
  let buckets: string[]
  try {
    buckets = (await readdir(projects, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return null // no projects dir at all — nothing to sweep
  }
  const candidates: { path: string; mtimeMs: number }[] = []
  for (const bucket of buckets) {
    const p = join(projects, bucket, `${opts.resumeValue}.jsonl`)
    try {
      const st = await stat(p)
      if (st.isFile()) candidates.push({ path: p, mtimeMs: st.mtimeMs })
    } catch {
      // not in this bucket
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0]?.path ?? null
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
