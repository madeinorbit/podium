import { repoNameFromOrigin } from '@podium/domain'
import type { MachineWire } from '@podium/protocol'
import {
  Check,
  ChevronUp,
  Eye,
  EyeOff,
  Folder,
  FolderGit2,
  Home,
  RefreshCw,
  Search,
} from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
  /** This subfolder is itself a git repo — badged with a distinct icon (POD-855). */
  isRepo?: boolean
}

type DirectoryListing = {
  path: string
  homePath: string
  parentPath: string | null
  entries: DirectoryEntry[]
  /** The browsed folder itself is a git repo — gates the "Add repo" button. */
  isRepo?: boolean
  /** The browsed repo's origin, used to name the add target. */
  originUrl?: string
}

type RepoPickerMachine = Pick<MachineWire, 'id' | 'name' | 'hostname' | 'online'>

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/**
 * Pick a repo on a machine (POD-814/POD-855) [spec:SP-5eb6]: choose a machine,
 * browse ITS directories (through its daemon), and either add the folder you're
 * standing in — but only when it is a git repo — or scan for repos from here.
 *
 * The browser is git-aware: repo subfolders are badged, and the folder you're in
 * carries its own repo identity so "Add" is a strict "Add repo '{name}'", disabled
 * on a non-repo. Adding a bare directory is deliberately not offered — finding
 * repos nested below is the scan's job.
 */
export function RepoPickerModal({
  onClose,
  onPick,
  onScan,
  intro,
  machines = [],
  selectedMachineId,
  onMachineChange,
}: {
  onClose: () => void
  /** Add the browsed folder as a repo (only reachable when it IS a repo). */
  onPick: (path: string) => Promise<void>
  /** Scan from the browsed folder (plus this machine's known repo locations) and
   *  hand the parent the ranked, grouped candidates. */
  onScan?: (path: string) => Promise<void>
  /** Optional header content (used by the onboarding wizard for a welcome line). */
  intro?: ReactNode
  /** Machines that can own a repo. Offline ones are listed but not selectable. */
  machines?: RepoPickerMachine[]
  /** The machine every action targets; the parent defaults it (see RepoScanFlow). */
  selectedMachineId?: string
  onMachineChange?: (machineId: string | undefined) => void
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
  /** A KNOWN, online machine is picked — every action here needs one. */
  const machineReady = selectedMachine?.online === true
  const machinePathLabel = `Repo path on ${selectedMachine?.name ?? selectedMachineId ?? 'machine'}`
  const headerPath = !selectedMachine
    ? 'No machine selected'
    : selectedMachine.online
      ? (listing?.path ?? 'Loading...')
      : `${selectedMachine.name} is offline`

  // The add target: the browsed folder, but ONLY when it is a git repo (strict —
  // POD-855). Named by origin, falling back to the folder name.
  const addRepoName =
    listing?.isRepo === true
      ? (repoNameFromOrigin(listing.originUrl) ?? basename(listing.path))
      : null

  // Read through a ref so `load`'s identity tracks the MACHINE only: toggling
  // hidden re-lists the folder you are standing in instead of bouncing to home.
  const showHiddenRef = useRef(showHidden)
  showHiddenRef.current = showHidden

  const load = useCallback(
    async (path?: string, includeHidden?: boolean) => {
      if (!selectedMachineId) return
      setLoading(true)
      setError(null)
      try {
        setListing(
          await trpc.repos.browse.query({
            ...(path ? { path } : {}),
            includeHidden: includeHidden ?? showHiddenRef.current,
            machineId: selectedMachineId,
          }),
        )
      } catch (e) {
        setListing(null)
        setError(browseError(e, selectedMachine?.name))
      } finally {
        setLoading(false)
      }
    },
    [trpc, selectedMachineId, selectedMachine?.name],
  )

  // Land on the selected machine's home. Re-homes on every machine change: a path
  // from one machine's disk means nothing on another's.
  useEffect(() => {
    setListing(null)
    if (machineReady) void load()
  }, [load, machineReady])

  function toggleHidden(): void {
    const next = !showHidden
    setShowHidden(next)
    void load(listing?.path, next)
  }

  // `busy` gates actions needing the CURRENT LISTING (navigate, add, scan here);
  // `writing` gates the typed-path fallback, which stands on its own so an in-flight
  // listing (a read) never blocks it — that's exactly when you reach for it.
  const busy = loading || saving || scanning
  const writing = saving || scanning

  async function pickCurrent(): Promise<void> {
    if (!listing?.isRepo) return
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
      {/* sm:max-w-* overrides DialogContent's base sm:max-w-sm; a plain max-w loses
          to it at desktop width and pins the modal to 384px (POD-832). */}
      <DialogContent className="flex max-h-[min(760px,calc(100dvh-2rem))] w-full max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[900px]">
        <DialogHeader className="gap-0 border-b border-border px-3.5 pt-3.5 pb-2.5 pr-10">
          <DialogTitle className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            {onScan ? 'Find repositories' : 'Add repo'}
          </DialogTitle>
          {intro && (
            <div className="mb-1 mt-0.5 max-w-[54ch] text-[13px] text-foreground">{intro}</div>
          )}
          <div className="mt-1 flex items-center gap-1.5 break-words text-[13px] font-medium text-foreground">
            {listing?.isRepo && <FolderGit2 size={14} className="flex-none text-primary" />}
            <span className="min-w-0 break-all">{headerPath}</span>
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
                {machines.map((machine) => (
                  <option key={machine.id} value={machine.id} disabled={!machine.online}>
                    {machine.name}
                    {machine.online ? '' : ' (offline)'}
                  </option>
                ))}
              </select>
            </div>
          )}
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
            disabled={!machineReady || busy}
            onClick={toggleHidden}
            aria-pressed={showHidden}
          >
            {showHidden ? <Eye size={16} /> : <EyeOff size={16} />}
            Show hidden
          </Button>
          <Button
            variant={onScan ? 'secondary' : 'default'}
            size="sm"
            className="md:ml-auto max-md:w-full"
            disabled={!addRepoName || busy}
            onClick={() => void pickCurrent()}
            title={
              addRepoName
                ? `Add ${addRepoName} as a repo`
                : 'This folder is not a git repository — open a repo folder or scan for repos'
            }
          >
            <Check size={16} />
            {addRepoName ? `Add repo '${addRepoName}'` : 'Add repo'}
          </Button>
          {onScan && (
            <Button
              size="sm"
              className="max-md:w-full"
              disabled={!listing || busy}
              onClick={() => void scanCurrent()}
            >
              <Search size={16} />
              {scanning ? 'Scanning...' : 'Scan for repos'}
            </Button>
          )}
        </div>
        {error && (
          <div className="border-b border-border px-3.5 py-2 text-xs text-destructive">{error}</div>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-[160px] flex-1 overflow-y-auto p-1.5" aria-busy={loading}>
            {!selectedMachine && (
              <div className="p-3 text-xs text-muted-foreground/70">
                No machines are connected. Pair a machine to add repos.
              </div>
            )}
            {selectedMachine && !selectedMachine.online && (
              <div className="p-3 text-xs text-muted-foreground/70">
                {selectedMachine.name} is offline — its folders can't be browsed right now.
              </div>
            )}
            {machineReady && loading && (
              <div className="p-3 text-xs text-muted-foreground/70">Loading directories...</div>
            )}
            {machineReady && !loading && listing?.entries.length === 0 && (
              <div className="p-3 text-xs text-muted-foreground/70">No directories.</div>
            )}
            {machineReady &&
              !loading &&
              listing?.entries.map((entry) => (
                <Button
                  variant="ghost"
                  size="default"
                  className="h-auto w-full justify-start gap-2.5 px-2 py-2 text-left font-normal text-foreground"
                  key={entry.path}
                  onClick={() => void load(entry.path)}
                  disabled={busy}
                >
                  {entry.isRepo ? (
                    <FolderGit2 size={16} className="flex-none text-primary" />
                  ) : (
                    <Folder size={16} className="flex-none text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                    {entry.name}
                  </span>
                  {entry.isRepo && (
                    <span className="flex-none rounded border border-primary/40 px-1.5 text-[10px] text-primary">
                      repo
                    </span>
                  )}
                </Button>
              ))}
          </div>
          <div className="flex flex-col gap-1.5 border-t border-border px-3.5 py-2.5">
            <label htmlFor="repo-machine-path" className="text-[11px] text-muted-foreground/70">
              Or add a repo path directly on {selectedMachine?.name ?? 'the machine'}
            </label>
            <div className="flex gap-2 max-sm:flex-col">
              <Input
                id="repo-machine-path"
                aria-label={machinePathLabel}
                className="h-7 text-[12px]"
                value={manualPath}
                placeholder="/home/user/project"
                disabled={writing || !machineReady}
                onChange={(e) => setManualPath(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void pickManual()
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="max-sm:w-full"
                disabled={writing || !machineReady || manualPath.trim() === ''}
                onClick={() => void pickManual()}
              >
                <Check size={16} />
                Add
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** A browse failure on a machine whose daemon predates the browse feature reads as
 *  a generic timeout; name the likely cause so it points at "update this machine"
 *  (POD-855) rather than a dead end. */
function browseError(e: unknown, machineName?: string): string {
  const msg = formatAppError(e, 'Could not open directory')
  if (/tim(ed|e) ?out/i.test(msg)) {
    return `${machineName ?? 'This machine'} didn't respond — its Podium may be out of date. Update it, or type a repo path below.`
  }
  return msg
}
