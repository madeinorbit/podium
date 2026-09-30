import { readdirSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@podium/logger'
import {
  DEFAULT_INSTANCE_ID,
  instanceSocketRuntimeDir,
  instanceStateDir,
  resolveInstanceId,
} from '@podium/runtime/instance'

const log = createLogger('pty:durable')

/**
 * SESSIONS AN ABDUCO MASTER STILL HOLDS (POD-4986).
 *
 * Podium no longer builds, ships or spawns abduco. A session an older daemon
 * started under abduco keeps running in its master, but re-adopting it would
 * need the abduco binary, so this daemon does not. What it does instead is say
 * so — once per label, so the operator can tell a session that is still
 * running somewhere from one that died — and leave the master and its program
 * alone. Nothing here runs abduco, connects to a master or signals anything:
 * it only looks for the socket file.
 *
 * The directories are where abduco put its sockets for a Podium daemon: the
 * operator's own `ABDUCO_SOCKET_DIR`, abduco's personal root `$HOME/.abduco`,
 * the roots a named instance used to pin `ABDUCO_SOCKET_DIR` to
 * (`<state>/runtime/abduco`, the bounded `/tmp/pd-<key>`, the runtime-dir
 * ladder), and the temporary directory fall-through.
 */
function legacyAbducoSocketDirs(env: NodeJS.ProcessEnv): string[] {
  let user: string | undefined
  try {
    user = userInfo().username
  } catch {
    user = typeof process.getuid === 'function' ? String(process.getuid()) : undefined
  }
  const dirs: string[] = []
  const shared = (root: string | undefined): void => {
    if (root && user) dirs.push(join(root, 'abduco', user))
  }
  if (env.ABDUCO_SOCKET_DIR) {
    shared(env.ABDUCO_SOCKET_DIR)
    dirs.push(join(env.ABDUCO_SOCKET_DIR, 'abduco'), env.ABDUCO_SOCKET_DIR)
  }
  if (env.HOME) dirs.push(join(env.HOME, '.abduco'))
  const instance = resolveInstanceId(env)
  if (instance !== DEFAULT_INSTANCE_ID) {
    try {
      const state = instanceStateDir(instance, env)
      shared(join(state, 'runtime', 'abduco'))
      shared(instanceSocketRuntimeDir(instance, state))
    } catch {
      // no resolvable state dir: the remaining roots still apply
    }
    if (env.XDG_RUNTIME_DIR) {
      shared(join(env.XDG_RUNTIME_DIR, `podium-${instance}`))
      shared(join(env.XDG_RUNTIME_DIR, 'podium'))
    }
  }
  shared(env.TMPDIR)
  shared('/tmp')
  return dirs.filter((dir, i) => dirs.indexOf(dir) === i)
}

/** The abduco socket that holds `label`, or undefined. abduco names it `<label>@<host>`. */
export function legacyAbducoSocket(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const prefix = `${label}@`
  for (const dir of legacyAbducoSocketDirs(env)) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue
      const path = join(dir, name)
      try {
        if (statSync(path).isSocket()) return path
      } catch {
        // gone between readdir and stat
      }
    }
  }
  return undefined
}

const noted = new Set<string>()

/**
 * Log, once per label for this daemon's life, that an abduco master still holds
 * `label` and is being left alone. True when one was found.
 */
export function noteLegacyAbducoSession(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const socketPath = legacyAbducoSocket(label, env)
  if (!socketPath) return false
  if (!noted.has(label)) {
    noted.add(label)
    log.warn(
      'session is held by an abduco master, which this Podium no longer supports: not re-adopting it, and leaving its process running',
      { label, socketPath },
    )
  }
  return true
}

/** Tests only: forget which labels were already logged. */
export function resetLegacyAbducoNotesForTests(): void {
  noted.clear()
}
