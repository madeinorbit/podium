import { lstat, opendir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export interface ReclaimDiskEstimateJobInput {
  /** Every primary checkout and linked worktree for the measured repositories. */
  roots: string[]
  /** The subset the confirmed reclaim operation would remove. */
  reclaimRoots: string[]
}

interface InodeObservation {
  bytes: number
  links: number
  observedLinks: number
  reclaim: boolean
  retained: boolean
  directory: boolean
}

/**
 * Count allocated inode bytes that disappear only when the whole reclaim set is
 * removed. Hardlinked files are keyed by device+inode and contribute exactly
 * once, and only when every observed link is inside a reclaimed root. A link
 * count larger than the links under all known checkouts is treated
 * conservatively as an external retained link.
 *
 * This is the inode-attribution equivalent of du(all) - du(remaining), but it
 * needs one walk and can run in the daemon worker without shelling out or
 * blocking the control loop.
 */
export async function runReclaimDiskEstimateJob(
  input: ReclaimDiskEstimateJobInput,
): Promise<{ recoverableBytes: number; measuredAt: string }> {
  const roots = [...new Set(input.roots.map((root) => resolve(root)))]
  const rootSet = new Set(roots)
  const reclaim = new Set(input.reclaimRoots.map((root) => resolve(root)))
  const observations = new Map<string, InodeObservation>()

  const visit = async (path: string, reclaiming: boolean, root: string): Promise<void> => {
    const stat = await lstat(path, { bigint: true })
    const key = `${stat.dev}:${stat.ino}`
    const bytes = Number(stat.blocks * 512n)
    const links = Number(stat.nlink)
    const previous = observations.get(key)
    if (previous) {
      previous.observedLinks += 1
      previous.reclaim ||= reclaiming
      previous.retained ||= !reclaiming
    } else {
      observations.set(key, {
        bytes,
        links,
        observedLinks: 1,
        reclaim: reclaiming,
        retained: !reclaiming,
        directory: stat.isDirectory(),
      })
    }
    if (!stat.isDirectory()) return
    const dir = await opendir(path)
    for await (const entry of dir) {
      const child = join(path, entry.name)
      // A linked worktree can live below the primary checkout. Each registered
      // root owns its own classification, so the retained parent walk must not
      // traverse into a reclaim root (and vice versa).
      if (child !== root && rootSet.has(child)) continue
      await visit(child, reclaiming, root)
    }
  }

  for (const root of roots) await visit(root, reclaim.has(root), root)

  let recoverableBytes = 0
  for (const inode of observations.values()) {
    if (!inode.reclaim || inode.retained) continue
    // Directory nlink includes dot and child parent entries, all removed with
    // the subtree; regular-file nlink can expose an unobserved link elsewhere.
    if (!inode.directory && inode.observedLinks < inode.links) continue
    recoverableBytes += inode.bytes
  }
  return { recoverableBytes, measuredAt: new Date().toISOString() }
}
