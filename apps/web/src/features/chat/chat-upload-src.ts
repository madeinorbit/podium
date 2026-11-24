import { artifactUrl } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { LOADING } from '@podium/client-graph/loading'
import { omitGone } from '@podium/client-graph/lookup'
import type { SessionId } from '@podium/model/browser'
import { currentWorkspaceSlug } from '@/lib/workspace-request'

/** Both observer galleries and scalar hooks read the issue's shared uploads:
 * LOADING until complete, then the stored-copy URL or null when none exists. */
export function chatUploadSrc(
  pool: MobxPool | null,
  sessionId: SessionId,
  attachmentId: string | undefined,
  httpOrigin: string,
): string | null | typeof LOADING {
  if (!pool || !attachmentId) return null
  const reader = omitGone(pool.row('chatContextReader', 'reader'))
  if (reader === LOADING) return LOADING
  const found = reader?.chatUpload(sessionId, attachmentId)
  if (found === LOADING) return LOADING
  return found
    ? artifactUrl({
        httpOrigin,
        workspace: currentWorkspaceSlug(),
        issueId: found.issueId,
        artifact: found.artifact,
      })
    : null
}
