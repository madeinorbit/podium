import { useHttpOrigin, useUi } from '@podium/client-core/react'
import { machinePathDirname, resolveMachinePath } from '@podium/model'
// apps/web/src/MarkdownPreview.tsx

import type { MachineId, SessionId } from '@podium/model/browser'
import { type JSX, type Ref, useMemo } from 'react'
import { assetUrl } from '@/lib/asset-url'
import { handleCodeCopyClick } from '@/lib/code-copy'
import { linkedFilePath } from '@/lib/markdown-file-link'
import { handlePodiumLinkClick } from '@/lib/podium-link-click'
import { cn } from '@/lib/utils'
import { renderMarkdownBlocks } from './markdown-blocks'

/** Rendered markdown preview. Relative images resolve through /files/asset; clicking
 *  a linkified file path opens it as a tab (same behavior as chat). The scroll
 *  container is exposed via scrollRef for split-view sync. A worktree-scoped
 *  preview (empty sessionId) opens linked files through `worktree` instead. */
export function MarkdownPreview({
  sessionId,
  worktree,
  path,
  content,
  scrollRef,
  className,
}: {
  sessionId: SessionId
  worktree?: { root: string; machineId?: MachineId }
  path: string
  content: string
  scrollRef?: Ref<HTMLDivElement>
  className?: string
}): JSX.Element {
  const httpOrigin = useHttpOrigin(),
    { openFile, openFileInWorktree } = useUi()
  const fileDir = machinePathDirname(path)
  const html = useMemo(
    () =>
      renderMarkdownBlocks(content, {
        resolveAsset: (src) => assetUrl({ httpOrigin, sessionId, fileDir, src }),
      }),
    [content, httpOrigin, sessionId, fileDir],
  )
  // React DOM re-assigns innerHTML whenever this prop is a NEW object, even with
  // the same string, which replaces every node on any parent re-render: a reader's
  // selection is lost and anything holding the old nodes is left with detached
  // ones (POD-2322). One object per distinct HTML keeps the DOM across renders.
  const inner = useMemo(() => ({ __html: html }), [html])

  const onClick = (e: React.MouseEvent): void => {
    if (handleCodeCopyClick(e)) return // copy button works even without a session
    const open = sessionId
      ? (abs: string) => openFile(sessionId, abs)
      : worktree
        ? (abs: string) => openFileInWorktree({ ...worktree, path: abs })
        : null
    // A relative link in a Markdown file names a sibling file, not a page on
    // the Podium origin. Checked before Podium links, which would claim
    // `/abs/path.md` as an unroutable view and reload the app.
    const linked =
      open && !e.defaultPrevented ? linkedFilePath(e.target as HTMLElement, fileDir) : null
    if (open && linked) {
      e.preventDefault()
      open(resolveMachinePath(fileDir, linked))
      return
    }
    // A link into this Podium needs no session, and must be claimed here: the
    // preview's anchors are marked exactly like the transcript's, and without a
    // handler an internal link full-page-navigates the SPA off this file
    // (POD-1606).
    if (handlePodiumLinkClick(e)) return
    if (!open) return
    const a = (e.target as HTMLElement).closest('a.file-link') as HTMLAnchorElement | null
    if (!a) return
    e.preventDefault()
    const p = a.getAttribute('data-path')
    if (p) open(resolveMachinePath(fileDir, p))
  }

  return (
    <div
      ref={scrollRef}
      // Reading typography (measure, leading, padding) lives entirely in
      // `.markdown-preview` in styles.css — no utility sizing here to fight it.
      className={cn('markdown-preview min-h-0 flex-1 overflow-auto', className)}
      // A selection here can be added to the chat as a quote of this file (POD-2057).
      data-quote-source={path}
      onClick={onClick}
      // eslint-disable-next-line react/no-danger -- sanitized by renderMarkdownBlocks (DOMPurify)
      dangerouslySetInnerHTML={inner}
    />
  )
}
