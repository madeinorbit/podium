/** Workspace routing is a hint until the server supports multiple workspaces. */
export function workspaceSlug(pathname: string): string | undefined {
  const segment = /^\/w\/([^/]+)(?:\/|$)/.exec(pathname)?.[1]
  if (!segment) return undefined
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

export function workspaceRequestInit(
  input: RequestInfo | URL,
  init?: RequestInit,
): RequestInit | undefined {
  const slug = workspaceSlug(globalThis.location?.pathname ?? '')
  if (!slug) return init
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  )
  headers.set('Podium-Workspace', slug)
  return { ...init, headers }
}

export const workspaceFetch: typeof fetch = (input, init) =>
  fetch(input, workspaceRequestInit(input, init))

export function workspaceSocketUrl(url: string, pathname: string): string {
  const slug = workspaceSlug(pathname)
  if (!slug) return url
  const parsed = new URL(url)
  parsed.searchParams.set('workspace', slug)
  return parsed.href
}
