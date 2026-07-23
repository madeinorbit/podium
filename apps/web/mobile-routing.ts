/** Return the phone entry redirect for Vite's front door, if one applies. */
export function mobileRedirectLocation(
  rawUrl: string | undefined,
  userAgent: string | undefined,
  mobilePresent: boolean,
): string | null {
  if (!mobilePresent) return null
  const url = new URL(rawUrl ?? '/', 'http://podium.local')
  if (url.pathname !== '/' || url.searchParams.has('desktop')) return null

  // This is the original working pre-redesign phone heuristic: generic Mobile
  // browsers count, while iPad/tablet UAs remain on the desktop shell.
  const phone =
    /Android|iPhone|iPod|Mobile/i.test(userAgent ?? '') && !/iPad|Tablet/i.test(userAgent ?? '')
  return phone ? `/mobile${url.search}` : null
}
