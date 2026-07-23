/**
 * First-class Podium instance identity and namespaces. [spec:SP-15aa]
 *
 * `default` is the compatibility instance: it keeps every historical path,
 * port, executable, service, and durable-session label. Named instances use
 * validated ids so the same value is safe in paths, systemd unit names, and
 * process/runtime labels.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_INSTANCE_ID = 'default'
export const INSTANCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

export type InstanceEnv = Readonly<Record<string, string | undefined>>

export function validateInstanceId(value: string): string {
  const id = value.trim()
  if (!INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(
      `invalid Podium instance id '${value}': use 1-32 lowercase letters, digits, or hyphens, starting with a letter`,
    )
  }
  return id
}

/** PODIUM_INSTANCE, else the legacy-compatible `default` identity. */
export function resolveInstanceId(env: InstanceEnv = process.env): string {
  return validateInstanceId(env.PODIUM_INSTANCE?.trim() || DEFAULT_INSTANCE_ID)
}

export interface InstanceSelection {
  instanceId: string
  argv: string[]
  /** True only when argv carried --instance (rather than env/default). */
  explicit: boolean
}

/**
 * Strip the global `--instance <id>` / `--instance=<id>` selector from argv.
 * It may appear before or after a subcommand; duplicate selectors are refused
 * so command routing can never depend on argument order.
 */
export function selectInstance(
  argv: readonly string[],
  env: InstanceEnv = process.env,
): InstanceSelection {
  let selected: string | undefined
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (token === '--instance') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error('--instance requires an id')
      if (selected !== undefined) throw new Error('--instance may be specified only once')
      selected = value
      i++
      continue
    }
    if (token.startsWith('--instance=')) {
      if (selected !== undefined) throw new Error('--instance may be specified only once')
      selected = token.slice('--instance='.length)
      continue
    }
    rest.push(token)
  }
  return {
    instanceId: validateInstanceId(selected ?? env.PODIUM_INSTANCE ?? DEFAULT_INSTANCE_ID),
    argv: rest,
    explicit: selected !== undefined,
  }
}

/**
 * State root for an instance. An explicit PODIUM_STATE_DIR always wins.
 * `default` keeps ~/.podium; named instances use the XDG state tree and never
 * sit inside the default root (so default purge/update operations cannot reach them).
 */
export function instanceStateDir(
  instanceId: string = resolveInstanceId(),
  env: InstanceEnv = process.env,
  home: string = env.HOME || homedir(),
): string {
  const id = validateInstanceId(instanceId)
  if (env.PODIUM_STATE_DIR) return env.PODIUM_STATE_DIR
  if (id === DEFAULT_INSTANCE_ID) return join(home, '.podium')
  const stateHome = env.XDG_STATE_HOME || join(home, '.local', 'state')
  return join(stateHome, 'podium', id)
}

/** Default installed bundle root; PODIUM_HOME remains the runtime override. */
export function instanceInstallDir(
  instanceId: string = resolveInstanceId(),
  env: InstanceEnv = process.env,
  home: string = env.HOME || homedir(),
): string {
  const id = validateInstanceId(instanceId)
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share')
  return id === DEFAULT_INSTANCE_ID
    ? join(dataHome, 'podium')
    : join(dataHome, 'podium-instances', id)
}

export function instanceCommandName(instanceId: string = resolveInstanceId()): string {
  const id = validateInstanceId(instanceId)
  return id === DEFAULT_INSTANCE_ID ? 'podium' : `podium-${id}`
}

export type InstanceServiceRole = 'server' | 'daemon' | 'janitor' | 'update'

export function instanceServiceName(
  role: InstanceServiceRole,
  instanceId: string = resolveInstanceId(),
): string {
  const id = validateInstanceId(instanceId)
  if (id !== DEFAULT_INSTANCE_ID) return `podium-${id}-${role}.service`
  return role === 'update' ? 'podium-update-user.service' : `podium-${role}.service`
}

export function instanceUpdateTimerName(instanceId: string = resolveInstanceId()): string {
  const id = validateInstanceId(instanceId)
  return id === DEFAULT_INSTANCE_ID ? 'podium-update-user.timer' : `podium-${id}-update.timer`
}

/** Stable durable PTY/scope identity; default keeps pre-instance labels reattachable. */
export function durableSessionLabel(
  sessionId: string,
  instanceId: string = resolveInstanceId(),
): string {
  const id = validateInstanceId(instanceId)
  return id === DEFAULT_INSTANCE_ID ? `podium-${sessionId}` : `podium-${id}-${sessionId}`
}

/**
 * Stable endpoint triplet. Operators may override each port in config/env; the
 * derived named-instance slot is a convenient default. A rare hash collision
 * fails at bind time (never falls back to an unstable port) and is resolved by
 * setting explicit ports.
 */
export interface InstancePorts {
  server: number
  hook: number
  agentRelay: number
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (const byte of Buffer.from(value)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function defaultInstancePorts(instanceId: string = resolveInstanceId()): InstancePorts {
  const id = validateInstanceId(instanceId)
  if (id === DEFAULT_INSTANCE_ID) return { server: 18787, hook: 45777, agentRelay: 45778 }
  // 8,000 non-overlapping triplets in the unprivileged range 20000..43999.
  const base = 20_000 + (fnv1a(id) % 8_000) * 3
  return { server: base, hook: base + 1, agentRelay: base + 2 }
}

export interface InstanceStateIdentity {
  version: 1
  instanceId: string
}

export function instanceIdentityPath(dir: string = instanceStateDir()): string {
  return join(dir, 'instance.json')
}

/** Read and validate an existing state marker; missing returns undefined. */
export function readInstanceStateIdentity(
  dir: string = instanceStateDir(),
): InstanceStateIdentity | undefined {
  const path = instanceIdentityPath(dir)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`invalid Podium instance marker at ${path}: ${String(error)}`)
  }
  const marker = parsed as Partial<InstanceStateIdentity>
  if (marker.version !== 1 || typeof marker.instanceId !== 'string') {
    throw new Error(`invalid Podium instance marker at ${path}`)
  }
  return { version: 1, instanceId: validateInstanceId(marker.instanceId) }
}

/** Refuse a selected id that points at another instance's state root. */
export function assertInstanceStateIdentity(
  instanceId: string = resolveInstanceId(),
  dir: string = instanceStateDir(instanceId),
): void {
  const id = validateInstanceId(instanceId)
  const marker = readInstanceStateIdentity(dir)
  if (marker && marker.instanceId !== id) {
    throw new Error(
      `Podium instance '${id}' cannot use ${dir}: it belongs to instance '${marker.instanceId}'`,
    )
  }
}

/**
 * Claim a state root before a server/daemon/config write. A named instance will
 * not silently adopt a non-empty unmarked directory; PODIUM_ADOPT_STATE=1 is the
 * explicit migration escape hatch. Existing default ~/.podium installs are
 * marked in place for backward compatibility.
 */
export function ensureInstanceStateIdentity(
  opts: { instanceId?: string; dir?: string; env?: InstanceEnv } = {},
): InstanceStateIdentity {
  const env = opts.env ?? process.env
  const id = validateInstanceId(opts.instanceId ?? resolveInstanceId(env))
  const dir = opts.dir ?? instanceStateDir(id, env)
  const existing = readInstanceStateIdentity(dir)
  if (existing) {
    assertInstanceStateIdentity(id, dir)
    return existing
  }
  const entries = existsSync(dir) ? readdirSync(dir) : []
  if (entries.length > 0 && id !== DEFAULT_INSTANCE_ID && !env.PODIUM_ADOPT_STATE) {
    throw new Error(
      `refusing to adopt non-empty state directory ${dir} for instance '${id}'; choose an empty root or set PODIUM_ADOPT_STATE=1 for an intentional migration`,
    )
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const marker: InstanceStateIdentity = { version: 1, instanceId: id }
  try {
    writeFileSync(instanceIdentityPath(dir), `${JSON.stringify(marker, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
  } catch (error) {
    // Another process can claim the root between the read above and this exclusive
    // create (notably the detached daemon started by `setup --join`). Accept only a
    // complete marker for this exact instance; mismatches and malformed files still fail.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const raced = readInstanceStateIdentity(dir)
    if (!raced) throw error
    assertInstanceStateIdentity(id, dir)
    return raced
  }
  return marker
}

/**
 * Pin named-instance durable backend sockets to private state-owned roots.
 * Explicit ABDUCO_SOCKET_DIR/TMUX_TMPDIR values are preserved as an intentional
 * sharing/configuration choice. The default instance keeps legacy global sockets.
 */
export function applyInstanceRuntimeEnv(
  instanceId: string = resolveInstanceId(),
  env: NodeJS.ProcessEnv = process.env,
  dir: string = instanceStateDir(instanceId, env),
): NodeJS.ProcessEnv {
  const id = validateInstanceId(instanceId)
  env.PODIUM_INSTANCE = id
  if (id === DEFAULT_INSTANCE_ID) return env
  if (!env.ABDUCO_SOCKET_DIR) {
    env.ABDUCO_SOCKET_DIR = join(dir, 'runtime', 'abduco')
    mkdirSync(env.ABDUCO_SOCKET_DIR, { recursive: true, mode: 0o700 })
  }
  if (!env.TMUX_TMPDIR) {
    env.TMUX_TMPDIR = join(dir, 'runtime', 'tmux')
    mkdirSync(env.TMUX_TMPDIR, { recursive: true, mode: 0o700 })
  }
  return env
}
