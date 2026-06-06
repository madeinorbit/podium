import { Check, ChevronUp, Eye, EyeOff, Folder, Home, RefreshCw, Search, X } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { formatAppError } from './AppErrorPage'
import { useStore } from './store'

type DirectoryEntry = {
  name: string
  path: string
}

type DirectoryListing = {
  path: string
  homePath: string
  parentPath: string | null
  entries: DirectoryEntry[]
}

export function RepoPickerModal({
  onClose,
  onPick,
  onScan,
  intro,
}: {
  onClose: () => void
  /** Add exactly the browsed folder as a repo (for when you know the path). */
  onPick: (path: string) => Promise<void>
  /** Scan the browsed folder for repos and hand the parent the ranked candidates. */
  onScan?: (path: string) => Promise<void>
  /** Optional header content (used by the onboarding wizard for a welcome line). */
  intro?: ReactNode
}): JSX.Element {
  const { trpc } = useStore()
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (path?: string, includeHidden = showHidden) => {
      setLoading(true)
      setError(null)
      try {
        setListing(await trpc.repos.browse.query({ ...(path ? { path } : {}), includeHidden }))
      } catch (e) {
        setError(formatAppError(e, 'Could not open directory'))
      } finally {
        setLoading(false)
      }
    },
    [trpc, showHidden],
  )

  useEffect(() => {
    void load()
  }, [load])

  function toggleHidden(): void {
    const next = !showHidden
    setShowHidden(next)
    void load(listing?.path, next)
  }

  const busy = loading || saving || scanning

  async function pickCurrent(): Promise<void> {
    if (!listing) return
    setSaving(true)
    setError(null)
    try {
      await onPick(listing.path)
      onClose()
    } catch (e) {
      setError(formatAppError(e, 'Could not add repo'))
    } finally {
      setSaving(false)
    }
  }

  async function scanCurrent(): Promise<void> {
    if (!listing || !onScan) return
    setScanning(true)
    setError(null)
    try {
      // The parent transitions to the results view on success and unmounts this modal.
      await onScan(listing.path)
    } catch (e) {
      setError(formatAppError(e, 'Could not scan folder'))
      setScanning(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="repo-picker-modal" role="dialog" aria-modal="true" aria-label="Add repo">
        <div className="repo-picker-head">
          <div>
            <div className="label">{onScan ? 'FIND REPOSITORIES' : 'ADD REPO'}</div>
            {intro && <div className="repo-picker-intro">{intro}</div>}
            <div className="repo-picker-path">{listing?.path ?? 'Loading...'}</div>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="repo-picker-toolbar">
          <button
            type="button"
            className="icon-button"
            disabled={!listing || busy}
            onClick={() => listing && void load(listing.homePath)}
            aria-label="Home"
            title="Home"
          >
            <Home size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={!listing?.parentPath || busy}
            onClick={() => listing?.parentPath && void load(listing.parentPath)}
            aria-label="Up"
            title="Up"
          >
            <ChevronUp size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={!listing || busy}
            onClick={() => listing && void load(listing.path)}
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </button>
          <button
            type="button"
            className={showHidden ? 'repo-picker-toggle active' : 'repo-picker-toggle'}
            disabled={busy}
            onClick={toggleHidden}
            aria-pressed={showHidden}
          >
            {showHidden ? <Eye size={16} /> : <EyeOff size={16} />}
            Show hidden
          </button>
          {onScan ? (
            <>
              <button
                type="button"
                className="repo-picker-secondary"
                disabled={!listing || busy}
                onClick={() => void pickCurrent()}
              >
                <Check size={16} />
                Add this folder
              </button>
              <button
                type="button"
                className="repo-picker-add"
                disabled={!listing || busy}
                onClick={() => void scanCurrent()}
              >
                <Search size={16} />
                {scanning ? 'Scanning...' : 'Scan for repos here'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="repo-picker-add"
              disabled={!listing || busy}
              onClick={() => void pickCurrent()}
            >
              <Check size={16} />
              Add this folder
            </button>
          )}
        </div>
        {error && <div className="repo-picker-error">{error}</div>}
        <div className="repo-picker-list" aria-busy={loading}>
          {loading && <div className="empty">Loading directories...</div>}
          {!loading && listing?.entries.length === 0 && (
            <div className="empty">No directories.</div>
          )}
          {!loading &&
            listing?.entries.map((entry) => (
              <button
                type="button"
                className="repo-picker-row"
                key={entry.path}
                onClick={() => void load(entry.path)}
                disabled={busy}
              >
                <Folder size={16} />
                <span>{entry.name}</span>
              </button>
            ))}
        </div>
      </div>
    </div>
  )
}
