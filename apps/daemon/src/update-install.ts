import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

/**
 * How long the extract may take before it is killed.
 *
 * The extract had NO bound at all until POD-2046: a `tar` that never returned
 * wedged the daemon permanently, with no alarm and nothing to read but a
 * machine that had stopped talking. The value only has to be far above a real
 * extract of a bundle this size; it is a deadlock breaker, not a performance
 * budget.
 */
export const BUNDLE_EXTRACT_TIMEOUT_MS = 2 * 60_000

/**
 * Atomically replace an installed headless bundle with verified tarball bytes.
 *
 * Verification happens before this seam is called. Staging beside the install
 * directory keeps the renames on one filesystem, and the rollback rename keeps
 * the install present if the second rename fails.
 *
 * The EXTRACT is awaited rather than blocking (POD-2046) — it runs on the
 * daemon's only thread, which also carries PTY output and the server link. The
 * renames stay synchronous deliberately: they are the atomic swap this function
 * exists to perform, and interleaving other work between them is exactly what
 * must not happen.
 */
export async function swapHeadlessBundle(bytes: Uint8Array, installDir: string): Promise<void> {
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

    const backup = `${installDir}.old`
    rmSync(backup, { recursive: true, force: true })
    renameSync(installDir, backup)
    try {
      renameSync(replacement, installDir)
    } catch (error) {
      renameSync(backup, installDir)
      throw error
    }
    rmSync(backup, { recursive: true, force: true })
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}
