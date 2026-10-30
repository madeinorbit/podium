import { isAbsoluteMachinePath, resolveMachinePath } from '@podium/model/browser'
import { internalPodiumTarget } from './podium-link'

/**
 * The machine path a rendered Markdown link names, or null when it names
 * something else.
 *
 * Agents link the files they wrote as ordinary Markdown links —
 * `[review.html](/home/me/repo/docs/review.html)`, `[notes](docs/notes.md:12)`.
 * A host-less href resolves against the Podium origin, so letting the anchor
 * navigate loads the SPA again instead of the file. The file viewer reads
 * through the daemon on the session's machine, which is the one route that
 * works whether this client is a browser tab or the desktop shell, and whether
 * the agent runs on this machine or a remote one.
 *
 * Conservative about absolute paths, because a host-less absolute href can
 * also be a Podium route or a page on the site an agent is writing about
 * (`/de/#pricing`, `/de/pricing.html#plans`). A path counts as a file only
 * with evidence: it lies under the session's cwd or a filesystem root, or it
 * carries a source-file extension and no page fragment.
 */
export function markdownLinkFilePath(href: string, cwd: string): string | null {
  // The URL parser drops TAB/LF/CR, so `ht\ntps://x` is a web link to it too.
  let raw = href.replace(/[\t\n\r]/g, '').trim()
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
  } else if (raw === '' || raw.startsWith('#') || raw.includes('?')) {
    return null
  } else if (/^[\\/][\\/]/.test(raw)) {
    return null // authority-relative: `//host`, and `/\host` to the URL parser
  } else if (SCHEME.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) {
    return null // a URL with a scheme (https:, mailto:, podium:)
  } else if ((internalPodiumTarget(raw)?.kind ?? 'view') !== 'view') {
    // An issue, session, artifact or file address in this Podium. Plain page
    // addresses (`/workspace`, `/home/me/a.md`) parse as views and stay open.
    return null
  }

  const hashAt = raw.indexOf('#')
  let path = hashAt === -1 ? raw : raw.slice(0, hashAt)
  const fragment = hashAt === -1 ? '' : raw.slice(hashAt + 1)
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  // `file.ts:12` and `file.ts:12:3` — the viewer opens files, not positions.
  path = path.replace(/:\d+(?::\d+)?$/, '')
  if (path === '' || /[\\/]$/.test(path)) return null
  const pageFragment = fragment !== '' && !LINE_FRAGMENT.test(fragment)
  const extension = /\.([A-Za-z\d]{1,10})$/.exec(path)?.[1]?.toLowerCase()

  if (!isAbsoluteMachinePath(path)) {
    // `docs/notes.md#setup` is a heading in a file; `de/pricing#plans` a page.
    if (pageFragment && !extension) return null
    const named = path.startsWith('./') || path.startsWith('../') || path.includes('/')
    return named || extension ? path : null
  }
  if (cwd && isWithin(resolveMachinePath(cwd, path), cwd) && segments(path) > 1) return path
  if (pageFragment) return null
  if (/^[A-Za-z]:[\\/]/.test(path)) return path
  // `/home/pricing` is a page; `/home/me/notes` and `/tmp/a.log` are files.
  if (FILESYSTEM_ROOT.test(path) && (segments(path) > 2 || extension)) return path
  return extension && !WEB_PAGE_EXTENSION.has(extension) ? path : null
}

/** A scheme, but not `README.md:12`: a line suffix is all digits. */
const SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?::\d+)?(?:#|$))/

/** `#L12`, `#L12-L20`, `#L12C3`: a position in a file, not a page anchor. */
const LINE_FRAGMENT = /^L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/

const FILESYSTEM_ROOT =
  /^\/(?:home|Users|root|tmp|private|var|opt|srv|mnt|Volumes|workspace|workspaces)\//

const WEB_PAGE_EXTENSION = new Set(['html', 'htm', 'php', 'asp', 'aspx', 'jsp'])

function segments(path: string): number {
  return path.split(/[\\/]/).filter(Boolean).length
}

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
