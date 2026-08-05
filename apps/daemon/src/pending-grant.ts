import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

export function writePendingGrant(dir: string, g: PendingGrant): void {
  writeFileSync(join(dir, FILE), JSON.stringify(g))
}


export function clearPendingGrant(dir: string): void {
  rmSync(join(dir, FILE), { force: true })
}
