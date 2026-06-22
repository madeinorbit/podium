/**
 * Canonical identity for a git remote, so two clones of the same repo on different
 * machines compare equal. Host is lowercased (DNS is case-insensitive); the path is
 * left as-is (case-sensitive on most forges). `.git` suffix, trailing slash, scheme,
 * userinfo, and port are all stripped. Non-URL input is returned trimmed (so a
 * remote-less repo still only matches itself).
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
