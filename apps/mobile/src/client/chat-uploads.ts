import { artifactUrl } from '@podium/client-core/values'
import { chatItemAttachments, chatUploadArtifact } from '@podium/client-graph/chat-context'
import type { MobxPool } from '@podium/client-graph/pool'
import { useCallback } from 'react'
import { useMobilePoolProjection } from './mobile-pool'
import { useOptionalServerProfile } from './server-profile-context'

/**
 * THE ISSUE'S STORED COPY OF A CHAT UPLOAD (POD-2148), as the web resolves it:
 * by the upload id, through the session's issue model. A string, or null when
 * the issue holds no copy and the caller keeps its fallback (the daemon file
 * an older message names).
 */
export function chatUploadUrl(
  pool: MobxPool,
  sessionId: string,
  attachmentId: string,
  httpOrigin: string,
  workspace?: string,
): string | null {
  const found = chatUploadArtifact(pool, sessionId, attachmentId)
  return found
    ? artifactUrl({
        httpOrigin,
        issueId: found.issueId,
        artifact: found.artifact,
        ...(workspace ? { workspace } : {}),
      })
    : null
}

export function useChatUploadUrl(
  sessionId: string | undefined,
  attachmentId: string | undefined,
  httpOrigin: string | undefined,
): string | null {
  const profile = useOptionalServerProfile()
  const workspace = profile?.config.workspaceId ?? profile?.config.workspaceSlug
  const read = useCallback(
    (pool: MobxPool) =>
      sessionId && attachmentId && httpOrigin
        ? chatUploadUrl(pool, sessionId, attachmentId, httpOrigin, workspace)
        : null,
    [sessionId, attachmentId, httpOrigin, workspace],
  )
  return useMobilePoolProjection(read, null)
}

const NO_ATTACHMENTS: readonly { id?: string; filename: string; kind: 'image' | 'file' }[] = []

/** The attachments of the chat message matched to a history entry that names
 *  no file of its own (a queued `[Image #N]` turn). */
export function useChatItemAttachments(sessionId: string | undefined, itemId: string) {
  const read = useCallback(
    (pool: MobxPool) =>
      (sessionId ? chatItemAttachments(pool, sessionId, itemId) : undefined) ?? NO_ATTACHMENTS,
    [sessionId, itemId],
  )
  return useMobilePoolProjection(read, NO_ATTACHMENTS)
}
