export type ServerRelocation = (publicUrl: string, transferId: string, claimToken?: string) => void

/** Cookie transfer stays in the fragment, never in a logged request URL. */
export function serverRelocationDestination(
  publicUrl: string,
  next: string,
  claimToken?: string,
): string {
  const destination = new URL(next, `${publicUrl.replace(/\/$/, '')}/`)
  if (!claimToken) return destination.toString()
  const claim = new URL('/auth/server-transfer-claim', publicUrl)
  claim.hash = new URLSearchParams({ token: claimToken, next }).toString()
  return claim.toString()
}

export function browserServerRelocation(
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'replace'>,
): ServerRelocation {
  return (publicUrl, _transferId, claimToken) => {
    const next = `${location.pathname}${location.search}${location.hash}`
    location.replace(serverRelocationDestination(publicUrl, next, claimToken))
  }
}

/**
 * THE BROWSER'S ONE WAY TO MOVE (POD-5921), for the web app and the phone's
 * web build — never under the desktop bridge, which moves its own window.
 *
 *  - A TRANSFER with a claim: the claim page at the new origin turns the
 *    one-time token into a session there, then lands on the same path.
 *  - A CONNECT FIND (already proven by the follower): the same path at the new
 *    origin. The session cookie stays host-only and HttpOnly, so it does NOT
 *    come along — the person signs in there, and is told so first.
 */
export interface BrowserFollowOptions {
  location: Pick<Location, 'pathname' | 'search' | 'hash' | 'replace'>
  /** Shows one line for about `noticeMs` before the page leaves. */
  notify?: (message: string) => void
  noticeMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
}

export interface BrowserMove {
  via: 'connect' | 'transfer'
  origin: string
  transferId?: string
  claimToken?: string
}

/** The URL a browser follows a Connect find to: the same path at the new origin. */
export function browserFollowDestination(
  origin: string,
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
): string {
  return `${new URL(origin).origin}${location.pathname}${location.search}${location.hash}`
}

export function browserFollowAdopt(
  opts: BrowserFollowOptions,
): (move: BrowserMove) => Promise<void> {
  const wait = (ms: number) =>
    new Promise<void>((resolve) => (opts.setTimeout ?? setTimeout)(resolve, ms))
  return async (move) => {
    const host = new URL(move.origin).host
    if (move.via === 'transfer') {
      opts.notify?.(`Podium moved to ${host}`)
      browserServerRelocation(opts.location)(move.origin, move.transferId ?? '', move.claimToken)
      return
    }
    opts.notify?.(`Podium moved to ${host}. You will need to log in there.`)
    await wait(opts.noticeMs ?? 1_500)
    opts.location.replace(browserFollowDestination(move.origin, opts.location))
  }
}
