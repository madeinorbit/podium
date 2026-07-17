import type { MachineWire } from '@podium/protocol'
import { Check, ChevronUp, Eye, EyeOff, Folder, Home, RefreshCw, Search } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { formatAppError } from '@/app/AppErrorPage'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { cn } from '@/lib/utils'

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

type RepoPickerMachine = Pick<MachineWire, 'id' | 'name' | 'hostname' | 'online'>

export function RepoPickerModal({
  onClose,
  onPick,
  onScan,
  intro,
  machines = [],
  selectedMachineId,
  onMachineChange,
  onScanMachine,
  lastMachineScan,
}: {
  onClose: () => void
  /** Add exactly the browsed folder as a repo (for when you know the path). */
  onPick: (path: string) => Promise<void>
  /** Scan the browsed folder for repos and hand the parent the ranked candidates. */
  onScan?: (path: string) => Promise<void>
  /** Optional header content (used by the onboarding wizard for a welcome line). */
  intro?: ReactNode
  /** Connected machines that can own a manually entered repo path. */
  machines?: RepoPickerMachine[]
  selectedMachineId?: string
  onMachineChange?: (machineId: string | undefined) => void
  /** Tiered scan of the selected machine (POD-787). The parent transitions to the
   *  results view on success and unmounts this modal. */
  onScanMachine?: (machineId: string) => Promise<void>
  /** Summary of the machine's most recent scan, shown as a shortcut. */
  lastMachineScan?: { count: number; view: () => void } | null
}): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const isMobile = useIsMobile()
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [manualPath, setManualPath] = useState('')
  const [error, setError] = useState<string | null>(null)

  const selectedMachine = selectedMachineId
    ? machines.find((machine) => machine.id === selectedMachineId)
    : undefined
  const manualPathMode = selectedMachineId !== undefined
  const machinePathLabel = `Repo path on ${selectedMachine?.name ?? selectedMachineId ?? 'machine'}`
  const headerPath = manualPathMode
    ? (selectedMachine?.name ?? selectedMachineId ?? 'Machine')
    : (listing?.path ?? 'Loading...')

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
    if (!manualPathMode) void load()
  }, [load, manualPathMode])

  function toggleHidden(): void {
    const next = !showHidden
    setShowHidden(next)
    void load(listing?.path, next)
  }

  const [machineScanning, setMachineScanning] = useState(false)
  const busy = manualPathMode ? saving || machineScanning : loading || saving || scanning

  async function scanSelectedMachine(): Promise<void> {
    if (!selectedMachineId || !onScanMachine) return
    setMachineScanning(true)
    setError(null)
    try {
      // The parent transitions to the results view on success and unmounts this modal.
      await onScanMachine(selectedMachineId)
    } catch (e) {
      setError(formatAppError(e, 'Could not scan machine'))
      setMachineScanning(false)
    }
  }

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

  async function pickManual(): Promise<void> {
    const path = manualPath.trim()
    if (!selectedMachine) {
      setError('Choose an online machine')
      return
    }
    if (!selectedMachine.online) {
      setError(`${selectedMachine.name} is offline`)
      return
    }
    if (!path) {
      setError('Enter an absolute repo path')
      return
    }
    if (!path.startsWith('/')) {
      setError('Repo path must be absolute')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onPick(path)
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

  const showMachinePicker = onMachineChange !== undefined && machines.length > 0

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
            {manualPathMode ? 'Add repo' : onScan ? 'Find repositories' : 'Add repo'}
          </DialogTitle>
          {intro && (
            <div className="mb-1 mt-0.5 max-w-[54ch] text-[13px] text-foreground">{intro}</div>
          )}
          <div className="mt-1 break-words text-[13px] font-medium text-foreground">
            {headerPath}
          </div>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-2 border-b border-border px-3.5 py-2.5">
          {showMachinePicker && (
            <div className="flex min-w-[180px] flex-col gap-1 max-md:w-full">
              <label
                htmlFor="repo-machine-select"
                className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground/70"
              >
                Machine
              </label>
              <select
                id="repo-machine-select"
                aria-label="Machine"
                className="h-7 rounded-md border border-input bg-background px-2 text-[12px] text-foreground outline-none focus:border-primary"
                value={selectedMachineId ?? ''}
                disabled={busy}
                onChange={(e) => {
                  setError(null)
                  onMachineChange(e.currentTarget.value || undefined)
                }}
              >
                <option value="">This machine</option>
                {machines.map((machine) => (
                  <option key={machine.id} value={machine.id} disabled={!machine.online}>
                    {machine.name}
                    {machine.online ? '' : ' (offline)'}
                  </option>
                ))}
              </select>
            </div>
          )}
          {!manualPathMode && (
            <>
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
                className={cn('max-md:w-full', showHidden && 'border-primary text-foreground')}
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
            </>
          )}
        </div>
        {error && (
          <div className="border-b border-border px-3.5 py-2 text-xs text-destructive">{error}</div>
        )}
        {manualPathMode ? (
          <div className="flex min-h-[180px] flex-1 flex-col gap-4 p-3.5">
            {onScanMachine && selectedMachine?.online !== false && (
              <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                <div className="text-[13px] font-medium text-foreground">
                  Scan {selectedMachine?.name ?? 'machine'} for repositories
                </div>
                <p className="max-w-[52ch] text-[12px] text-muted-foreground">
                  Checks the paths of repos known from your other machines first, then sweeps
                  the home folder for git repositories. Repos that match one already in Podium
                  are added automatically; the rest are offered for selection.
                </p>
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void scanSelectedMachine()}
                    className="max-md:w-full"
                  >
                    <Search size={16} />
                    {machineScanning ? 'Scanning…' : 'Scan for repos'}
                  </Button>
                  {lastMachineScan && lastMachineScan.count > 0 && !machineScanning && (
                    <button
                      type="button"
                      className="text-[12px] text-muted-foreground underline-offset-2 hover:underline"
                      onClick={lastMachineScan.view}
                    >
                      Last scan found {lastMachineScan.count} — view
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="repo-machine-path" className="text-xs font-medium text-foreground">
                {onScanMachine ? `Or add a path directly on ${selectedMachine?.name ?? 'the machine'}` : machinePathLabel}
              </label>
              <div className="flex gap-2 max-sm:flex-col">
                <Input
                  id="repo-machine-path"
                  aria-label={machinePathLabel}
                  value={manualPath}
                  placeholder="/home/user/project"
                  disabled={busy || selectedMachine?.online === false}
                  onChange={(e) => setManualPath(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void pickManual()
                  }}
                />
                <Button
                  className="max-sm:w-full"
                  disabled={busy || selectedMachine?.online === false || manualPath.trim() === ''}
                  onClick={() => void pickManual()}
                >
                  <Check size={16} />
                  Add repo
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="min-h-[180px] flex-1 overflow-y-auto p-1.5" aria-busy={loading}>
            {loading && (
              <div className="p-3 text-xs text-muted-foreground/70">Loading directories...</div>
            )}
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
        )}
      </DialogContent>
    </Dialog>
  )
}
