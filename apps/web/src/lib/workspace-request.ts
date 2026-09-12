import { workspaceSlug } from '@podium/client-core/router'

export { workspaceSlug } from '@podium/client-core/router'

/** The page's hosted workspace selector for browser-visible URLs. */
export function currentWorkspaceSlug(
  pathname = globalThis.location?.pathname ?? '',
): string | undefined {
  return workspaceSlug(pathname)
}

export function workspaceRequestInit(
  input: RequestInfo | URL,
  init?: RequestInit,
): RequestInit | undefined {
  const slug = currentWorkspaceSlug()
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
  const slug = currentWorkspaceSlug(pathname)
  if (!slug) return url
  const parsed = new URL(url)
  parsed.searchParams.set('workspace', slug)
  return parsed.href
}
