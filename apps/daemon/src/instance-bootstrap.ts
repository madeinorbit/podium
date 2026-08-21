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
  const instanceDir = instanceStateDir(instanceId)
  applyInstanceRuntimeEnv(instanceId, process.env, instanceDir)

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
    runtimeDir,
    settingsDir,
    ...(hookSocketPath ? { hookSocketPath } : {}),
    codexReceiptDir: opts?.receiptDir ?? join(runtimeDir, 'codex-identity-receipts'),
  }
}
