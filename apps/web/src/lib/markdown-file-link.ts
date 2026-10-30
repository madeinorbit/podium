import { isAbsoluteMachinePath, resolveMachinePath } from '@podium/model/browser'

/**
 * The machine path a rendered Markdown link names, or null when it names
 * something else.
 *
 * Agents link the files they wrote as ordinary Markdown links —
 * `[review.html](/home/me/repo/docs/review.html)`, `[notes](docs/notes.md:12)`.
 * A host-less href resolves against the Podium origin, so letting the anchor
 * navigate loads the SPA again instead of the file. The file viewer reads
 * through the daemon on the session's machine, which is the one route that
 * works whether this client is a browser tab, the desktop shell or the phone,
 * and whether the agent runs on this machine or a remote one.
 *
 * Conservative about absolute paths, because a host-less absolute href can
 * also be a Podium route or a page on the site an agent is writing about
 * (`/de/#pricing`). Those carry no extension and live under no filesystem root.
 */
export function markdownLinkFilePath(href: string, cwd: string): string | null {
  let raw = href.trim()
  if (/^file:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      if (url.host && url.host !== 'localhost') return null
      raw = url.pathname + url.hash
      // file:///C:/x arrives with a leading slash before the drive.
      if (/^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1)
    } catch {
      return null
    }
  } else if (raw === '' || raw.startsWith('#') || raw.startsWith('//') || raw.includes('?')) {
    return null
  } else if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) {
    return null // a URL with a scheme (https:, mailto:, podium:)
  }

  const hashAt = raw.indexOf('#')
  let path = hashAt === -1 ? raw : raw.slice(0, hashAt)
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  // `file.ts:12` and `file.ts:12:3` — the viewer opens files, not positions.
  path = path.replace(/:\d+(?::\d+)?$/, '')
  if (path === '' || /[\\/]$/.test(path)) return null

  if (!isAbsoluteMachinePath(path)) return path
  const resolved = resolveMachinePath(cwd, path)
  if (cwd && isWithin(resolved, cwd)) return path
  if (FILESYSTEM_ROOT.test(path) || /^[A-Za-z]:[\\/]|^\\\\/.test(path)) return path
  return /\.[A-Za-z\d]{1,10}$/.test(path) ? path : null
}

const FILESYSTEM_ROOT =
  /^\/(?:home|Users|root|tmp|private|var|opt|srv|mnt|Volumes|workspace|workspaces)\//

function isWithin(path: string, dir: string): boolean {
  const base = dir.replace(/[\\/]+$/, '')
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)
}

/** The file an ordinary Markdown link under `target` names, read from the href
 * the agent wrote: externalizeLinks rewrites host-less hrefs to the server's
 * absolute address and keeps the authored one in data-podium-link-source. */
export function linkedFilePath(target: HTMLElement | null, cwd: string): string | null {
  const anchor = target?.closest?.('a[data-podium-link-source]') as HTMLElement | null
  const href = anchor?.getAttribute('data-podium-link-source')
  return href ? markdownLinkFilePath(href, cwd) : null
}
