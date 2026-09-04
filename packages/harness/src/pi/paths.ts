import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/**
 * Pi's on-disk layout (verified against pi 0.84.4, `session-manager.js`):
 *
 *   <agent dir>/auth.json
 *   <agent dir>/models.json
 *   <agent dir>/sessions/--<cwd slug>--/<timestamp>_<uuid>.jsonl
 *
 * `<agent dir>` defaults to `~/.pi/agent` and is relocated wholesale by
 * `PI_CODING_AGENT_DIR`; `PI_CODING_AGENT_SESSION_DIR` relocates only the
 * sessions tree. The slug drops the leading separator and turns `/`, `\` and `:`
 * into `-`. The file name carries a creation timestamp BEFORE the id, so a
 * session's path is located (`*_<id>.jsonl`), never derived.
 */

export type PiEnvironment = Readonly<Record<string, string | undefined>>

export function piAgentDir(homeDir?: string, env: PiEnvironment = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim()
  if (override) return override
  return join(homeDir ?? homedir(), '.pi', 'agent')
}

export function piSessionsRoot(homeDir?: string, env: PiEnvironment = process.env): string {
  const override = env.PI_CODING_AGENT_SESSION_DIR?.trim()
  if (override) return override
  return join(piAgentDir(homeDir, env), 'sessions')
}

/** Pi's per-cwd session bucket name: `--<cwd with separators dashed>--`. */
export function piCwdSlug(cwd: string): string {
  return `--${resolve(cwd)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`
}

/** Best-effort decode of a bucket name back to an absolute POSIX path. Lossy
 *  (a `-` in the original path is indistinguishable from a separator), so the
 *  header's own `cwd` field wins whenever it is readable. */
export function piCwdFromSlug(slug: string): string | undefined {
  const match = /^--(.*)--$/.exec(slug)
  if (!match?.[1]) return undefined
  return `/${match[1].replace(/-/g, '/')}`
}

export function piSessionDir(cwd: string, homeDir?: string): string {
  return join(piSessionsRoot(homeDir), piCwdSlug(cwd))
}

/** The session id a Pi session file name carries (`<timestamp>_<uuid>.jsonl`). */
export function piSessionIdFromPath(path: string): string | undefined {
  const name = basename(path)
  if (!name.endsWith('.jsonl')) return undefined
  const stem = name.slice(0, -'.jsonl'.length)
  const underscore = stem.lastIndexOf('_')
  const id = underscore >= 0 ? stem.slice(underscore + 1) : stem
  return id || undefined
}

async function sessionFileIn(dir: string, sessionId: string): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return undefined
  }
  const suffix = `_${sessionId}.jsonl`
  // Newest timestamp prefix wins should two files ever carry one id (a fork keeps
  // the ORIGINAL file, so this is defensive rather than expected).
  const matches = entries.filter((name) => name.endsWith(suffix)).sort()
  const name = matches.at(-1)
  return name ? join(dir, name) : undefined
}

/**
 * Locate a Pi session's JSONL by id. Looks in the current cwd's bucket first,
 * then every bucket under the sessions root — Pi files a session under the cwd
 * it was CREATED in, while `cwd` here is the session's current worktree
 * (docs/spec/conversation-registry.md §3.3: locate, don't derive).
 */
export async function locatePiSessionFile(opts: {
  cwd: string
  sessionId: string
  homeDir?: string
  pathHint?: string
}): Promise<string | undefined> {
  if (opts.pathHint && piSessionIdFromPath(opts.pathHint) === opts.sessionId) {
    const hinted = await sessionFileIn(join(opts.pathHint, '..'), opts.sessionId)
    if (hinted) return hinted
  }
  const direct = await sessionFileIn(piSessionDir(opts.cwd, opts.homeDir), opts.sessionId)
  if (direct) return direct
  const root = piSessionsRoot(opts.homeDir)
  let buckets: string[]
  try {
    buckets = await readdir(root)
  } catch {
    return undefined
  }
  for (const bucket of buckets.sort()) {
    const found = await sessionFileIn(join(root, bucket), opts.sessionId)
    if (found) return found
  }
  return undefined
}
