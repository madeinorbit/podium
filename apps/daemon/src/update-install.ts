import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Atomically replace an installed headless bundle with verified tarball bytes.
 *
 * Verification happens before this seam is called. Staging beside the install
 * directory keeps the renames on one filesystem, and the rollback rename keeps
 * the install present if the second rename fails.
 */
export function swapHeadlessBundle(bytes: Uint8Array, installDir: string): void {
  const stagingRoot = mkdtempSync(join(dirname(installDir), '.podium-grant-'))
  try {
    const tarball = join(stagingRoot, 'bundle.tar.gz')
    writeFileSync(tarball, bytes)
    const staged = join(stagingRoot, 'staged')
    mkdirSync(staged)
    execFileSync('tar', ['-xzf', tarball, '-C', staged], { stdio: 'ignore' })
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
