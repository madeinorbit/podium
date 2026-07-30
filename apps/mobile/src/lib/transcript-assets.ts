export interface TranscriptAssetContext {
  httpOrigin: string
  sessionId: string
  cwd: string
}

export function pathBasename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** Build the authenticated server route used by both image previews and file opens. */
export function sessionAssetUrl(context: TranscriptAssetContext, path: string): string {
  const absolute = path.startsWith('/') ? path : `${context.cwd.replace(/\/+$/, '')}/${path}`
  const query = new URLSearchParams({ sessionId: context.sessionId, path: absolute })
  return `${context.httpOrigin.replace(/\/+$/, '')}/files/asset?${query.toString()}`
}
