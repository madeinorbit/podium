import { artifactUrl } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { omitGone } from '@podium/client-graph/lookup'
import type { SessionId } from '@podium/model/browser'
import { currentWorkspaceSlug } from '@/lib/workspace-request'

/** Both observer galleries and scalar hooks read the issue's shared upload
 * model. No second cache or synchronized list of attachment URLs. */
export function chatUploadSrc(
  pool: MobxPool | null,
  sessionId: SessionId,
  attachmentId: string | undefined,
  httpOrigin: string,
): string | null {
  if (!pool || !attachmentId) return null
  const reader = omitGone(pool.row('chatContextReader', 'reader'))
  const found =
    reader && typeof reader !== 'symbol' ? reader.chatUpload(sessionId, attachmentId) : undefined
  return found
    ? artifactUrl({
        httpOrigin,
        workspace: currentWorkspaceSlug(),
        issueId: found.issueId,
        artifact: found.artifact,
      })
    : null
}
