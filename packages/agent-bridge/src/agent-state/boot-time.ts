import { stat } from 'node:fs/promises'

/**
 * A file's mtime as an ISO string — the event-time used to stamp boot-classification
 * events. A transcript/rollout file's last write is the session's last activity, so
 * seeding an idle session's state on reattach restores its real recency instead of
 * "now". Returns undefined when the file is missing/unreadable (→ recency falls back
 * to wall-clock `now` downstream, the pre-existing behavior).
 */
export async function fileMtimeIso(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).mtime.toISOString()
  } catch {
    return undefined
  }
}
