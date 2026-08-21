/**
 * The bundle swap, as the PARENT performs it [POD-2505, spec §8 disposition 11].
 *
 * "Server-only self-swap moves into the parent: the parent performs
 * schema-gate-before-fetch, verified fetch, swap, and the post-swap VERSION
 * re-read (the rolling-feed fence) for every shape, daemonless included."
 *
 * This used to live in `apps/server/src/modules/updates/installed-restart.ts`,
 * where the process replacing the bundle was the process running out of it. The
 * order of the four steps is the whole safety argument and is preserved exactly:
 *
 *  1. SCHEMA GATE BEFORE FETCH — a machine whose database has advanced past what
 *     the target can open must not spend a download to find that out, and must
 *     not have its bundle replaced at all.
 *  2. VERIFIED FETCH — signature-checked delivery; nothing hits disk unverified.
 *  3. ATOMIC SWAP — retains `.old` so the parent can roll back a crash-loop.
 *  4. VERSION RE-READ FENCE — read VERSION back off disk and require it to equal
 *     the target. A rolling feed can move under a long download; this is what
 *     catches "we installed something, but not what was asked for" before a
 *     handover commits to it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planConvergence, UpdateTarget } from '@podium/protocol'
import { canonicalMigrationName, readAppliedMigrations } from './migration-ledger'
import {
  fetchArtifact,
  PODIUM_UPDATE_PUBKEY,
  type DeliveryDeps,
} from './update-delivery'
import { swapHeadlessBundle } from './update-install'
import { createSchemaGate } from './update-schema'

export interface ParentUpdateSwapDeps {
  installDir: string
  env?: NodeJS.ProcessEnv
  platform?: string
  pubkey?: string
  pinnedPubkey?: string
  fetch?: typeof fetch
  /** Test seam for the whole verified-delivery leg. */
  deliver?: (target: UpdateTarget, currentVersion: string) => Promise<Uint8Array>
  swap?: (bytes: Uint8Array, installDir: string) => Promise<void>
  readApplied?: () => readonly string[] | undefined
  readInstalledVersion?: (installDir: string) => string
}

export interface ParentUpdateSwapResult {
  /** The version now on disk (post-fence, so it equals the target). */
  version: string
  /**
   * Did this release define migrations the database had not applied? Decision 4
   * makes rollback UNAVAILABLE when it did — going back across a migration needs
   * a database restore by hand, so the parent must report why instead of doing it.
   */
  releaseHadMigrations: boolean
  /** False when the bundle was already the target and nothing was written. */
  swapped: boolean
}

export function runningPlatform(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const cpu =
    process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch
  return `${os}-${cpu}`
}

function defaultInstalledVersion(installDir: string): string {
  return readFileSync(join(installDir, 'VERSION'), 'utf8').trim()
}

/**
 * Does `target` define migrations this database has not applied? Unknown
 * declarations (a target that says nothing about schema) count as NO new
 * migrations: decision 4 must not withhold rollback on a guess, and the schema
 * gate above has already refused every case where the unknown is dangerous.
 */
export function releaseCarriesNewMigrations(
  target: { schema?: { migrations?: readonly string[] } },
  applied: readonly string[] | undefined,
): boolean {
  const defines = target.schema?.migrations
  if (!defines || defines.length === 0) return false
  const have = new Set((applied ?? []).map(canonicalMigrationName))
  return defines.some((name) => !have.has(canonicalMigrationName(name)))
}

/**
 * Build the parent's swap step. Returns undefined-free: the parent always has an
 * install dir, and the caller decides whether a request warrants a swap at all.
 */
export function createParentUpdateSwap(
  deps: ParentUpdateSwapDeps,
): (target: UpdateTarget) => Promise<ParentUpdateSwapResult> {
  const installDir = deps.installDir
  const platform = deps.platform ?? runningPlatform()
  const swap = deps.swap ?? ((bytes, dir) => swapHeadlessBundle(bytes, dir))
  const readApplied = deps.readApplied ?? readAppliedMigrations
  const installedVersion = deps.readInstalledVersion ?? defaultInstalledVersion
  const deliver =
    deps.deliver ??
    (async (target: UpdateTarget, currentVersion: string): Promise<Uint8Array> => {
      const plan = planConvergence({
        current: currentVersion,
        target,
        caps: ['update.delivery.feed', 'update.delivery.bundle'],
        platform,
      })
      if (plan.action === 'already-current') return new Uint8Array()
      if (plan.action === 'cannot' || plan.delivery === 'git') {
        const reason = plan.action === 'cannot' ? plan.reason : 'git delivery is not installed'
        throw new Error(`this machine cannot take ${target.version}: ${reason}`)
      }
      const deliveryDeps: DeliveryDeps = {
        fetch: deps.fetch ?? fetch,
        pubkey: deps.pubkey ?? PODIUM_UPDATE_PUBKEY,
        ...(deps.pinnedPubkey ? { pinnedPubkey: deps.pinnedPubkey } : {}),
      }
      const artifact = await fetchArtifact(plan.asset, plan.delivery, deliveryDeps)
      if (!('bytes' in artifact)) throw new Error('delivery produced no bundle bytes')
      return artifact.bytes
    })

  return async (target: UpdateTarget): Promise<ParentUpdateSwapResult> => {
    const current = installedVersion(installDir)
    const applied = (() => {
      try {
        return readApplied()
      } catch {
        return undefined
      }
    })()
    const releaseHadMigrations = releaseCarriesNewMigrations(target, applied)
    if (current === target.version) {
      return { version: current, releaseHadMigrations, swapped: false }
    }
    // 1. Schema gate BEFORE the fetch — see the docblock.
    const refusal = createSchemaGate({ readApplied, currentVersion: current })(target)
    if (refusal) throw new Error(refusal)
    // 2. Verified fetch.
    const bytes = await deliver(target, current)
    // 3. Atomic swap; retains `.old` for rollback.
    if (bytes.byteLength > 0) await swap(bytes, installDir)
    // 4. VERSION re-read fence.
    const installed = installedVersion(installDir)
    if (installed !== target.version) {
      throw new Error(
        `installed ${installed || 'an unknown version'}, expected ${target.version} — ` +
          'the published feed moved while this download was in flight; nothing was handed over.',
      )
    }
    return { version: installed, releaseHadMigrations, swapped: bytes.byteLength > 0 }
  }
}

/** Parse a request's passthrough `target` field with the protocol's own schema. */
export function parseUpdateTarget(value: unknown): UpdateTarget {
  return UpdateTarget.parse(value)
}

/** The version currently on disk at `installDir`. Throws if VERSION is unreadable. */
export function installDirVersion(installDir: string): string {
  return defaultInstalledVersion(installDir)
}

export type { UpdateTarget }
