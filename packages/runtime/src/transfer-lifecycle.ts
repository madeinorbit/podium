/**
 * Server-transfer lifecycle: the durable config conversions and process-role transition
 * each side of a cutover boots through. [spec:SP-9f5e] — file/digest/journal concerns live
 * in the coordinator; this module owns ONLY
 *
 *  1. the SOURCE's conversion from host (all-in-one/server) to daemon mode, pointed at the
 *     new server URL — with a pre-cutover config copy kept for rollback, because a stale
 *     all-in-one config that gets re-read after cutover is how a second server starts;
 *  2. the TARGET's promotion to server mode (durable, idempotent — the target keeps its
 *     own machine identity; its daemon may keep running under `keep`);
 *  3. a role-transition PLAN and a supervisor-medated executor that converts the live role
 *     set to the mode's role set WITHOUT ever starting a server role that is already live
 *     (the "never a second server" invariant), and that can be told to KEEP a role that
 *     must not be stopped (the daemon asking the target to promote itself runs AS the
 *     daemon — stopping the daemon would kill the very request in flight).
 *
 * The supervisor seam is explicit and injected: this module never shells out to arbitrary
 * paths, never spawns a process, and never calls systemctl. `apps/cli` binds it to the
 * real detached-spawn / systemd adapters; `apps/daemon` binds it to whatever host seams
 * its control layer resolves.
 */
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { configPath, loadConfig, type PodiumConfig, resolvePort, saveConfig } from './config'
import type { RunRole } from './run-registry'
import { assertConfigWritable, ephemeralTunnelWarning, validatePublicUrl, wssFrom } from './setup'

/** The roles that must be running for a given deployment mode. `client` and unset host
 *  nothing; `all-in-one` is the desktop sidecar (server + janitor + daemon in one PID). */
export function rolesForMode(mode: PodiumConfig['mode']): RunRole[] {
  if (mode === 'all-in-one') return ['server', 'janitor', 'daemon']
  if (mode === 'server') return ['server', 'janitor']
  if (mode === 'daemon') return ['daemon']
  return []
}

/** The four role ids a machine can run, in plan order. */
export const MACHINE_ROLES: RunRole[] = ['server', 'janitor', 'daemon', 'all-in-one']

/**
 * Validate + ws-ify a server URL exactly the way a daemon dials it. Accepts http(s) or
 * ws(s); anything else throws. Pure.
 */
export function normalizeServerUrl(url: string): string {
  const v = validatePublicUrl(url.replace(/^ws(s?):\/\//, (_m, s) => `http${s}://`))
  if (!v.ok) throw new Error(`not a server URL: ${v.error}`)
  return wssFrom(v.normalized)
}

export interface SourceDemotionInput {
  /** Stable transfer UUID; scopes rollback state across repeated transfers on this machine. */
  transferId: string
  /** The new server URL the old host must dial: http(s):// or ws(s)://, ws-ified after. */
  serverUrl: string
}
export interface SourceDemotionResult {
  /** False when the box is already a daemon dialing exactly this URL (idempotent retry). */
  changed: boolean
  serverUrl: string
  /** Path of the pre-cutover config copy — the coordinator's rollback until explicit cleanup. */
  backupPath?: string
  /** Exact host config to restore if post-proof source role transition cannot complete. */
  previousConfig: PodiumConfig
  warning?: string
}

function syncPath(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function syncParent(path: string): void {
  syncPath(dirname(path))
}

function removeTemp(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

const TRANSFER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function assertTransferId(transferId: string): void {
  if (!TRANSFER_ID_PATTERN.test(transferId)) {
    throw new Error('server transfer id must be a UUID')
  }
}

/**
 * Replace config.json atomically and durably. Normal setup writes are intentionally simple,
 * but a server-role transfer is a crash boundary: after this returns, a reboot must observe
 * the new role. The temporary file is validated through saveConfig before its file and parent
 * directory are fsync'd around the atomic rename.
 */
function saveTransferConfig(config: PodiumConfig): void {
  const path = configPath()
  const tempPath = join(dirname(path), `.config-transfer-${process.pid}-${randomUUID()}.tmp`)
  try {
    saveConfig(config, tempPath)
    syncPath(tempPath)
    renameSync(tempPath, path)
    syncParent(path)
  } finally {
    removeTemp(tempPath)
  }
}

/** Create the rollback copy once, without a crash-visible partial backup. */
function preserveSourceConfig(path: string, backupPath: string): void {
  if (existsSync(backupPath)) return
  const tempPath = join(dirname(path), `.config-backup-${process.pid}-${randomUUID()}.tmp`)
  try {
    copyFileSync(path, tempPath)
    syncPath(tempPath)
    try {
      // link is atomic and refuses to replace another cutover's already-durable backup.
      linkSync(tempPath, backupPath)
      syncParent(backupPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    removeTemp(tempPath)
  }
}

function preserveConfigValue(config: PodiumConfig, backupPath: string): void {
  if (existsSync(backupPath)) return
  const tempPath = join(dirname(backupPath), `.config-backup-${process.pid}-${randomUUID()}.tmp`)
  try {
    saveConfig(config, tempPath)
    syncPath(tempPath)
    try {
      linkSync(tempPath, backupPath)
      syncParent(backupPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    removeTemp(tempPath)
  }
}

/**
 * The SOURCE side of a cutover: convert a host (all-in-one/server) config to daemon mode
 * pointed at the new server URL.
 *
 * - Durably writes `mode: daemon` + `serverUrl` (ws(s)-ified), preserving every machine/
 *   persistence field and dropping the host-only `publicUrl` (and any consumed one-shot
 *   `pairCode`) exactly like {@link applyJoin}.
 * - Copies the pre-cutover config to a transfer-id-scoped backup so the operation stays
 *   reversible until the coordinator's explicit cleanup, and refuses a corrupt/invalid config
 *   the same way every setup mutation does.
 * - IDEMPOTENT: a retry of a change that already landed (daemon mode + the same URL) is a
 *   no-op — it never re-takes a backup and never re-writes the file.
 *
 * A stale host config is the exact way a second server comes up after a cutover (the old
 * `podium server` / `podium-server.service` re-launch), so `mode` MUST change here before
 * (or atomically with) the post-response role transition.
 */
export function applySourceDemotion(input: SourceDemotionInput): SourceDemotionResult {
  assertTransferId(input.transferId)
  assertConfigWritable()
  const serverUrl = normalizeServerUrl(input.serverUrl)
  const prev = loadConfig()
  if (prev.mode === 'daemon' && prev.serverUrl !== serverUrl) {
    throw new Error(
      `this box is already a daemon for ${prev.serverUrl}; refusing to replay a server transfer for ${serverUrl}`,
    )
  }
  if (prev.mode !== 'all-in-one' && prev.mode !== 'server' && prev.mode !== 'daemon') {
    throw new Error(
      `a server transfer can only cut over a host (all-in-one/server) box; this box is ${
        prev.mode ? `mode=${prev.mode}` : 'not configured'
      }`,
    )
  }
  const backupPath = hostConfigBackupPath(input.transferId)
  if (prev.mode !== 'daemon') {
    // Keep a copy of the exact pre-cutover config for rollback before the destructive write.
    preserveSourceConfig(configPath(), backupPath)
  }
  const {
    publicUrl: _hostOnly,
    pairCode: _consumedPairCode,
    mode: _oldMode,
    serverUrl: _oldServerUrl,
    ...rest
  } = prev
  const cfg: PodiumConfig = { ...rest, mode: 'daemon', serverUrl }
  if (
    prev.mode === 'daemon' &&
    prev.serverUrl === serverUrl &&
    prev.publicUrl === undefined &&
    prev.pairCode === undefined
  ) {
    const previousConfig = existsSync(backupPath) ? loadConfig(backupPath) : prev
    return {
      changed: false,
      serverUrl,
      previousConfig,
      ...(existsSync(backupPath) ? { backupPath } : {}),
    }
  }
  saveTransferConfig(cfg)
  const warning = ephemeralTunnelWarning(serverUrl)
  return {
    changed: true,
    serverUrl,
    ...(existsSync(backupPath) ? { backupPath } : {}),
    previousConfig: prev,
    ...(warning ? { warning } : {}),
  }
}

/** Coordinator-facing name for the durable, non-exiting half of source cutover. */
export const prepareSourceDaemonCutover = applySourceDemotion

/** Transfer-scoped recoverable copy of the source's pre-cutover host config. */
export function hostConfigBackupPath(transferId: string): string {
  assertTransferId(transferId)
  return join(dirname(configPath()), `config.json.backup-cutover-${transferId}`)
}

export interface TargetPromotionInput {
  /** Stable transfer UUID; scopes rollback state across repeated promotions on this machine. */
  transferId: string
  /** The new externally reachable HTTP(S) URL the imported server will serve. */
  publicUrl: string
  /** Optional explicit server port for the target (its config keeps its own default). */
  port?: number
}
export interface TargetPromotionResult {
  changed: boolean
  config: PodiumConfig
  /** Target daemon config retained for rollback before promotion becomes observable. */
  previousConfig: PodiumConfig
  backupPath?: string
}

/**
 * The TARGET side of a cutover: write the durable config that makes this machine host the
 * instance — `mode: server`, the new public URL, optional explicit port. The target's own
 * machine identity (machine.id / daemon secret) lives in separate state files and is never
 * touched here, so a later follow-up can offer all-in-one promotion without a re-import.
 *
 * IDEMPOTENT: replaying a promotion that already recorded this URL (and port, when given)
 * is a no-op. A client-mode target is refused (it has no local state to promote). A corrupt
 * config is refused like every setup mutation.
 */
export function applyTargetServerPromotion(input: TargetPromotionInput): TargetPromotionResult {
  assertTransferId(input.transferId)
  assertConfigWritable()
  const v = validatePublicUrl(input.publicUrl)
  if (!v.ok) throw new Error(`not a valid public URL: ${v.error}`)
  const port = input.port
  const prev = loadConfig()
  if (prev.mode !== 'daemon' && prev.mode !== 'server') {
    throw new Error(
      `a server-transfer target must be a paired daemon; this box is ${
        prev.mode ? `mode=${prev.mode}` : 'not configured'
      }`,
    )
  }
  const backupPath = targetConfigBackupPath(input.transferId)
  const backupExists = existsSync(backupPath)
  let previousConfig = backupExists ? loadConfig(backupPath) : prev
  // Current target staging writes mode=server/publicUrl before invoking restartAfterTransfer.
  // Recover the paired-daemon shape from fields applySetup retains and persist it before save.
  if (!backupExists && prev.mode === 'server' && prev.serverUrl) {
    const { mode: _promotedMode, publicUrl: _promotedUrl, ...daemonConfig } = prev
    previousConfig = { ...daemonConfig, mode: 'daemon' }
  }
  if (
    prev.mode === 'server' &&
    prev.publicUrl === v.normalized &&
    (port === undefined || prev.port === port) &&
    prev.serverUrl === undefined &&
    prev.pairCode === undefined
  ) {
    return {
      changed: false,
      config: prev,
      previousConfig,
      ...(backupExists ? { backupPath } : {}),
    }
  }
  const {
    serverUrl: _oldServerUrl,
    pairCode: _consumedPairCode,
    mode: _oldMode,
    publicUrl: _oldPublicUrl,
    ...rest
  } = prev
  const cfg: PodiumConfig = {
    ...rest,
    mode: 'server',
    publicUrl: v.normalized,
    ...(port !== undefined ? { port } : {}),
  }
  // The rollback state must be durable before config.json becomes server authority.
  if (prev.mode === 'daemon') preserveSourceConfig(configPath(), backupPath)
  else if (!backupExists && previousConfig.mode === 'daemon') {
    preserveConfigValue(previousConfig, backupPath)
  }
  saveTransferConfig(cfg)
  return {
    changed: true,
    config: cfg,
    previousConfig,
    ...(existsSync(backupPath) ? { backupPath } : {}),
  }
}

export function targetConfigBackupPath(transferId: string): string {
  assertTransferId(transferId)
  return join(dirname(configPath()), `config.json.backup-server-promotion-${transferId}`)
}

// ---------------------------------------------------------------------------
// Role transition
// ---------------------------------------------------------------------------

/** What a role transition says must run and must be torn down — pure, testable. */
export interface RoleTransitionPlan {
  desired: RunRole[]
  /** Roles currently live that must stop (not desired AND not kept). */
  toStop: RunRole[]
  /** Roles desired that are not live yet — exactly who must start. */
  toStart: RunRole[]
  /** Kept managed roles that must remain live for a reply but must not be resurrected. */
  toDisarm: RunRole[]
}

export function planRoleTransition(opts: {
  mode: PodiumConfig['mode']
  live: RunRole[]
  /** Supervisor-managed roles that may restart even when no PID is currently registered. */
  managed?: RunRole[]
  /** Roles that must NOT be stopped even when the desired mode drops them. */
  keep?: RunRole[]
}): RoleTransitionPlan {
  const desired = rolesForMode(opts.mode)
  const kept = new Set(opts.keep ?? [])
  const live = new Set(opts.live)
  const managed = new Set(opts.managed ?? [])
  const present = new Set([...opts.live, ...managed])
  return {
    desired,
    toStop: [...present].filter((role) => !desired.includes(role) && !kept.has(role)),
    toStart: desired.filter((role) => !live.has(role)),
    toDisarm: [...present].filter(
      (role) => !desired.includes(role) && kept.has(role) && managed.has(role),
    ),
  }
}

/**
 * The explicit process/supervisor seam. Implemented by each host (apps/cli detached+systemd,
 * apps/daemon control) — this module never spawns or calls systemctl itself.
 */
export interface RoleSupervisor {
  /** Is this role's process live right now (run-registry + PID liveness)? */
  roleLive(role: RunRole): boolean
  /** Whether a supervisor can resurrect this role (for example, an enabled systemd unit).
   *  Defaults to roleLive when omitted. */
  roleManaged?(role: RunRole): boolean
  /** Stop the role for good: kill the holder AND make sure its managed unit cannot restore
   *  itself (disable the unit, then reclaim the detached/foreground holder). */
  stopRole(role: RunRole): Promise<void>
  /** Prevent a managed role from being resurrected without stopping its current process.
   *  Used by target promotion so the daemon can carry lost-reply retries until explicit ack. */
  disarmRole?(role: RunRole): Promise<void>
  /** Start one role from scratch (spawn detached, or install+enable+start its unit). */
  startRole(role: RunRole, ctx: { port: number; serverUrl?: string }): Promise<void>
  /** Probe whether the local server instance is answering health on `port`. */
  serverUp(port: number): Promise<boolean>
}

export interface RoleTransitionResult {
  stopped: RunRole[]
  started: RunRole[]
  disarmed: RunRole[]
  serverUp: boolean
}

/**
 * Execute a role transition through the injected supervisor: plan from CURRENT live roles
 * to the desired mode, stop the leftovers (unless kept), start the missing roles, and
 * finally probe server health when the desired mode runs a server. The plan guarantees no
 * `server` is started when one is already live.
 */
export async function runRoleTransition(
  opts: {
    mode: PodiumConfig['mode']
    port: number
    keep?: RunRole[]
    supervisor: RoleSupervisor
  },
  serverUrl?: string,
): Promise<RoleTransitionResult> {
  const { mode, port, keep, supervisor } = opts
  const live = MACHINE_ROLES.filter((role) => supervisor.roleLive(role))
  const managed = MACHINE_ROLES.filter((role) =>
    supervisor.roleManaged ? supervisor.roleManaged(role) : supervisor.roleLive(role),
  )
  const plan = planRoleTransition({ mode, live, managed, keep })

  const stopped: RunRole[] = []
  for (const role of plan.toStop) {
    await supervisor.stopRole(role)
    stopped.push(role)
  }
  const disarmed: RunRole[] = []
  for (const role of plan.toDisarm) {
    await supervisor.disarmRole?.(role)
    disarmed.push(role)
  }
  const started: RunRole[] = []
  const ctx = { port, ...(serverUrl ? { serverUrl } : {}) }
  for (const role of plan.toStart) {
    await supervisor.startRole(role, ctx)
    started.push(role)
  }
  const serverUp = plan.desired.includes('server') ? await supervisor.serverUp(port) : false
  return { stopped, started, disarmed, serverUp }
}

export interface TargetServerRuntimeOutcome {
  promotion: TargetPromotionResult
  roleTransition: RoleTransitionResult
  /** A target is not promoted until its serving process passes this real health probe. */
  proven: boolean
}

/**
 * Promote a staged target's machine role after portable state validation. The calling daemon is
 * retained after the proof so a lost promote reply can be retried through the same daemon. Managed
 * resurrection is disarmed during promotion; only an explicit post-ack seam may retire the live
 * daemon. A failed start leaves durable server mode in place, so retrying this function resumes the
 * missing roles instead of restoring stale daemon authority.
 */
export async function promoteTargetServer(
  input: TargetPromotionInput,
  supervisor: RoleSupervisor,
): Promise<TargetServerRuntimeOutcome> {
  const promotion = applyTargetServerPromotion(input)
  const port = resolvePort(promotion.config)
  const roleTransition = await runRoleTransition({
    mode: 'server',
    port,
    keep: ['daemon'],
    supervisor,
  })
  return { promotion, roleTransition, proven: roleTransition.serverUp }
}
