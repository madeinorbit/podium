import type { AdminViewer } from './admin-viewer'

export function AdminViewerError({ viewer }: { viewer: AdminViewer }) {
  if (viewer.status !== 'error') return null
  return (
    <div role="status" className="settings-prose px-2.5 py-2 text-muted-foreground">
      <p>Couldn’t check administrator access.</p>
      <button type="button" className="mt-1 underline underline-offset-2" onClick={viewer.retry}>
        Retry
      </button>
    </div>
  )
}
