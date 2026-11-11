/** Mail opens the account client; secrets and the entire return path stay in its fragment. */
export function accountMailLink(
  appOrigin: string,
  page: 'reset-password' | 'verify-email',
  token: string,
  libraryUrl: string,
): string {
  const link = new URL(`/account/${page}`, appOrigin)
  const callback = new URL(libraryUrl).searchParams.get('callbackURL')
  let returnTo = '/account/workspaces'
  if (callback) {
    const target = new URL(callback, appOrigin)
    if (target.origin === link.origin) {
      returnTo =
        target.pathname === link.pathname
          ? (new URLSearchParams(target.hash.slice(1)).get('returnTo') ??
            target.searchParams.get('returnTo') ??
            returnTo)
          : target.pathname + target.search + target.hash
    }
  }
  link.hash = new URLSearchParams({ token, returnTo }).toString()
  return link.href
}
