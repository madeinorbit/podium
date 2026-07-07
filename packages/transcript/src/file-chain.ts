import { createHash } from 'node:crypto'

export interface ChainEntry {
  path: string
  fileId: string
}

/** Stable short id for a transcript file path — the cursor namespace for the file. */
export function fileIdFor(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 12)
}
