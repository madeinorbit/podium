import { createHash } from 'node:crypto'
import type { ByteSource } from './byte-source'

/** One segment of a session's transcript chain: its bytes and its cursor namespace. */
export interface ChainEntry {
  source: ByteSource
  fileId: string
}

/** Storage-independent cursor namespace. Archives are prior session generations. */
export function fileIdFor(sessionIdentity: string, archivedSequence?: number): string {
  const identity =
    archivedSequence === undefined ? sessionIdentity : `${sessionIdentity}\0${archivedSequence}`
  return createHash('sha1').update(identity).digest('hex').slice(0, 12)
}
