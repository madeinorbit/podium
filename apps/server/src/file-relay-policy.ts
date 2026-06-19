import type { TranscriptItem } from '@podium/protocol'

/** The set of absolute paths a session has structurally referenced — the
 *  read allow-list for files outside the repo cwd. */
export function knownPathsFor(items: TranscriptItem[]): Set<string> {
  const set = new Set<string>()
  for (const item of items) for (const p of item.toolPaths ?? []) set.add(p)
  return set
}
