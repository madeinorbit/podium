/**
 * Add the immutable hosted workspace target to an endpoint before any socket
 * or HTTP request is opened. Self-hosted installs omit it and keep their
 * existing URL shape.
 */
export function workspaceEndpoint(
  serverUrl: string,
  path: string,
  workspaceId?: string,
): string {
  const endpoint = new URL(path, serverUrl.replace(/\/$/, '') + '/')
  if (workspaceId) endpoint.searchParams.set('workspace', workspaceId)
  return endpoint.toString()
}

/** Add the same selector to an already assembled HTTP endpoint. */
export function workspaceRequestUrl(url: string, workspaceId?: string): string {
  if (!workspaceId) return url
  const endpoint = new URL(url)
  endpoint.searchParams.set('workspace', workspaceId)
  return endpoint.toString()
}
