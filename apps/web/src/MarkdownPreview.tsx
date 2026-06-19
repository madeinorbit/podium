// apps/web/src/MarkdownPreview.tsx
import { type JSX, useMemo } from 'react'
import { assetUrl } from './asset-url'
import { resolveAgainstCwd } from './file-path'
import { renderMarkdownBlocks } from './markdown-blocks'
import { useStore } from './store'

/** Rendered markdown preview. Relative images resolve through /files/asset; clicking
 *  a linkified file path opens it as a tab (same behavior as chat). The scroll
 *  container is exposed via scrollRef for split-view sync. */
export function MarkdownPreview({
  sessionId,
  path,
  content,
  scrollRef,
}: {
  sessionId: string
  path: string
  content: string
  scrollRef?: React.MutableRefObject<HTMLDivElement | null>
}): JSX.Element {
  const { httpOrigin, openFile } = useStore()
  const fileDir = path.replace(/\/[^/]*$/, '') || '/'
  const html = useMemo(
    () =>
      renderMarkdownBlocks(content, {
        resolveAsset: (src) => assetUrl({ httpOrigin, sessionId, fileDir, src }),
      }),
    [content, httpOrigin, sessionId, fileDir],
  )

  const onClick = (e: React.MouseEvent): void => {
    const a = (e.target as HTMLElement).closest('a.file-link') as HTMLAnchorElement | null
    if (!a) return
    e.preventDefault()
    const p = a.getAttribute('data-path')
    if (p) openFile(sessionId, resolveAgainstCwd(fileDir, p))
  }

  return (
    <div
      ref={(el) => {
        if (scrollRef) scrollRef.current = el
      }}
      className="markdown-preview min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px]"
      onClick={onClick}
      // eslint-disable-next-line react/no-danger -- sanitized by renderMarkdownBlocks (DOMPurify)
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
