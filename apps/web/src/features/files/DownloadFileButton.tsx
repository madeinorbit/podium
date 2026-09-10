import type { FileScope } from '@podium/client-core/viewmodels'
import { Download } from 'lucide-react'
import type { JSX } from 'react'
import { toast } from 'sonner'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { downloadFileUrl } from './open-in-browser'

/**
 * Saves the open file to disk. Sits beside `OpenInBrowserButton` and points at the
 * same raw-bytes route, with `download=1` so the server answers as an attachment.
 *
 * The server flag, not just the anchor's `download` attribute, is what carries the
 * feature: browsers ignore `download` on a cross-origin link, and the desktop shell's
 * webview only saves what the response declares a download. Unlike Open in browser,
 * this stays inside the webview, so the request rides the app's own session cookie
 * everywhere; the shell's download handler picks the destination.
 */
export function DownloadFileButton({
  scope,
  path,
  dirty,
}: {
  scope: FileScope
  path: string
  /** Warn when the saved bytes are the on-disk ones, not what's in the editor. */
  dirty: boolean
}): JSX.Element | null {
  const httpOrigin = useStoreSelector((s) => s.httpOrigin)
  const origin = httpOrigin || (typeof window === 'undefined' ? '' : window.location.origin)
  const target = downloadFileUrl({ httpOrigin: origin, scope, path })
  if (!target) return null

  return (
    <Button
      render={<a href={target.url} download={target.name} rel="noopener noreferrer" />}
      variant="ghost"
      size="icon-xs"
      aria-label="Download"
      title="Download"
      onClick={() => {
        if (dirty)
          toast.info('Downloaded the version saved on disk — this tab has unsaved changes.')
      }}
    >
      <Download size={14} />
    </Button>
  )
}
