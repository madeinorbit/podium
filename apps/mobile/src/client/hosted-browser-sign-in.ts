/** Browser sessions use the account cookie, never the native handoff or keychain. */
export function hostedBrowserSignInUrl(signInUrl: string, currentUrl: string): string {
  const current = new URL(currentUrl)
  const page = new URL(signInUrl, current.origin)
  if (
    page.protocol !== 'https:' ||
    page.username ||
    page.password ||
    page.pathname !== '/account/sign-in'
  ) throw new Error('Invalid account sign-in page.')

  // Only return to a mobile route on the account origin. Never forward an
  // arbitrary returnTo, handoff challenge, or a different browser origin.
  const mobile = current.pathname === '/mobile' || current.pathname.startsWith('/mobile/')
  const destination = current.origin === page.origin && mobile && !/[\\\r\n]/.test(current.pathname)
    ? current.pathname + current.search + current.hash
    : '/mobile/'
  page.search = new URLSearchParams({ returnTo: destination }).toString()
  page.hash = ''
  return page.href
}
