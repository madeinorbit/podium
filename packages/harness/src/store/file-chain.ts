import { createHash } from 'node:crypto'

export interface ChainEntry {
  path: string
  fileId: string
}

/** Storage-independent cursor namespace. Archives are prior session generations. */
export function fileIdFor(sessionIdentity: string, archivedSequence?: number): string {
  const identity =
    archivedSequence === undefined ? sessionIdentity : `${sessionIdentity}\0${archivedSequence}`
  return createHash('sha1').update(identity).digest('hex').slice(0, 12)
}
