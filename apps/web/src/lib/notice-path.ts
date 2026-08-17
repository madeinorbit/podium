/**
 * A toast description is a sentence everywhere except one place: the worktree
 * move notice (`engine/reactions.ts`) passes a raw absolute path. That one
 * description must not be set as prose — it wants monospace, one line, and
 * elision from the HEAD, because the tail is what identifies it.
 *
 * The decision lives HERE, in the web presentation layer, rather than in the
 * `StoreNotices` port: the port is a platform-neutral two-string seam that
 * mobile implements against its own surface, and "render this string as a
 * path" is a fact about how the web draws a toast, not about the notice.
 */

/**
 * The path lane's character budget, chosen from the box it has to sit in:
 * the toast caps at 452px, less 12px of padding a side, over Geist Mono at
 * 10.5px (~6.3px per advance) — about 68 characters. The budget is set below
 * that on purpose. Segments are dropped from the left, and the leftmost ones
 * are the least identifying (`/home/<user>/<repo>` is shared by every worktree
 * on the machine), so spending the last few characters to keep them buys
 * nothing and costs the notice a visibly wider box.
 */
export const NOTICE_PATH_CHARS = 56

/** Absolute POSIX, home-relative, or Windows path. A sentence never matches. */
export function looksLikePath(text: string): boolean {
  return /^(\/|~\/|[A-Za-z]:[\\/])/.test(text) && !/\s/.test(text)
}

/**
 * Drop leading segments until the path fits `maxChars`, and say that it was cut
 * with a leading `…/`.
 *
 * Character-level elision — what `text-overflow: ellipsis` would do on its own —
 * cuts mid-token and yields `…odium/podium/.worktrees/…`, which reads as damage
 * rather than as shortening. Cutting at a separator keeps every surviving
 * segment whole. Returns the path unchanged when it already fits, and the bare
 * last segment when even that is over budget — CSS then ellipses what is left.
 */
export function elidePathHead(path: string, maxChars: number = NOTICE_PATH_CHARS): string {
  if (path.length <= maxChars) return path
  const segments = path.split('/').filter((s) => s.length > 0)
  const last = segments[segments.length - 1]
  if (last === undefined) return path

  let kept = last
  for (let i = segments.length - 2; i >= 0; i--) {
    const wider = `${segments[i]}/${kept}`
    // +2 for the "…/" that says segments were dropped.
    if (wider.length + 2 > maxChars) break
    kept = wider
  }
  return `…/${kept}`
}
