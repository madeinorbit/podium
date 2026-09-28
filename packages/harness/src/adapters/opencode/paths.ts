import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * OpenCode's filesystem layout, stated once beside the adapter that owns it
 * (POD-4737 D3) — data root, session stores and binary resolution. Pure path
 * arithmetic plus existence checks; the SQLite readers in `opencode/db.ts`
 * build on these rather than restating them, and so does discovery's
 * default-roots rule.
 */

export function opencodeDataRoot(homeDir?: string): string {
  return join(homeDir ?? homedir(), '.local', 'share', 'opencode')
}

export function opencodeDbPath(homeDir?: string): string {
  return join(opencodeDataRoot(homeDir), 'opencode.db')
}
/**
 * The OpenCode store for a fresh interactive Podium session.
 *
 * OpenCode's normal store is keyed by directory, so it cannot be shared by two
 * terminal sessions in one cwd. Keep the Podium id out of the filesystem path
 * itself: session ids are opaque input, while this hash gives every session a
 * stable, collision-resistant file under Podium's own data area.
 */
export function opencodeSessionDbPath(
  homeDir: string | undefined,
  podiumSessionId: string,
): string {
  const key = createHash('sha256').update(podiumSessionId).digest('hex')
  return join(homeDir ?? homedir(), '.local', 'share', 'podium', 'opencode', `${key}.db`)
}

/**
 * Select the database for one interactive session.
 *
 * Fresh sessions always get their own store. A resumed session whose isolated
 * store already exists uses it; otherwise it is an older session created before
 * isolation existed, so preserve its legacy shared store and rely on its exact
 * native resume id. The latter fallback is safe for reads and lets old sessions
 * continue to launch without silently losing their history.
 */
export function opencodeDbPathForSession(input: {
  homeDir?: string
  podiumSessionId?: string
  resumeValue?: string
}): string | undefined {
  if (!input.podiumSessionId) return undefined
  const path = opencodeSessionDbPath(input.homeDir, input.podiumSessionId)
  return !input.resumeValue || existsSync(path) ? path : undefined
}
