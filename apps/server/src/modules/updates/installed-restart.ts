import { type SpawnOptions, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planConvergence, type UpdateTarget } from '@podium/protocol'
import { resolveInstallDir } from '@podium/runtime/config'
import { instanceServiceName } from '@podium/runtime/instance'
import { readAppliedMigrations } from '@podium/runtime/migration-ledger'
import {
  fetchArtifact,
  PODIUM_UPDATE_PUBKEY,
  type DeliveryDeps,
} from '@podium/runtime/update-delivery'
import { swapHeadlessBundle } from '@podium/runtime/update-install'
import { createSchemaGate } from '@podium/runtime/update-schema'

const DEFAULT_RESTART_DELAY_MS = 750
type SpawnedProcess = { unref(): void }

export interface InstalledRestartDeps {
  instanceId: string
  port: () => number
  env?: NodeJS.ProcessEnv
  execPath?: string
  /** Detached role preservation: server-only installations have no daemon to restore. */
  includeDaemon?: boolean
  delayMs?: number
  spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess
  schedule?: (callback: () => void, delayMs: number) => { unref?: () => void }
}

type VerifiedDelivery = (
  target: UpdateTarget,
  currentVersion: string,
  installDir: string,
) => Promise<Uint8Array>

export interface InstalledUpdateDeps {
  env?: NodeJS.ProcessEnv
  installDir?: string
  platform?: string
  pubkey?: string
  pinnedPubkey?: string
  fetch?: typeof fetch
  deliver?: VerifiedDelivery
  swap?: (bytes: Uint8Array, installDir: string) => Promise<void>
  readApplied?: () => readonly string[] | undefined
}

function runningPlatform(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const cpu =
    process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch
  return `${os}-${cpu}`
}

function installedVersion(installDir: string): string {
  return readFileSync(join(installDir, 'VERSION'), 'utf8').trim()
}

/**
 * Ensure an installed coordinator's own shared bundle is the operation's exact
 * target before its process manager restarts server and janitor.
 *
 * An all-in-one headless host normally reaches this point after its local daemon
 * swapped the shared directory, so this is a cheap equality check there. A
 * server-only host has no daemon and therefore performs the same verified feed
 * or pinned-bundle delivery itself. Re-reading VERSION after the atomic swap is
 * the fence against a rolling channel changing underneath an operation.
 */
export function createInstalledCoordinatorUpdate(
  deps: InstalledUpdateDeps = {},
): ((target: UpdateTarget) => Promise<void>) | undefined {
  const env = deps.env ?? process.env
  if (!env.INVOCATION_ID && env.PODIUM_RUN_MODE !== 'detached') return undefined
  const installDir = deps.installDir ?? resolveInstallDir(env)
  const platform = deps.platform ?? runningPlatform()
  const swap = deps.swap ?? swapHeadlessBundle
  const deliver: VerifiedDelivery =
    deps.deliver ??
    (async (target, currentVersion) => {
      const plan = planConvergence({
        current: currentVersion,
        target,
        caps: ['update.delivery.feed', 'update.delivery.bundle'],
        platform,
      })
      if (plan.action === 'already-current') return new Uint8Array()
      if (plan.action === 'cannot' || plan.delivery === 'git') {
        const reason = plan.action === 'cannot' ? plan.reason : 'git delivery is not installed'
        throw new Error(`coordinator cannot take ${target.version}: ${reason}`)
      }
      const deliveryDeps: DeliveryDeps = {
        fetch: deps.fetch ?? fetch,
        pubkey: deps.pubkey ?? PODIUM_UPDATE_PUBKEY,
        ...(deps.pinnedPubkey ? { pinnedPubkey: deps.pinnedPubkey } : {}),
      }
      const artifact = await fetchArtifact(plan.asset, plan.delivery, deliveryDeps)
      if (!('bytes' in artifact)) throw new Error('coordinator delivery produced no bundle bytes')
      return artifact.bytes
    })

  return async (target) => {
    const current = installedVersion(installDir)
    if (current === target.version) return
    const refusal = createSchemaGate({
      readApplied: deps.readApplied ?? readAppliedMigrations,
      currentVersion: current,
    })(target)
    if (refusal) throw new Error(refusal)
    const bytes = await deliver(target, current, installDir)
    if (bytes.byteLength > 0) await swap(bytes, installDir)
    const installed = installedVersion(installDir)
    if (installed !== target.version) {
      throw new Error(
        `coordinator installed ${installed || 'an unknown version'}, expected ${target.version}`,
      )
    }
  }
}

/**
 * Restart an installed coordinator after its local daemon has atomically
 * replaced the shared headless bundle. systemd is already a supervisor; the
 * detached setup path has none, so it starts replacement janitor, daemon, and
 * server processes itself, with the server last because its takeover ends this PID.
 */
export function createInstalledCoordinatorRestart(
  deps: InstalledRestartDeps,
): (() => void) | undefined {
  const env = deps.env ?? process.env
  const systemd = Boolean(env.INVOCATION_ID)
  const detached = env.PODIUM_RUN_MODE === 'detached'
  if (!systemd && !detached) return undefined

  const spawnProcess = deps.spawnProcess ?? spawn
  const schedule = deps.schedule ?? ((callback, delay) => setTimeout(callback, delay))
  let requested = false
  return () => {
    if (requested) return
    requested = true
    const timer = schedule(() => {
      if (systemd) {
        const child = spawnProcess(
          'systemctl',
          [
            '--user',
            '--no-block',
            'restart',
            instanceServiceName('janitor', deps.instanceId),
            instanceServiceName('server', deps.instanceId),
          ],
          { detached: true, stdio: 'ignore' },
        )
        child.unref()
        return
      }

      const nextEnv = { ...env, PODIUM_PORT: String(deps.port()) }
      const executable = deps.execPath ?? process.execPath
      const commands = [
        ['janitor', '--server', `http://127.0.0.1:${deps.port()}`, '--takeover'],
        ...(deps.includeDaemon === false ? [] : ([['daemon', '--local', '--takeover']] as const)),
        ['server', '--takeover'],
      ] as const
      for (const args of commands) {
        const child = spawnProcess(executable, args, {
          detached: true,
          stdio: 'ignore',
          env: nextEnv,
        })
        child.unref()
      }
    }, deps.delayMs ?? DEFAULT_RESTART_DELAY_MS)
    timer.unref?.()
  }
}
