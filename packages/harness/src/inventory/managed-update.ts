/**
 * MANAGED INSTALLS: ONE UPDATE CHECK, AND GOING BACK (POD-7281).
 *
 * docs/design/harness-managed-installs.md §5.5 and §5.6. A check is one call
 * to the adapter's `latest()`. It leads to an install, through the mechanism
 * (`installRelease`), only when the version it returns
 *
 *   - is newer than the current release,
 *   - is at or above the harness's minimum,
 *   - is not on the rejected list,
 *   - and updates are not paused for that harness.
 *
 * Otherwise nothing changes but the check's record. Updates do not wait for
 * the machine to be idle: an install fills a new folder and moves a record,
 * and no running process reads either. Housekeeping runs with every check.
 *
 * Going back is a person's act: the previous release becomes current and the
 * version that was current goes on the rejected list, so the next check does
 * not bring it straight back. A release newer than the rejected one installs
 * as usual. Nothing here goes back on its own: there is no automatic rollback.
 *
 * WHAT MOVES `current`. Only `InstallLedger.publishRelease` (the last step of
 * an install) and `InstallLedger.revertToPrevious` (a person's go back) write
 * it; the ledger's rebuild after a lost database reconstructs it from the
 * folders. Nothing in this module writes it any other way.
 *
 * The schedule (start, every six hours, Check now) is the daemon's
 * (`apps/daemon/src/installs/updater.ts`); this module is one check, callable
 * from the daemon and from the CLI alike. Two programs checking at once meet
 * at the install lock.
 */

import type { BuiltinHarnessKind } from '@podium/model'
import { createCommandEnvironment } from '@podium/runtime/command-environment'
import {
  gateHarnessVersion,
  type HarnessVersionPolicy,
  parseHarnessVersion,
} from '../version-policy.js'
import {
  InstallLedger,
  type InstallLockHolder,
  type ManagedInstall,
  NothingToGoBackToError,
} from './install-ledger.js'
import { releaseFolderName } from './install-receipt.js'
import {
  type InstallReleaseOptions,
  type InstallReleaseResult,
  installRelease,
  type ManagedInstallHostOptions,
  type ManagedInstallTarget,
  managedCheckPorts,
  managedInstallEnv,
  managedInstallTargetFor,
  sweepReleaseFolders,
} from './managed-install.js'

// ---------------------------------------------------------------------------
// The decision

/** Why a check installs nothing. */
export type NoUpdateReason =
  /** A person paused updates for this harness. */
  | 'paused'
  /** The version is on the rejected list. */
  | 'rejected'
  /** The version is the current one, or older. */
  | 'not-newer'
  /** The version is below the minimum Podium supports. */
  | 'below-minimum'
  /** The vendor named a version Podium cannot compare. */
  | 'unparseable'

export type UpdateDecision = { install: true } | { install: false; reason: NoUpdateReason }

export interface UpdateDecisionInput {
  /** What the vendor's stable channel names now. */
  latest: string
  /** The current release's version; absent when there is no working current release. */
  current?: string
  versionPolicy?: HarnessVersionPolicy
  rejected: boolean
  paused: boolean
}

/**
 * Compare two vendor versions by major, minor and patch. `undefined` when
 * either does not parse; a suffix after the patch does not count.
 */
export function compareHarnessVersions(left: string, right: string): number | undefined {
  const a = parseHarnessVersion(left)
  const b = parseHarnessVersion(right)
  if (!a || !b) return undefined
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/**
 * Whether a check that found `latest` installs it (§5.5). The four conditions
 * are independent; the reason names the first that fails, paused first, since
 * a paused harness installs nothing whatever the vendor published.
 */
export function decideUpdate(input: UpdateDecisionInput): UpdateDecision {
  if (input.paused) return { install: false, reason: 'paused' }
  if (input.rejected) return { install: false, reason: 'rejected' }
  if (!parseHarnessVersion(input.latest)) return { install: false, reason: 'unparseable' }
  if (input.current !== undefined) {
    const order = compareHarnessVersions(input.latest, input.current)
    // A current version that does not parse cannot be compared: install nothing.
    if (order === undefined) return { install: false, reason: 'unparseable' }
    if (order <= 0) return { install: false, reason: 'not-newer' }
  }
  if (input.versionPolicy && gateHarnessVersion(input.versionPolicy, input.latest) === 'too-old')
    return { install: false, reason: 'below-minimum' }
  return { install: true }
}

// ---------------------------------------------------------------------------
// One check

export interface CheckForUpdateOptions extends ManagedInstallHostOptions {
  /** `<state>/harnesses`. Default: the instance's own. */
  harnessesDir?: string
  /** An open ledger to use. Default: open one at `harnessesDir` and close it after. */
  ledger?: InstallLedger
  /**
   * The release folder whose probe failed, as the inventory reports it
   * (`install.managed.currentFailed.release`): the inventory runs the previous
   * release, or none. While that folder is still current, the check installs
   * the latest version again as a new folder, even when it is the current
   * version (§5.6). Ignored once another release is current.
   */
  currentFailed?: number
  /** Ask the inventory to look again after an install. */
  reprobe?: () => unknown
  probeTimeoutMs?: number
  /** The install lock's holder label. Default `update <kind>`. */
  lockLabel?: string
  /** @internal The target to check instead of the registry's; tests use a fake adapter. */
  target?: ManagedInstallTarget
  /** @internal Passed through to `installRelease`. */
  beforeStep?: InstallReleaseOptions['beforeStep']
}

export type CheckForUpdateResult =
  /** Podium does not manage this harness here (no ledger row), or its adapter declares no install. */
  | { outcome: 'not-managed'; kind: BuiltinHarnessKind }
  /** The vendor could not be asked. Recorded; the next check tries again. */
  | { outcome: 'check-failed'; kind: BuiltinHarnessKind; error: string; swept: string[] }
  /** The vendor answered and there is nothing to install. */
  | {
      outcome: 'no-update'
      kind: BuiltinHarnessKind
      latest: string
      reason: NoUpdateReason
      swept: string[]
    }
  /** The check led to an install: its outcome. */
  | (InstallReleaseResult & { latest: string })

/**
 * One update check for `kind` (§5.5): ask the vendor, decide, and install
 * through the mechanism when the decision says so. Never throws for a vendor,
 * release or disk failure; the outcome says what happened and the ledger
 * records it.
 */
export async function checkForUpdate(
  kind: BuiltinHarnessKind,
  options: CheckForUpdateOptions = {},
): Promise<CheckForUpdateResult> {
  const target = options.target ?? managedInstallTargetFor(kind)
  if (!target || target.kind !== kind) return { outcome: 'not-managed', kind }
  const ledger =
    options.ledger ??
    InstallLedger.open(options.harnessesDir ? { harnessesDir: options.harnessesDir } : {})
  try {
    if (!ledger.get(kind)) return { outcome: 'not-managed', kind }
    const commandEnv = options.commandEnv ?? (await createCommandEnvironment()).env
    const env = Object.freeze(managedInstallEnv(commandEnv))
    const check = managedCheckPorts(env, options)

    let latest: string
    try {
      latest = (await target.install.latest(check)).version
      // The same check the mechanism makes: a version that cannot name a folder is no answer.
      releaseFolderName(1, latest)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ledger.recordCheck(kind, { ok: false, error: message })
      return {
        outcome: 'check-failed',
        kind,
        error: message,
        swept: housekeep(ledger, kind, options),
      }
    }

    // Read the row after the vendor answered: a pause or a go back may have landed meanwhile.
    const row = ledger.get(kind)
    if (!row) return { outcome: 'not-managed', kind }
    const decision = decideUpdate({
      latest,
      ...(options.currentFailed !== undefined && options.currentFailed === row.current
        ? {}
        : currentVersion(ledger, row)),
      ...(target.versionPolicy ? { versionPolicy: target.versionPolicy } : {}),
      rejected: ledger.isRejected(kind, latest),
      paused: row.paused,
    })
    if (!decision.install) {
      ledger.recordCheck(kind, { ok: true, latest, nothingToInstall: true })
      return {
        outcome: 'no-update',
        kind,
        latest,
        reason: decision.reason,
        swept: housekeep(ledger, kind, options),
      }
    }
    ledger.recordCheck(kind, { ok: true, latest, nothingToInstall: false })
    const installed = await installRelease(kind, {
      ...options,
      ledger,
      commandEnv,
      target,
      release: { version: latest },
      lockLabel: options.lockLabel ?? `update ${kind}`,
    })
    return { ...installed, latest }
  } finally {
    if (!options.ledger) ledger.close()
  }
}

/** The current release's version, when its folder is a release on disk. */
function currentVersion(ledger: InstallLedger, row: ManagedInstall): { current?: string } {
  if (row.current == null) return {}
  const folder = ledger.releaseFolder(row.kind, row.current)
  return folder?.receipt ? { current: folder.receipt.version } : {}
}

/**
 * Housekeeping with a check that installed nothing (an install sweeps itself).
 * Skipped when another program holds the install lock: its install owns its
 * staging folder, and the next check sweeps.
 */
function housekeep(
  ledger: InstallLedger,
  kind: BuiltinHarnessKind,
  options: { lockLabel?: string; note?: (message: string) => void },
): string[] {
  try {
    const acquired = ledger.acquireInstallLock({ label: options.lockLabel ?? `update ${kind}` })
    if (!acquired.acquired) return []
    try {
      return sweepReleaseFolders(ledger, kind, acquired.lock)
    } finally {
      acquired.lock.release()
    }
  } catch (error) {
    options.note?.(
      `Could not clear old ${kind} install folders: ${error instanceof Error ? error.message : String(error)}`,
    )
    return []
  }
}

// ---------------------------------------------------------------------------
// Pause and resume (§5.6)

export interface SetUpdatesPausedOptions {
  harnessesDir?: string
  ledger?: InstallLedger
}

export type SetUpdatesPausedResult =
  | { outcome: 'set'; kind: BuiltinHarnessKind; paused: boolean }
  | { outcome: 'not-managed'; kind: BuiltinHarnessKind }

/**
 * A person pauses or resumes updates for `kind`. Kept in the ledger, so it
 * holds across daemon restarts and for the CLI alike. A paused harness stays
 * on its release: a check still asks the vendor and records what it saw, and
 * installs nothing. Resuming installs nothing by itself; the next check does.
 */
export function setUpdatesPaused(
  kind: BuiltinHarnessKind,
  paused: boolean,
  options: SetUpdatesPausedOptions = {},
): SetUpdatesPausedResult {
  const ledger =
    options.ledger ??
    InstallLedger.open(options.harnessesDir ? { harnessesDir: options.harnessesDir } : {})
  try {
    if (!ledger.get(kind)) return { outcome: 'not-managed', kind }
    ledger.setPaused(kind, paused)
    return { outcome: 'set', kind, paused }
  } finally {
    if (!options.ledger) ledger.close()
  }
}

// ---------------------------------------------------------------------------
// Going back (§5.6)

export interface GoBackOptions {
  harnessesDir?: string
  ledger?: InstallLedger
  /** Ask the inventory to look again after the record moved. */
  reprobe?: () => unknown
  lockLabel?: string
  note?: (message: string) => void
}

export type GoBackResult =
  | {
      outcome: 'went-back'
      kind: BuiltinHarnessKind
      /** The release folder now current. */
      current: number
      version: string
      /** The version put on the rejected list, when there was a current one. */
      rejected?: string
      swept: string[]
    }
  | { outcome: 'not-managed'; kind: BuiltinHarnessKind }
  | { outcome: 'nothing-to-go-back-to'; kind: BuiltinHarnessKind; reason: string }
  | { outcome: 'busy'; kind: BuiltinHarnessKind; holder: InstallLockHolder }

/**
 * A person goes back to the previous release of `kind`. Under the install
 * lock, so it never crosses an install in progress. Returns `busy` when an
 * install holds the lock; the person asks again once it finished.
 */
export async function goBackRelease(
  kind: BuiltinHarnessKind,
  options: GoBackOptions = {},
): Promise<GoBackResult> {
  const ledger =
    options.ledger ??
    InstallLedger.open(options.harnessesDir ? { harnessesDir: options.harnessesDir } : {})
  try {
    if (!ledger.get(kind)) return { outcome: 'not-managed', kind }
    const acquired = ledger.acquireInstallLock({ label: options.lockLabel ?? `go back ${kind}` })
    if (!acquired.acquired) return { outcome: 'busy', kind, holder: acquired.holder }
    let moved: ReturnType<InstallLedger['revertToPrevious']>
    let swept: string[] = []
    try {
      try {
        moved = ledger.revertToPrevious(kind, acquired.lock, 'a person went back from this release')
      } catch (error) {
        if (error instanceof NothingToGoBackToError)
          return { outcome: 'nothing-to-go-back-to', kind, reason: error.reason }
        throw error
      }
      try {
        swept = sweepReleaseFolders(ledger, kind, acquired.lock)
      } catch (error) {
        options.note?.(
          `Could not clear old ${kind} install folders: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    } finally {
      acquired.lock.release()
    }
    const current = moved.row.current as number
    const version = ledger.releaseFolder(kind, current)?.receipt?.version ?? ''
    try {
      await options.reprobe?.()
    } catch (error) {
      options.note?.(
        `Went back to ${kind} ${version}; the inventory refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return {
      outcome: 'went-back',
      kind,
      current,
      version,
      ...(moved.rejected !== undefined ? { rejected: moved.rejected } : {}),
      swept,
    }
  } finally {
    if (!options.ledger) ledger.close()
  }
}
