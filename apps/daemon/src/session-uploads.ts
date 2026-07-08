import { rmSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { uploadsToGc } from './uploads-gc'

export const UPLOADS_TTL_MS = 24 * 3600_000 // 24 hours
export const UPLOADS_GC_INTERVAL_MS = 3600_000 // 1 hour

/** Collect all files under ~/.podium/uploads and delete those older than the TTL.
 *  Async fs throughout: the sweep walks every upload across all sessions on an
 *  hourly timer, and a sync readdir/stat storm on the daemon loop would stall every
 *  session's I/O for the duration (audit P2-17). */
export async function sweepUploads(): Promise<void> {
  const uploadsDir = join(homedir(), '.podium', 'uploads')
  try {
    const sessionDirs = await readdir(uploadsDir)
    const files: { path: string; mtimeMs: number }[] = []
    for (const sessionDir of sessionDirs) {
      const sessionPath = join(uploadsDir, sessionDir)
      try {
        const entries = await readdir(sessionPath)
        for (const entry of entries) {
          const filePath = join(sessionPath, entry)
          try {
            const st = await stat(filePath)
            if (st.isFile()) files.push({ path: filePath, mtimeMs: st.mtimeMs })
          } catch {
            // file may have already been removed
          }
        }
      } catch {
        // session dir may have disappeared
      }
    }
    const toDelete = uploadsToGc(files, Date.now(), UPLOADS_TTL_MS)
    for (const p of toDelete) {
      try {
        await rm(p)
      } catch {
        // best effort
      }
    }
  } catch {
    // uploads dir may not exist yet
  }
}

/** Remove a session's upload directory when the session is closed/killed. */
export function removeSessionUploads(sessionId: string): void {
  const sessionUploadsDir = join(homedir(), '.podium', 'uploads', sessionId)
  try {
    rmSync(sessionUploadsDir, { recursive: true, force: true })
  } catch {
    // best effort
  }
}
