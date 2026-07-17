/**
 * Canonical identity for a git remote, so two clones of the same repo on different
 * machines compare equal. Host is lowercased (DNS is case-insensitive); the path is
 * left as-is (case-sensitive on most forges). `.git` suffix, trailing slash, scheme,
 * userinfo, and port are all stripped. Non-URL input is returned trimmed (so a
 * remote-less repo still only matches itself).
 *
 * Canonical home (#194): moved from @podium/runtime/git.ts (which now re-exports it)
 * so browser-safe consumers (client-core's viewmodels, shared with the mobile
 * app) can import it directly instead of hand-copying it.
 */
export function normalizeOriginUrl(raw: string | undefined): string {
  if (!raw) return ''
  let s = raw.trim()
  if (!s) return ''
  // scp-style: git@host:path  ->  host/path
  const scp = s.match(/^[^/@]+@([^:/]+):(.+)$/)
  if (scp) {
    s = `${scp[1]}/${scp[2]}`
  } else {
    const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(.+)$/i)
    if (m?.[1])
      s = m[1].replace(/^[^/@]+@/, '') // drop scheme + userinfo
    else return s.replace(/\.git$/, '').replace(/\/+$/, '') // not a recognizable URL
  }
  // s is now host[:port]/path
  s = s.replace(/\/+$/, '').replace(/\.git$/, '')
  const slash = s.indexOf('/')
  if (slash === -1) return s.toLowerCase()
  const host = s.slice(0, slash).replace(/:\d+$/, '').toLowerCase()
  const path = s.slice(slash + 1).replace(/\.git$/, '')
  return `${host}/${path}`
}

/**
 * The repository's OWN name: the last segment of its normalized origin
 * (`host/owner/repo` → `repo`). A clone's folder is not its identity — a backup
 * clone at ~/bak_podium of .../podium.git is still "podium" — so display surfaces
 * name a repo by its origin and keep the path as the disambiguator.
 *
 * Null when the origin yields no repo segment (absent, or a bare host with no
 * path): the caller falls back to the folder name, which is all we know then.
 */
export function repoNameFromOrigin(originUrl: string | undefined): string | null {
  const normalized = normalizeOriginUrl(originUrl)
  // No '/' means no path segment — a bare host, or unparseable junk returned
  // as-is. Neither names a repo.
  const slash = normalized.indexOf('/')
  if (slash === -1) return null
  return (
    normalized
      .slice(slash + 1)
      .split('/')
      .filter(Boolean)
      .pop() ?? null
  )
}
