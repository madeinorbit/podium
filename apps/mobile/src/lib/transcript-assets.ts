import { resolveMachinePath, type SessionId } from '@podium/model'
export interface TranscriptAssetContext {
  httpOrigin: string
  sessionId: SessionId
  cwd: string
}

/** Build the authenticated server route used by both image previews and file opens. */
export function sessionAssetUrl(context: TranscriptAssetContext, path: string): string {
  const absolute = resolveMachinePath(context.cwd, path)
  const query = new URLSearchParams({ sessionId: context.sessionId, path: absolute })
  return `${context.httpOrigin.replace(/\/+$/, '')}/files/asset?${query.toString()}`
}
