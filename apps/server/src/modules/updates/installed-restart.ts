import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planConvergence, type UpdateTarget } from '@podium/protocol'
import { resolveInstallDir } from '@podium/runtime/config'
import { readAppliedMigrations } from '@podium/runtime/migration-ledger'
import { requestParentHandover } from '@podium/runtime/parent-control'
import {
  fetchArtifact,
  PODIUM_UPDATE_PUBKEY,
  type DeliveryDeps,
} from '@podium/runtime/update-delivery'
import { swapHeadlessBundle } from '@podium/runtime/update-install'
import { createSchemaGate } from '@podium/runtime/update-schema'

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

export interface InstalledRestartDeps {
  instanceId: string
  port: () => number
  env?: NodeJS.ProcessEnv
  /**
   * After swap, ask the parent to self-handover. Injectable for tests.
   * Defaults to {@link requestParentHandover}.
   */
  requestHandover?: (expectedVersion: string) => { ok: true; pid: number } | { ok: false; reason: string }
  /** Last prepared target version; set by createInstalledCoordinatorUpdate. */
  pendingVersion?: () => string | undefined
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
 * target before the parent self-handovers onto it.
 *
 * Schema-gate → verified fetch → atomic swap (retains `.old`) → VERSION re-read
 * fence. The subsequent restart is parent self-handover, not systemctl/detached
 * fork (POD-2505).
 *
 * Only active when a parent supervises this process (`PODIUM_UNDER_PARENT=1`) or
 * the legacy installed markers (`INVOCATION_ID` / `PODIUM_RUN_MODE=detached`) are
 * still present during migration.
 */
export function createInstalledCoordinatorUpdate(
  deps: InstalledUpdateDeps = {},
): ((target: UpdateTarget) => Promise<void>) | undefined {
  const env = deps.env ?? process.env
  const supervised =
    Boolean(env.INVOCATION_ID) ||
    env.PODIUM_RUN_MODE === 'detached' ||
    env.PODIUM_UNDER_PARENT === '1'
  if (!supervised) return undefined
  const installDir = deps.installDir ?? resolveInstallDir(env)
  const platform = deps.platform ?? runningPlatform()
  const swap = deps.swap ?? ((bytes, dir) => swapHeadlessBundle(bytes, dir))
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
 * Ask the supervising parent to self-handover onto the already-swapped bundle.
 *
 * Retires the systemd `systemctl restart` and detached `--takeover` fork paths.
 * When no parent is registered (hand-started foreground), returns a no-op that
 * logs nothing here — the operation layer surfaces machine-cannot-restart for
 * unsupervised shapes (disposition 6).
 */
export function createInstalledCoordinatorRestart(
  deps: InstalledRestartDeps,
): (() => void) | undefined {
  const env = deps.env ?? process.env
  const supervised =
    Boolean(env.INVOCATION_ID) ||
    env.PODIUM_RUN_MODE === 'detached' ||
    env.PODIUM_UNDER_PARENT === '1'
  if (!supervised) return undefined

  const requestHandover =
    deps.requestHandover ??
    ((expectedVersion: string) =>
      requestParentHandover({ expectedVersion, performSwap: false }))

  let requested = false
  let lastVersion: string | undefined

  // Allow the update step to stash the version for the restart closure.
  const pending = deps.pendingVersion

  return () => {
    if (requested) return
    requested = true
    const expectedVersion =
      pending?.() ??
      lastVersion ??
      (() => {
        try {
          return installedVersion(resolveInstallDir(env))
        } catch {
          return env.PODIUM_APP_VERSION
        }
      })()
    if (!expectedVersion) {
      throw new Error('parent handover requires an expected version')
    }
    lastVersion = expectedVersion
    const result = requestHandover(expectedVersion)
    if (!result.ok) {
      throw new Error(
        `machine-cannot-restart: no supervising parent to hand over to (${result.reason})`,
      )
    }
  }
}
