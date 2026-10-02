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
