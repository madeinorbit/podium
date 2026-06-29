/** True when `root` is one of the registered repo roots or nested under one.
 *  Uses string-prefix containment (root paths and the client's worktree paths
 *  come from the same canonical scan source); deliberately avoids server-side
 *  realpath, which would be wrong for remote-daemon paths. */
export function isAllowedRoot(repoRoots: string[], root: string): boolean {
  return repoRoots.some((r) => root === r || root.startsWith(r.endsWith('/') ? r : `${r}/`))
}
