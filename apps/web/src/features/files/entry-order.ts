/** One collator for every directory listing. `localeCompare(…, options)` builds a
 * fresh collator on every call, which a few thousand entries pays for on every
 * comparison; a hoisted Intl.Collator is the same ordering at a fraction of the
 * cost. */
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Directories first, then names in natural order, so `img2` sorts before `img10`.
 * Shared by the worktree tree and the file browser so the two never disagree. */
export function compareEntries(
  a: { name: string; isDir: boolean },
  b: { name: string; isDir: boolean },
): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return NAME_COLLATOR.compare(a.name, b.name)
}
