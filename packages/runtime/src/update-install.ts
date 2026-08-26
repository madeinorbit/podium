import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

/** Hard deadlock bound for extracting a downloaded headless bundle. */
export const BUNDLE_EXTRACT_TIMEOUT_MS = 2 * 60_000

/**
 * Atomically replace an installed headless bundle with already-verified bytes.
 *
 * Shared by daemon grants and a server-only coordinator: both own the same
 * install shape and must have exactly the same staging, rollback, and timeout
 * behavior.
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
