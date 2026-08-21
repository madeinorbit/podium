import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

/** Hard deadlock bound for extracting a downloaded headless bundle. */
export const BUNDLE_EXTRACT_TIMEOUT_MS = 2 * 60_000

export function oldBundlePath(installDir: string): string {
  return `${installDir}.old`
}

export function oldBundlePresent(installDir: string): boolean {
  return existsSync(oldBundlePath(installDir))
}

/**
 * Drop the retained `.old` sibling once the new parent has declared healthy
 * (spec §8 disposition 4). No-op when absent.
 */
export function pruneOldBundle(installDir: string): void {
  rmSync(oldBundlePath(installDir), { recursive: true, force: true })
}

/**
 * Restore the retained `.old` bundle over the current install (parent rollback).
 * Throws when `.old` is missing so callers can report WHY via rollbackDecision.
 */
export function restoreOldBundle(installDir: string): void {
  const backup = oldBundlePath(installDir)
  if (!existsSync(backup)) {
    throw new Error(`rollback failed: no .old bundle at ${backup}`)
  }
  const failed = `${installDir}.failed`
  rmSync(failed, { recursive: true, force: true })
  if (existsSync(installDir)) renameSync(installDir, failed)
  try {
    renameSync(backup, installDir)
  } catch (error) {
    if (existsSync(failed)) renameSync(failed, installDir)
    throw error
  }
  rmSync(failed, { recursive: true, force: true })
}

export interface SwapHeadlessBundleOptions {
  /**
   * When true (default), leave `<installDir>.old` in place for parent rollback.
   * Pass false only for callers that still own their own prune timing (none
   * remain after parent cutover; kept as an explicit opt-out for tests).
   */
  retainOld?: boolean
}

/**
 * Atomically replace an installed headless bundle with already-verified bytes.
 *
 * Shared by daemon grants and a server-only coordinator: both own the same
 * install shape and must have exactly the same staging, rollback, and timeout
 * behavior. The previous install is retained as `<dir>.old` until
 * {@link pruneOldBundle} runs after the new parent declares healthy.
 */
export async function swapHeadlessBundle(
  bytes: Uint8Array,
  installDir: string,
  options: SwapHeadlessBundleOptions = {},
): Promise<void> {
  const retainOld = options.retainOld !== false
  const stagingRoot = mkdtempSync(join(dirname(installDir), '.podium-grant-'))
  try {
    const tarball = join(stagingRoot, 'bundle.tar.gz')
    writeFileSync(tarball, bytes)
    const staged = join(stagingRoot, 'staged')
    mkdirSync(staged)
    await promisify(execFile)('tar', ['-xzf', tarball, '-C', staged], {
      timeout: BUNDLE_EXTRACT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: { ...process.env },
    })
    const replacement = join(staged, 'headless')
    if (!existsSync(replacement)) throw new Error('tarball did not contain a headless/ dir')

    const backup = oldBundlePath(installDir)
    rmSync(backup, { recursive: true, force: true })
    renameSync(installDir, backup)
    try {
      renameSync(replacement, installDir)
    } catch (error) {
      renameSync(backup, installDir)
      throw error
    }
    if (!retainOld) rmSync(backup, { recursive: true, force: true })
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}
