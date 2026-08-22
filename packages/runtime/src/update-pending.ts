import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export interface PendingGrant {
  grantId: string
  targetVersion: string
  /** What to roll back TO. Read before the swap, not guessed after it. */
  previousVersion: string
  attempts: number
  startedAt: number
}

const FILE = 'pending-update.json'
/**
 * The staging name. A reader only ever opens {@link FILE}, so whatever is here
 * — including the debris of a write that never finished — is invisible to boot
 * reconciliation by construction.
 */
const TEMP_FILE = `${FILE}.tmp`

export function readPendingGrant(dir: string): PendingGrant | null {
  const path = join(dir, FILE)
  if (!existsSync(path)) return null
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return null
    const g = raw as Partial<PendingGrant>
    if (
      typeof g.grantId !== 'string' ||
      typeof g.targetVersion !== 'string' ||
      typeof g.previousVersion !== 'string' ||
      typeof g.attempts !== 'number' ||
      typeof g.startedAt !== 'number'
    ) {
      return null
    }
    return g as PendingGrant
  } catch {
    return null
  }
}

/**
 * TEST SEAM: how the marker's bytes reach the filesystem. Production is
 * {@link writeFileDurable}; a test substitutes a writer that dies partway
 * through, which is the only way to observe a torn write deterministically.
 */
export type WriteMarkerBytes = (path: string, data: string) => void

function writeFileDurable(path: string, data: string): void {
  const fd = openSync(path, 'w')
  try {
    writeFileSync(fd, data)
    // Flush before the rename, not after: the rename is what publishes the
    // marker, so the bytes have to be on the device before it happens or a
    // power loss can leave a name pointing at nothing.
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Best-effort: the rename's own durability. A failure here costs nothing this
 *  process can observe, and platforms differ on whether a directory is even
 *  openable for fsync — so it must never turn a successful write into a throw. */
function syncDirectory(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // ignored, see above
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * WRITE THE CRASH-RECOVERY MARKER ATOMICALLY (POD-2099).
 *
 * This is called in the last moments of the process's life: the grant runner
 * writes the marker and then deliberately exits so the new binary boots. The
 * old implementation was a bare `writeFileSync` to the real path, which has a
 * window where the file exists and is half a document. A truncated file parses
 * as `null`, {@link readPendingGrant} returns null, and boot reconciliation
 * (`host-runtime.ts`) then SKIPS SILENTLY — a failed update reported as nothing
 * happening at all, with the rollback target lost.
 *
 * Staging plus `rename` closes the window: `rename(2)` over an existing path is
 * atomic within a directory, so a reader sees either the previous marker or the
 * new one, never a prefix of either. The debris of an interrupted write is left
 * under {@link TEMP_FILE}, which nothing reads, and the next write overwrites.
 */
export function writePendingGrant(
  dir: string,
  g: PendingGrant,
  writeBytes: WriteMarkerBytes = writeFileDurable,
): void {
  const temp = join(dir, TEMP_FILE)
  writeBytes(temp, JSON.stringify(g))
  renameSync(temp, join(dir, FILE))
  syncDirectory(dir)
}

export function clearPendingGrant(dir: string): void {
  rmSync(join(dir, FILE), { force: true })
  // The staging path too: a marker the operator "cleared" must not be able to
  // come back as debris some later reader learns to look at.
  rmSync(join(dir, TEMP_FILE), { force: true })
}

/**
 * Consume a successfully converged marker, but only when it names the exact
 * version whose complete parent health gate just passed. A stale marker from a
 * different grant is recovery context for that grant and must remain intact.
 */
export function finalizePendingGrant(dir: string, targetVersion: string): boolean {
  const pending = readPendingGrant(dir)
  if (!pending || pending.targetVersion !== targetVersion) return false
  clearPendingGrant(dir)
  return true
}
