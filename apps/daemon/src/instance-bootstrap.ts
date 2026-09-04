import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '@podium/runtime/config'
import {
  applyInstanceRuntimeEnv,
  assertLinuxUnixSocketPath,
  ensureInstanceStateIdentity,
  instanceSocketRuntimeDir,
  instanceStateDir,
  linuxUnixSocketPathFits,
  resolveInstanceId,
} from '@podium/runtime/instance'
import {
  acquireInstanceSingleton,
  acquireStateRootLock,
  type InstanceGuardHandle,
  type InstanceGuardIo,
} from '@podium/runtime/instance-guard'

export interface DaemonInstanceBootstrap {
  readonly instanceId: string
  readonly instanceUuid: string
  readonly runtimeDir: string
  readonly settingsDir: string
  readonly hookSocketPath?: string
  /** Release the daemon's root/UUID ownership and restore the parent env. */
  readonly releaseGuards: () => void
  readonly codexReceiptDir: string
}

/**
 * Establish the deployment partition before any config, binding, or durable
 * label is read. InstanceId remains deployment substrate, never a user boundary:
 * this extraction adds no per-user path and no `instance_id` row discriminator.
 */
export function bootstrapDaemonInstance(opts?: {
  settingsDir?: string
  /** Production startup acquires both ownership guards; tests may leave them off. */
  acquireGuards?: boolean
  guardIo?: InstanceGuardIo
  guardDir?: string
  socketPath?: string
  receiptDir?: string
  platform?: NodeJS.Platform
}): DaemonInstanceBootstrap {
  const instanceId = resolveInstanceId()
  const identity = ensureInstanceStateIdentity({ instanceId })
  const instanceDir = instanceStateDir(instanceId)
  applyInstanceRuntimeEnv(instanceId, process.env, instanceDir)
  const previousUuid = process.env.PODIUM_INSTANCE_UUID
  const previousSessionId = process.env.PODIUM_SESSION_ID
  process.env.PODIUM_INSTANCE_UUID = identity.instanceUuid
  // The daemon itself is not a session child. A daemon launched from inside a
  // Podium terminal inherits that terminal's session id; leaving it in place
  // would make the daemon itself match a later session reap.
  delete process.env.PODIUM_SESSION_ID

  let stateGuard: InstanceGuardHandle | undefined
  let singletonGuard: (InstanceGuardHandle & { machineWide: boolean }) | undefined
  let released = false
  const releaseGuards = (): void => {
    if (released) return
    released = true
    singletonGuard?.release()
    stateGuard?.release()
    if (previousUuid === undefined) delete process.env.PODIUM_INSTANCE_UUID
    else process.env.PODIUM_INSTANCE_UUID = previousUuid
    if (previousSessionId === undefined) delete process.env.PODIUM_SESSION_ID
    else process.env.PODIUM_SESSION_ID = previousSessionId
  }
  if (opts?.acquireGuards) {
    const root = stateDir()
    try {
      stateGuard = acquireStateRootLock({
        stateDir: root,
        instanceUuid: identity.instanceUuid,
        ...(opts.guardIo ? { io: opts.guardIo } : {}),
      })
      singletonGuard = acquireInstanceSingleton({
        instanceUuid: identity.instanceUuid,
        stateDir: root,
        env: process.env,
        ...(opts.guardIo ? { io: opts.guardIo } : {}),
        ...(opts.guardDir ? { guardDir: opts.guardDir } : {}),
      })
    } catch (error) {
      releaseGuards()
      throw error
    }
  }

  const settingsDir = opts?.settingsDir ?? join(stateDir(), 'hooks')
  // An explicit settings directory is also the isolation root for tests/embedders.
  const runtimeDir = opts?.settingsDir ?? join(instanceDir, 'runtime')
  const platform = opts?.platform ?? process.platform
  let hookSocketPath: string | undefined
  if (platform !== 'win32') {
    const legacyPath = opts?.socketPath ?? join(runtimeDir, 'codex-hooks.sock')
    hookSocketPath = legacyPath
    if (!opts?.socketPath && platform === 'linux' && !linuxUnixSocketPathFits(legacyPath)) {
      const socketDir = instanceSocketRuntimeDir(instanceId, opts?.settingsDir ?? instanceDir)
      mkdirSync(socketDir, { recursive: true, mode: 0o700 })
      hookSocketPath = join(socketDir, 'codex-hooks.sock')
    }
    assertLinuxUnixSocketPath(hookSocketPath, instanceId, 'the Codex hook socket', platform)
  }
  return {
    instanceId,
    instanceUuid: identity.instanceUuid,
    runtimeDir,
    settingsDir,
    ...(hookSocketPath ? { hookSocketPath } : {}),
    codexReceiptDir: opts?.receiptDir ?? join(runtimeDir, 'codex-identity-receipts'),
    releaseGuards,
  }
}
