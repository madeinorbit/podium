import { useEffect, useState } from 'react'
import { workspaceSlug } from '@/lib/workspace-request'
import { serverConfig } from './trpc'

type Workspace = { id: string; slug: string; status?: string }

/** Only workspace-prefixed hosted URLs ask their configured server for a registry. */
export function HostedWorkspaceSwitcher() {
  const slug = workspaceSlug(location.pathname)
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Workspace[]>([])
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!slug || !open) return
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    setRows([])
    void fetch(`${serverConfig(location).httpOrigin}/platform/workspaces`, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Workspace list unavailable')
        const result: Workspace[] = await response.json()
        if (!controller.signal.aborted) setRows(result)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [slug, open])
  if (!slug) return null
  return (
    <details className="relative text-xs" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary aria-label="Switch workspace" className="cursor-pointer px-2 py-1">
        {slug}
      </summary>
      {open && (
        <nav
          aria-label="Hosted workspaces"
          className="absolute left-0 top-full z-50 min-w-48 rounded border border-border bg-background p-3 shadow-lg"
        >
          {loading && <p>Loading workspaces…</p>}
          {error && <p role="alert">Could not load workspaces. Reopen to retry.</p>}
          <ul>
            {rows.map((row) => (
              <li key={row.id} className="py-1">
                {row.status === 'pending' ? (
                  <span>{row.slug} · Awaiting provisioning</span>
                ) : (
                  <a
                    href={`/w/${encodeURIComponent(row.slug)}`}
                    aria-current={row.slug === slug ? 'page' : undefined}
                  >
                    {row.slug}
                  </a>
                )}
              </li>
            ))}
          </ul>
          <a href="/account/workspaces">Manage workspaces</a>
        </nav>
      )}
    </details>
  )
}
