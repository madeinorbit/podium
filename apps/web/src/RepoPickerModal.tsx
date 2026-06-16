import { Check, ChevronUp, Eye, EyeOff, Folder, Home, RefreshCw, Search } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { formatAppError } from './AppErrorPage'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { cn } from '@/lib/utils'
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
  const isMobile = useIsMobile()
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
    <Dialog
      open
      modal={isMobile ? 'trap-focus' : true}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="flex max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="gap-0 border-b border-border px-3.5 pt-3.5 pb-2.5 pr-10">
          <DialogTitle className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            {onScan ? 'Find repositories' : 'Add repo'}
          </DialogTitle>
          {intro && (
            <div className="mb-1 mt-0.5 max-w-[54ch] text-[13px] text-foreground">{intro}</div>
          )}
          <div className="mt-1 break-words text-[13px] font-medium text-foreground">
            {listing?.path ?? 'Loading...'}
          </div>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2.5">
          <Button
            variant="ghost"
            size="icon"
            disabled={!listing || busy}
            onClick={() => listing && void load(listing.homePath)}
            aria-label="Home"
            title="Home"
          >
            <Home size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={!listing?.parentPath || busy}
            onClick={() => listing?.parentPath && void load(listing.parentPath)}
            aria-label="Up"
            title="Up"
          >
            <ChevronUp size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={!listing || busy}
            onClick={() => listing && void load(listing.path)}
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'max-md:w-full',
              showHidden && 'border-primary text-foreground',
            )}
            disabled={busy}
            onClick={toggleHidden}
            aria-pressed={showHidden}
          >
            {showHidden ? <Eye size={16} /> : <EyeOff size={16} />}
            Show hidden
          </Button>
          {onScan ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                className="md:ml-auto max-md:w-full"
                disabled={!listing || busy}
                onClick={() => void pickCurrent()}
              >
                <Check size={16} />
                Add this folder
              </Button>
              <Button
                size="sm"
                className="max-md:w-full"
                disabled={!listing || busy}
                onClick={() => void scanCurrent()}
              >
                <Search size={16} />
                {scanning ? 'Scanning...' : 'Scan for repos here'}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              className="md:ml-auto max-md:w-full"
              disabled={!listing || busy}
              onClick={() => void pickCurrent()}
            >
              <Check size={16} />
              Add this folder
            </Button>
          )}
        </div>
        {error && (
          <div className="border-b border-border px-3.5 py-2 text-xs text-destructive">{error}</div>
        )}
        <div className="min-h-[180px] flex-1 overflow-y-auto p-1.5" aria-busy={loading}>
          {loading && <div className="p-3 text-xs text-muted-foreground/70">Loading directories...</div>}
          {!loading && listing?.entries.length === 0 && (
            <div className="p-3 text-xs text-muted-foreground/70">No directories.</div>
          )}
          {!loading &&
            listing?.entries.map((entry) => (
              <Button
                variant="ghost"
                size="default"
                className="h-auto w-full justify-start gap-2.5 px-2 py-2 text-left font-normal text-foreground"
                key={entry.path}
                onClick={() => void load(entry.path)}
                disabled={busy}
              >
                <Folder size={16} />
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  {entry.name}
                </span>
              </Button>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
