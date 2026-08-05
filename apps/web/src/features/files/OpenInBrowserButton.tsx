import type { FileScope } from '@podium/client-core/viewmodels'
import { ExternalLink } from 'lucide-react'
import type { JSX } from 'react'
import { toast } from 'sonner'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { rawFileUrl } from './open-in-browser'

/**
 * Hands the open file to a real browser tab. The panel's HTML preview runs in an
 * opaque-origin iframe with scripts off outside artifact scope, so a mockup only
 * shows its true self in a browser — this is that escape hatch.
 *
 * A plain anchor rather than a scripted `window.open`: ⌘-click, middle-click and
 * "copy link" all work, and no popup blocker gets in the way.
 */
export function OpenInBrowserButton({
  scope,
  path,
  dirty,
}: {
  scope: FileScope
  path: string
  /** Warn when the tab would show the on-disk bytes, not what's in the editor. */
  dirty: boolean
}): JSX.Element | null {
  const httpOrigin = useStoreSelector((s) => s.httpOrigin)
  const origin = httpOrigin || (typeof window === 'undefined' ? '' : window.location.origin)
  const url = rawFileUrl({ httpOrigin: origin, scope, path })
  if (!url) return null

  return (
    <Button
      render={<a href={url} target="_blank" rel="noopener noreferrer" />}
      variant="ghost"
      size="icon-xs"
      aria-label="Open in browser"
      title="Open in browser"
      onClick={() => {
        if (dirty) toast.info('Opened the version saved on disk — this tab has unsaved changes.')
      }}
    >
      <ExternalLink size={14} />
    </Button>
  )
}
