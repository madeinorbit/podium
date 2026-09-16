export interface ChainEntry {
  path: string
  fileId: string
}

/** Storage-independent cursor namespace. Archives are prior session generations. */
export function fileIdFor(sessionIdentity: string, archivedSequence?: number): string {
  return archivedSequence === undefined
    ? sessionIdentity
    : JSON.stringify([sessionIdentity, archivedSequence])
}
