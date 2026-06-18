/** Resolve a path that may be relative to a session cwd into an absolute path.
 *  Browser-side, so no node:path — POSIX join + a light `.`/`..` normalize. */
export function resolveAgainstCwd(cwd: string, path: string): string {
  const abs = path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`
  const out: string[] = []
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`
}
