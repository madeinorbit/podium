import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type HarnessEnvironment, selectedRoot } from '../../manifest.js'

/**
 * OpenCode's filesystem layout, stated once beside the adapter that owns it
 * (POD-4737 D3) — data root, session stores and binary resolution. Pure path
 * arithmetic plus existence checks; the SQLite readers in `opencode/db.ts`
 * build on these rather than restating them, and so does discovery's
 * default-roots rule.
 */

/**
 * OpenCode's data root: `XDG_DATA_HOME/opencode`, else
 * `<home>/.local/share/opencode` — the manifest's `roots` rule (POD-6534).
 * The selector is read only from the env a caller passes (an account env),
 * never from the daemon's own `process.env`.
 */
export function opencodeDataRoot(homeDir: string, env: HarnessEnvironment = {}): string {
  return join(selectedRoot(env, 'XDG_DATA_HOME', homeDir, join('.local', 'share')), 'opencode')
}

export function opencodeDbPath(homeDir: string, env: HarnessEnvironment = {}): string {
  return join(opencodeDataRoot(homeDir, env), 'opencode.db')
}
/**
 * The OpenCode store for a fresh interactive Podium session.
 *
 * OpenCode's normal store is keyed by directory, so it cannot be shared by two
 * terminal sessions in one cwd. Keep the Podium id out of the filesystem path
 * itself: session ids are opaque input, while this hash gives every session a
 * stable, collision-resistant file under Podium's own data area.
 */
export function opencodeSessionDbPath(homeDir: string, podiumSessionId: string): string {
  const key = createHash('sha256').update(podiumSessionId).digest('hex')
  return join(homeDir, '.local', 'share', 'podium', 'opencode', `${key}.db`)
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
  homeDir: string
  podiumSessionId?: string
  resumeValue?: string
}): string | undefined {
  if (!input.podiumSessionId) return undefined
  const path = opencodeSessionDbPath(input.homeDir, input.podiumSessionId)
  return !input.resumeValue || existsSync(path) ? path : undefined
}
