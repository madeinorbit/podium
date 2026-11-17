/**
 * ARTIFACT NAMES BECOME BLOB KEYS ON A SELF-HOSTED DISK (POD-6963 design 2.2, POD-7054).
 *
 * Artifacts are stored at `artifacts/<issue>/<artifact>/<relpath>` in the workspace's blob
 * store. A key segment is `[A-Za-z0-9._-]`; any other name is encoded as `~` + base32
 * (`keySegment`, design 2.1). On a self-hosted disk the key IS the path under the state
 * directory, so a member stored before the blob store by a name with other characters
 * (`Screen Shot 1.png`, `résumé.pdf`) sits at a path no key names. This one-time boot step
 * renames each such path segment, files and directories alike, to its encoded form, so those
 * artifacts are found again. Plain names are untouched.
 *
 * - Deepest first: a directory's entries are converted before the directory itself, so a crash
 *   between two renames leaves only names the next boot converts the same way (each rename is
 *   atomic; there is no other state).
 * - A target that already exists with the same bytes means the move happened: the source goes.
 *   Any other existing target is a conflict, logged, and both are left.
 * - A name that cannot be encoded (not plain and over 158 UTF-8 bytes) is logged once with its
 *   path and left in place; reads of it answer not found. It never fails the boot.
 * - The upload staging (`artifacts/.uploads`) is not renamed. Staging the code before the blob
 *   store wrote (`<issue>/<upload>/meta.json` and `files/`) is removed: it holds uploads that
 *   were never published before the upgrade, which the CLI sends again, and no row names them.
 *   Staging in today's chunk layout is left alone. The local adapter's temp files are skipped.
 * - A done marker in the state directory (outside the transferred roots) makes later boots skip
 *   the walk. After a server transfer the target walks once more and finds nothing to do.
 */

import { lstat, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isKeySegment, keySegment, type PortableStateWriteFence } from '@podium/blob-store'

/** The marker a finished conversion writes; its presence skips the walk. */
export const ARTIFACT_KEY_CONVERSION_MARKER = 'artifact-key-conversion.done'

/** The local adapter's temp files (`.tmp-<uuid>`), which its own boot step removes. */
const TEMP_FILE = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface ArtifactKeyConversionLog {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

export interface ArtifactKeyConversionResult {
  /** False when the marker said the conversion had already run. */
  ran: boolean
  renamed: number
  /** Upload staging directories in the pre-blob-store layout that were removed. */
  legacyUploadsRemoved: number
  /** Paths left in place because their name cannot be encoded. */
  unencodable: string[]
  /** Paths left in place because a different entry already holds the encoded name. */
  conflicts: string[]
}

async function sameFileBytes(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([lstat(a), lstat(b)])
  if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false
  const [ba, bb] = await Promise.all([readFile(a), readFile(b)])
  return ba.equals(bb)
}

/** The entry names of a directory; none when it is missing or not a directory. */
async function namesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Convert `<stateDir>/artifacts` once. Run at boot, after the store migrations and before
 * anything serves artifacts, only when the server's files are on the state directory.
 */
export async function convertArtifactKeys(options: {
  stateDir: string
  log: ArtifactKeyConversionLog
  fence?: PortableStateWriteFence
}): Promise<ArtifactKeyConversionResult> {
  const marker = join(options.stateDir, ARTIFACT_KEY_CONVERSION_MARKER)
  const result: ArtifactKeyConversionResult = {
    ran: false,
    renamed: 0,
    legacyUploadsRemoved: 0,
    unencodable: [],
    conflicts: [],
  }
  if (await exists(marker)) return result
  result.ran = true
  const root = join(options.stateDir, 'artifacts')

  const convert = async (dir: string, top: boolean): Promise<void> => {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return
      throw error
    }
    for (const name of names) {
      if (top && name === '.uploads') continue
      if (TEMP_FILE.test(name)) continue
      const path = join(dir, name)
      const stats = await lstat(path)
      if (stats.isSymbolicLink()) continue
      if (stats.isDirectory()) await convert(path, false)
      if (isKeySegment(name)) continue
      let encoded: string
      try {
        encoded = keySegment(name)
      } catch {
        result.unencodable.push(path)
        options.log.warn('an artifact file name is too long to store; it is left unreadable', {
          path,
        })
        continue
      }
      const target = join(dir, encoded)
      if (await exists(target)) {
        if (stats.isFile() && (await sameFileBytes(path, target))) {
          await rm(path, { force: true })
          result.renamed += 1
        } else {
          result.conflicts.push(path)
          options.log.warn('an artifact file name and its stored form both exist; both are kept', {
            path,
            target,
          })
        }
        continue
      }
      await rename(path, target)
      result.renamed += 1
    }
  }

  /** Remove `<root>/.uploads/<issue>/<upload>` directories that hold the old layout. */
  const removeLegacyUploads = async (): Promise<void> => {
    const uploads = join(root, '.uploads')
    for (const issue of await namesIn(uploads)) {
      const issueDir = join(uploads, issue)
      for (const upload of await namesIn(issueDir)) {
        const dir = join(issueDir, upload)
        const entries = await namesIn(dir)
        if (!entries.includes('meta.json') && !entries.includes('files')) continue
        await rm(dir, { recursive: true, force: true })
        result.legacyUploadsRemoved += 1
      }
      await rmdir(issueDir).catch(() => {})
    }
    await rmdir(uploads).catch(() => {})
  }

  const run = async () => {
    await removeLegacyUploads()
    await convert(root, true)
    await writeFile(
      marker,
      `${JSON.stringify({ version: 1, convertedAt: new Date().toISOString() })}\n`,
    )
  }
  if (options.fence) await options.fence.runWriter(run)
  else await run()
  if (
    result.renamed > 0 ||
    result.legacyUploadsRemoved > 0 ||
    result.unencodable.length > 0 ||
    result.conflicts.length > 0
  ) {
    options.log.info('converted artifact file names to blob keys', {
      renamed: result.renamed,
      legacyUploadsRemoved: result.legacyUploadsRemoved,
      unencodable: result.unencodable.length,
      conflicts: result.conflicts.length,
    })
  }
  return result
}
