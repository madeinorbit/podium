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
import { createLogger } from '@podium/logger'
import { planConvergence, UpdateTarget } from '@podium/protocol'
import { readAppliedMigrations } from './migration-ledger'
import { type DeliveryDeps, fetchArtifact, PODIUM_UPDATE_PUBKEY } from './update-delivery'
import { swapHeadlessBundle } from './update-install'
import { createSchemaGate, releaseCarriesNewMigrations } from './update-schema'

export { releaseCarriesNewMigrations } from './update-schema'

/**
 * THE FOUR STEPS, EACH WITH ITS OWN OUTCOME (POD-3224, question 14).
 *
 * The parent process logged one line for the whole swap — "completed" or
 * "failed" — and the ORDER of the four steps below is the entire safety
 * argument. So "the update failed on the coordinator" could mean the schema gate
 * refused before a byte moved, a 300 MB download died, a swap left a bundle
 * half-written, or the published feed moved under a long download and the
 * VERSION fence caught it. Those are four different problems with four different
 * fixes, and the operator was shown one sentence for all of them.
 *
 * `runtime:parent` — the same namespace the parent process uses, because from
 * outside they are one actor.
 */
const log = createLogger('runtime:parent')

export interface ParentUpdateSwapDeps {
  installDir: string
  env?: NodeJS.ProcessEnv
  platform?: string
  pubkey?: string
  pinnedPubkey?: string
  /** Diagnostic-only publisher key; never a replacement trust root. */
  publisherPubkey?: string
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
   * Undefined means the declaration or ledger could not prove either answer.
   */
  releaseHadMigrations: boolean | undefined
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
        caps: ['update.delivery.feed'],
        platform,
      })
      if (plan.action === 'already-current') return new Uint8Array()
      if (plan.action === 'cannot') {
        throw new Error(`this machine cannot take ${target.version}: ${plan.reason}`)
      }
      const deliveryDeps: DeliveryDeps = {
        fetch: deps.fetch ?? fetch,
        pubkey: deps.pubkey ?? PODIUM_UPDATE_PUBKEY,
        ...(deps.pinnedPubkey ? { pinnedPubkey: deps.pinnedPubkey } : {}),
        ...(deps.publisherPubkey ? { publisherPubkey: deps.publisherPubkey } : {}),
        ...(target.trust ? { trust: target.trust } : {}),
      }
      const artifact = await fetchArtifact(plan.asset, deliveryDeps)
      return artifact.bytes
    })

  return async (target: UpdateTarget): Promise<ParentUpdateSwapResult> => {
    const startedAt = Date.now()
    const current = installedVersion(installDir)
    let ledgerReadable = true
    const applied = (() => {
      try {
        return readApplied()
      } catch {
        ledgerReadable = false
        return undefined
      }
    })()
    const releaseHadMigrations = ledgerReadable
      ? releaseCarriesNewMigrations(target, applied)
      : undefined
    if (current === target.version) {
      log.info('parent swap: the bundle on disk is already the target', {
        version: current,
        releaseHadMigrations,
      })
      return { version: current, releaseHadMigrations, swapped: false }
    }
    log.info('parent swap: beginning', {
      from: current,
      to: target.version,
      releaseHadMigrations,
      ledgerReadable,
    })
    // 1. Schema gate BEFORE the fetch — see the docblock.
    const refusal = createSchemaGate({ readApplied, currentVersion: current })(target)
    if (refusal) {
      // NOTHING WAS DOWNLOADED AND NOTHING WAS WRITTEN. That is the whole point
      // of the gate being first, and it is the fact the operator most needs:
      // this machine is exactly as it was.
      log.error('parent swap: refused by the schema gate before any fetch', {
        from: current,
        to: target.version,
        detail: refusal,
      })
      throw new Error(refusal)
    }
    // 2. Verified fetch.
    const fetchedAt = Date.now()
    const bytes = await deliver(target, current)
    log.info('parent swap: artifact fetched and verified', {
      to: target.version,
      bytes: bytes.byteLength,
      fetchMs: Date.now() - fetchedAt,
    })
    // 3. Atomic swap; retains `.old` for rollback.
    const swapAt = Date.now()
    if (bytes.byteLength > 0) await swap(bytes, installDir)
    // 4. VERSION re-read fence.
    const installed = installedVersion(installDir)
    if (installed !== target.version) {
      // THE ROLLING-FEED FENCE FIRING. Distinct from a download that failed:
      // the bytes arrived, verified and were placed, and they were the wrong
      // release. Nothing is handed over, and the disk is NOT what it was.
      log.error('parent swap: the installed version is not the target', {
        installed: installed || 'unreadable',
        expected: target.version,
        swapMs: Date.now() - swapAt,
      })
      throw new Error(
        `installed ${installed || 'an unknown version'}, expected ${target.version} — ` +
          'the published feed moved while this download was in flight; nothing was handed over.',
      )
    }
    log.info('parent swap: complete', {
      from: current,
      to: installed,
      swapped: bytes.byteLength > 0,
      releaseHadMigrations,
      swapMs: Date.now() - swapAt,
      totalMs: Date.now() - startedAt,
    })
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
