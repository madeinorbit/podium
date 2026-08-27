import { join } from 'node:path'
import { stateDir } from '@podium/runtime/config'
import {
  applyInstanceRuntimeEnv,
  ensureInstanceStateIdentity,
  instanceStateDir,
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
  applyInstanceRuntimeEnv(instanceId)
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
  const runtimeDir = opts?.settingsDir ?? join(instanceStateDir(instanceId), 'runtime')
  const hookSocketPath =
    opts?.socketPath ??
    ((opts?.platform ?? process.platform) === 'win32'
      ? undefined
      : join(runtimeDir, 'codex-hooks.sock'))
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
