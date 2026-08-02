import { join } from 'node:path'
import { stateDir } from '@podium/runtime/config'
import {
  applyInstanceRuntimeEnv,
  ensureInstanceStateIdentity,
  instanceStateDir,
  resolveInstanceId,
} from '@podium/runtime/instance'

export interface DaemonInstanceBootstrap {
  readonly instanceId: string
  readonly runtimeDir: string
  readonly settingsDir: string
  readonly hookSocketPath?: string
  readonly codexReceiptDir: string
}

/**
 * Establish the deployment partition before any config, binding, or durable
 * label is read. InstanceId remains deployment substrate, never a user boundary:
 * this extraction adds no per-user path and no `instance_id` row discriminator.
 */
export function bootstrapDaemonInstance(opts?: {
  settingsDir?: string
  socketPath?: string
  receiptDir?: string
  platform?: NodeJS.Platform
}): DaemonInstanceBootstrap {
  const instanceId = resolveInstanceId()
  ensureInstanceStateIdentity({ instanceId })
  applyInstanceRuntimeEnv(instanceId)

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
    runtimeDir,
    settingsDir,
    ...(hookSocketPath ? { hookSocketPath } : {}),
    codexReceiptDir: opts?.receiptDir ?? join(runtimeDir, 'codex-identity-receipts'),
  }
}
