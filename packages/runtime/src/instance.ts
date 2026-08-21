/**
 * First-class Podium instance identity and namespaces. [spec:SP-15aa]
 *
 * `default` is the compatibility instance: it keeps every historical path,
 * port, executable, service, and durable-session label. Named instances use
 * validated ids so the same value is safe in paths, systemd unit names, and
 * process/runtime labels.
 */
import type { SessionId } from '@podium/model'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join, resolve } from 'node:path'

export const DEFAULT_INSTANCE_ID = 'default'
export const INSTANCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** Linux `sockaddr_un.sun_path`: 108 bytes including the terminating NUL. */
export const LINUX_SUN_PATH_BYTES = 108
export const LINUX_UNIX_SOCKET_PATH_BYTES = LINUX_SUN_PATH_BYTES - 1

/**
 * Longest instance component in a packaged abduco socket on Linux.
 *
 * The bounded root is `/tmp/pd-<10-byte-key>`. With the packaged `podium` user,
 * a 12-byte Docker hostname, `podium-` label prefix, UUID session id, separators,
 * and abduco's own `abduco/<user>/` directory plus `@<hostname>` suffix, 90 bytes
 * are fixed. That leaves 17 bytes of Linux's 107 usable pathname bytes; 18 would
 * fill byte 108 and leave no room for the required NUL. Keep the arithmetic pinned
 * in instance.test.ts rather than making the next socket change rediscover it.
 */
export const DURABLE_INSTANCE_COMPONENT_BYTES = 17
export const INSTANCE_SOCKET_KEY_BYTES = 10

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

function stableKey(value: string, bytes: number): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, bytes)
}

/** Stable label component shared by the server and every reconnecting daemon. */
export function durableInstanceComponent(instanceId: string): string {
  const id = validateInstanceId(instanceId)
  if (Buffer.byteLength(id) <= DURABLE_INSTANCE_COMPONENT_BYTES) return id
  // Instance ids must start with a letter, so the leading `0` makes hashed and
  // literal components disjoint as well as deterministic.
  return `0${stableKey(id, DURABLE_INSTANCE_COMPONENT_BYTES - 1)}`
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

export type InstanceServiceRole =
  | 'parent'
  | 'server'
  | 'daemon'
  | 'janitor'
  | 'update'
  | 'web'
  | 'redeploy'
  | 'health'

export function instanceServiceName(
  role: InstanceServiceRole,
  instanceId: string = resolveInstanceId(),
): string {
  const id = validateInstanceId(instanceId)
  // The single parent supervisor is `podium.service` (named: `podium-<id>.service`),
  // not `podium-parent.service`. Spec §3 / POD-2506.
  if (role === 'parent') {
    return id === DEFAULT_INSTANCE_ID ? 'podium.service' : `podium-${id}.service`
  }
  if (id !== DEFAULT_INSTANCE_ID) return `podium-${id}-${role}.service`
  return role === 'update' ? 'podium-update-user.service' : `podium-${role}.service`
}

export function instanceUpdateTimerName(instanceId: string = resolveInstanceId()): string {
  const id = validateInstanceId(instanceId)
  return id === DEFAULT_INSTANCE_ID ? 'podium-update-user.timer' : `podium-${id}-update.timer`
}

/** Instance-scoped timer names used by the dev-host health supervisor. */
export function instanceTimerName(
  role: 'update' | 'health',
  instanceId: string = resolveInstanceId(),
): string {
  if (role === 'update') return instanceUpdateTimerName(instanceId)
  const id = validateInstanceId(instanceId)
  return id === DEFAULT_INSTANCE_ID ? 'podium-health.timer' : `podium-${id}-health.timer`
}

/** Stable durable PTY/scope identity; default keeps pre-instance labels reattachable. */
export function durableSessionLabel(
  sessionId: SessionId,
  instanceId: string = resolveInstanceId(),
): string {
  const id = validateInstanceId(instanceId)
  return id === DEFAULT_INSTANCE_ID
    ? `podium-${sessionId}`
    : `podium-${durableInstanceComponent(id)}-${sessionId}`
}

/** Exact pathname abduco constructs for a relative durable label. */
export function abducoSocketPathname(
  socketDir: string,
  label: string,
  username: string,
  host: string,
): string {
  return join(socketDir, 'abduco', username, `${label}@${host}`)
}

/** Exact pathname tmux constructs for `tmux -L <label>`. */
export function tmuxSocketPathname(socketDir: string, label: string, uid: number): string {
  return join(socketDir, `tmux-${uid}`, label)
}

export function linuxUnixSocketPathFits(path: string): boolean {
  return Buffer.byteLength(path) <= LINUX_UNIX_SOCKET_PATH_BYTES
}

/** Fail before a native tool can reduce the diagnosis to `Filename too long`. */
export function assertLinuxUnixSocketPath(
  path: string,
  instanceId: string,
  purpose: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'linux' || linuxUnixSocketPathFits(path)) return
  const bytes = Buffer.byteLength(path)
  throw new Error(
    `Podium instance '${instanceId}' cannot create ${purpose}: the ${bytes}-byte socket path exceeds Linux sun_path (${LINUX_SUN_PATH_BYTES} bytes including the terminator; ${LINUX_UNIX_SOCKET_PATH_BYTES} pathname bytes usable): ${path}`,
  )
}

/**
 * Short deterministic root for named-instance Unix sockets whose legacy
 * state-owned path cannot fit. The state root participates in the key so two
 * intentionally separate deployments using the same id do not share sockets.
 */
export function instanceSocketRuntimeDir(
  instanceId: string,
  dir: string = instanceStateDir(instanceId),
  uid: number = typeof process.getuid === 'function' ? process.getuid() : 0,
): string {
  const id = validateInstanceId(instanceId)
  const key = stableKey(`${uid}\0${id}\0${resolve(dir)}`, INSTANCE_SOCKET_KEY_BYTES)
  return join('/tmp', `pd-${key}`)
}

function currentUsername(): string {
  try {
    return userInfo().username
  } catch {
    return typeof process.getuid === 'function' ? String(process.getuid()) : 'unknown'
  }
}

/**
 * Stable endpoint triplet. Operators may override each port in config/env; the
 * derived named-instance slot is a convenient default. A rare hash collision is
 * resolved by setting explicit ports; until then the server port fails at bind
 * time, while the daemon's hook and agent-relay ports move to an ephemeral port
 * and raise a machine diagnostic rather than taking the daemon down with them
 * (POD-1229, docs/multi-instance.md).
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
  const sessionId = '00000000-0000-4000-8000-000000000000' as SessionId
  const label = durableSessionLabel(sessionId, id)
  const shortDir = instanceSocketRuntimeDir(id, dir)
  if (!env.ABDUCO_SOCKET_DIR) {
    const legacyDir = join(dir, 'runtime', 'abduco')
    const projected = abducoSocketPathname(legacyDir, label, currentUsername(), hostname())
    env.ABDUCO_SOCKET_DIR = linuxUnixSocketPathFits(projected) ? legacyDir : shortDir
    mkdirSync(env.ABDUCO_SOCKET_DIR, { recursive: true, mode: 0o700 })
  }
  if (!env.TMUX_TMPDIR) {
    const legacyDir = join(dir, 'runtime', 'tmux')
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0
    const projected = tmuxSocketPathname(legacyDir, label, uid)
    env.TMUX_TMPDIR = linuxUnixSocketPathFits(projected) ? legacyDir : shortDir
    mkdirSync(env.TMUX_TMPDIR, { recursive: true, mode: 0o700 })
  }
  return env
}
