import type { SessionId } from '@podium/model/browser'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { handleCodeCopyClick } from '@/lib/code-copy'
import { resolveAgainstCwd } from '@/lib/file-path'
import { handlePodiumLinkClick } from '@/lib/podium-link-click'
import { activateRef } from '@/lib/ref-activation'

/**
 * Shared delegated handling for sanitized transcript Markdown. This module is
 * deliberately renderer-free because ChatView uses it outside the deferred
 * TranscriptFeed for the pinned brief.
 */
export function handleChatMdClick(
  event: ReactMouseEvent,
  sessionId: SessionId,
  cwd: string,
  openFile: (sessionId: SessionId, path: string) => void,
): void {
  if (handleCodeCopyClick(event)) return

  const target = event.target as HTMLElement | null
  const refAnchor = target?.closest?.('a.ref-link') as HTMLElement | null
  if (refAnchor) {
    const ref = refAnchor.getAttribute('data-ref')
    if (ref) {
      event.preventDefault()
      activateRef(ref, event)
    }
    return
  }

  const fileAnchor = target?.closest?.('a.file-link') as HTMLElement | null
  if (fileAnchor) {
    event.preventDefault()
    const path = fileAnchor.getAttribute('data-path')
    if (path) openFile(sessionId, resolveAgainstCwd(cwd, path))
    return
  }

  // A link that addresses this Podium (POD-1606), through the same handler the
  // file/artifact preview uses — the two markdown pipelines mark their anchors
  // identically, so answering the click in one place is what keeps them from
  // drifting apart.
  handlePodiumLinkClick(event)
}
