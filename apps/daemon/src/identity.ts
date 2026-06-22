import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the daemon's identity file lives. Overridable for tests/isolated state. */
function dirFor(dir?: string): string {
  return dir ?? process.env.PODIUM_STATE_DIR ?? join(homedir(), '.podium')
}

export interface DaemonIdentity {
  /** Stable UUID join key — the cross-restart machine identity. */
  machineId: string
  /** The paired auth token, once issued (absent until the first successful pair). */
  token?: string
}

/**
 * Read (or, on first run, create) `~/.podium/daemon.json`. The `machineId` is a
 * stable UUID minted once and reused forever — it is the join key a server uses to
 * recognize a returning daemon, so it must outlive both token rotations and the
 * server's own database. Generating it persists the file immediately so a crash
 * between mint and use can't hand out two ids for one machine.
 */
export function loadIdentity(opts: { dir?: string } = {}): DaemonIdentity {
  const base = dirFor(opts.dir)
  const path = join(base, 'daemon.json')
  let data: { machineId?: string; token?: string } = {}
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // First run (or unreadable/corrupt) — start fresh and rewrite below.
  }
  if (!data.machineId) {
    data.machineId = randomUUID()
    mkdirSync(base, { recursive: true })
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 })
  }
  return { machineId: data.machineId, ...(data.token ? { token: data.token } : {}) }
}

/**
 * Persist the auth token the server minted at pairing. Merges into the existing
 * file (preserving the machineId) rather than overwriting, so a token write never
 * costs the machine its stable identity.
 */
export function saveToken(token: string, opts: { dir?: string } = {}): void {
  const base = dirFor(opts.dir)
  const path = join(base, 'daemon.json')
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // No file yet — saveToken can land before the first loadIdentity.
  }
  data.token = token
  mkdirSync(base, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 })
}
