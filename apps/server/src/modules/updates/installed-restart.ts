/**
 * The installed server's half of the parent-supervised update (POD-2505).
 *
 * WHAT THIS FILE NO LONGER DOES: fetch, verify, or swap the bundle. Spec §8
 * disposition 11 moved all of that into the parent — "the parent performs
 * schema-gate-before-fetch, verified fetch, swap, and the post-swap VERSION
 * re-read (the rolling-feed fence) for every shape, daemonless included" —
 * because the process replacing the bundle should not be the process running out
 * of it. What is left here is the pair of ASKS the operation's `server` step
 * makes, and the honest answer to "can this shape restart itself at all?".
 *
 *  - `createInstalledCoordinatorUpdate` asks the parent to install `target` and
 *    WAITS for its answer, so a delivery failure still fails the step with the
 *    parent's own sentence instead of hanging.
 *  - `createInstalledCoordinatorRestart` asks the parent to self-handover onto
 *    the bundle now on disk.
 *
 * Both are undefined for a shape with no parent, which is what makes
 * `canRestartServer` true only when a restart can really happen (disposition 6).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@podium/logger'
import type { UpdateTarget } from '@podium/protocol'
import { resolveInstallDir } from '@podium/runtime/config'
import { requestParentHandover, requestParentSwap } from '@podium/runtime/parent-control'
import { liveRecord } from '@podium/runtime/run-registry'

/**
 * THE TWO ASKS THE SERVER MAKES OF ITS OWN PARENT, ON THE RECORD (POD-3224).
 *
 * These are the only points where the coordinator hands its own replacement to
 * another process, and until now they were completely silent on this side: the
 * server step showed "Updating your server…", the process died, and whether the
 * swap had even been requested was knowable only from the parent's journal — a
 * different log, on a machine whose server had just gone away. A failure went
 * out as an exception through the step, so the ask itself left no trace at all.
 */
const log = createLogger('server:updates')

export interface InstalledUpdateDeps {
  env?: NodeJS.ProcessEnv
  /** The pin the parent must verify dev-published bundles against. */
  pinnedPubkey?: string
  /** Injectable ask — production is {@link requestParentSwap}. */
  requestSwap?: (
    target: UpdateTarget,
    pinnedPubkey?: string,
  ) => Promise<{ releaseHadMigrations: boolean }>
  /** Injectable capability probe; production reads the run registry. */
  hasParent?: () => boolean
  /**
   * Called with the version the parent just installed. server.ts uses it to feed
   * the restart closure's `pendingVersion`, which is the version the handover
   * health gate will require the successor to serve.
   */
  onInstalled?: (version: string) => void
}

export interface InstalledRestartDeps {
  instanceId: string
  port: () => number
  env?: NodeJS.ProcessEnv
  /** Injectable ask — production is {@link requestParentHandover}. */
  requestHandover?: (
    expectedVersion: string,
  ) => { ok: true; pid: number } | { ok: false; reason: string }
  /** Injectable capability probe; production reads the run registry. */
  hasParent?: () => boolean
  /** The version the update step installed, for the handover's health gate. */
  pendingVersion?: () => string | undefined
}

/**
 * Is there a supervising parent to hand this work to?
 *
 * The live run-registry record is the contract. `PODIUM_UNDER_PARENT=1` only
 * says how this server was spawned; it cannot prove that the parent is still
 * discoverable, and treating it as proof advertises an update that the later
 * parent-control request must refuse.
 *
 * The legacy installed markers (`INVOCATION_ID`, `PODIUM_RUN_MODE=detached`) are
 * deliberately NOT enough any more: a section-4 migration host has
 * `INVOCATION_ID` set by its old server unit and no parent anywhere, and
 * treating that as "can restart" is what advertised a capability whose only
 * behaviour was to throw.
 */
export function parentAvailable(): boolean {
  try {
    return liveRecord('parent') !== undefined
  } catch {
    return false
  }
}

/**
 * Ensure the install directory carries the operation's exact target, by asking
 * the parent to do it. Resolves when the bundle on disk IS the target (the
 * parent ran the VERSION re-read fence); rejects with the parent's reason.
 */
export function createInstalledCoordinatorUpdate(
  deps: InstalledUpdateDeps = {},
): ((target: UpdateTarget) => Promise<void>) | undefined {
  const hasParent = deps.hasParent ?? parentAvailable
  if (!hasParent()) return undefined
  const requestSwap =
    deps.requestSwap ??
    ((target: UpdateTarget, pinnedPubkey?: string) =>
      requestParentSwap({
        expectedVersion: target.version,
        target: target as unknown as Record<string, unknown>,
        ...(pinnedPubkey ? { pinnedPubkey } : {}),
      }))

  return async (target) => {
    const startedAt = Date.now()
    log.info('asking the parent to swap this server onto a new bundle', {
      targetVersion: target.version,
      ...(target.artifacts?.web?.digest ? { targetWebDigest: target.artifacts.web.digest } : {}),
      pinned: deps.pinnedPubkey !== undefined,
    })
    try {
      await requestSwap(target, deps.pinnedPubkey)
    } catch (err) {
      // The parent's own sentence, recorded HERE as well: the step turns it into
      // a user-facing failure and the parent writes its own line, but only this
      // one ties the two together by target and elapsed time.
      log.error('the parent refused or failed the swap', {
        targetVersion: target.version,
        elapsedMs: Date.now() - startedAt,
        err,
      })
      throw err
    }
    log.info('the parent reports the bundle on disk is now the target', {
      targetVersion: target.version,
      elapsedMs: Date.now() - startedAt,
    })
    deps.onInstalled?.(target.version)
  }
}

/**
 * The version on disk. The fallback for the handover's expected version when the
 * update step did not run (the bundle was already the target). A READ, not a
 * write — the swap itself is the parent's, and this is the one thing the server
 * still needs to know about the install directory.
 */
function installedVersionOnDisk(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return readFileSync(join(resolveInstallDir(env), 'VERSION'), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Ask the supervising parent to self-handover onto the already-swapped bundle.
 *
 * Retires the systemd `systemctl restart` and detached `--takeover` fork paths.
 */
export function createInstalledCoordinatorRestart(
  deps: InstalledRestartDeps,
): (() => void) | undefined {
  const env = deps.env ?? process.env
  const hasParent = deps.hasParent ?? parentAvailable
  if (!hasParent()) return undefined

  const requestHandover =
    deps.requestHandover ??
    ((expectedVersion: string) => requestParentHandover({ expectedVersion }))

  let requested = false
  const pending = deps.pendingVersion

  return () => {
    if (requested) {
      log.debug('a parent handover has already been requested; not asking again', {})
      return
    }
    const expectedVersion = pending?.() ?? installedVersionOnDisk(env) ?? env.PODIUM_APP_VERSION
    if (!expectedVersion) {
      log.error('cannot ask for a handover without an expected version', {})
      throw new Error('parent handover requires an expected version')
    }
    const result = requestHandover(expectedVersion)
    if (!result.ok) {
      log.error('the parent refused the handover', { expectedVersion, reason: result.reason })
      throw new Error(
        `machine-cannot-restart: no supervising parent to hand over to (${result.reason})`,
      )
    }
    /**
     * THE LAST LINE THIS PROCESS WRITES ABOUT ITS OWN UPDATE.
     *
     * Everything after it belongs to the successor, so the successor's boot
     * record and this line are the two ends of the coordinator gap — which is
     * exactly the window in which every client's poll starts failing.
     */
    log.info('the parent accepted the handover; this server is being replaced', {
      expectedVersion,
      successorParentPid: result.pid,
    })
    // LATCHED ONLY ON SUCCESS. Latching before the ask meant a step that threw
    // once reported "Restarting the server…" forever, because every re-`ensure()`
    // returned silently without ever asking again.
    requested = true
  }
}
