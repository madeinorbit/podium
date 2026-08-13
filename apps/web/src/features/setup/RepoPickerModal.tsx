import { asMachineId, type MachineWire, repoNameFromOrigin, type MachineId } from '@podium/model/browser'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderGit2,
  GitFork,
  HardDrive,
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
import { GitHubProjectIntake } from './GitHubProjectIntake'
import { SetupBusyOverlay, SetupError } from './SetupFeedback'

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

type RepoPickerMachine = Pick<MachineWire, 'id' | 'name' | 'hostname' | 'online' | 'inventory'>

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
  onCloneGithub,
  initialSource = 'local',
  initialPath,
  onProgress,
  resultPanel,
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
  /** Clone through this machine's existing GitHub CLI login, then register it. */
  onCloneGithub?: (repository: string, destination: string) => Promise<void>
  /** Local is the predictable default; GitHub is an explicit alternative source. */
  initialSource?: 'github' | 'local'
  /** Restored onboarding folder on the selected machine. */
  initialPath?: string
  /** Device-local progress sink used by first-run activation. */
  onProgress?: (progress: { browsePath?: string; source?: 'github' | 'local' }) => void
  /** Scan results replace the body inside this same dialog instead of opening a second dialog. */
  resultPanel?: ReactNode
  /** Machines that can own a repo. Offline ones are listed but not selectable. */
  machines?: RepoPickerMachine[]
  /** The machine every action targets; the parent defaults it (see RepoScanFlow). */
  selectedMachineId?: MachineId
  onMachineChange?: (machineId: MachineId | undefined) => void
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
  const [source, setSource] = useState<'github' | 'local'>(initialSource)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const restoredPath = useRef({ machineId: selectedMachineId, path: initialPath })

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
    async (
      path?: string,
      includeHidden?: boolean,
      historyMode: 'push' | 'replace' | 'preserve' = 'push',
    ) => {
      if (!selectedMachineId) return false
      setLoading(true)
      setError(null)
      try {
        const next = await trpc.repos.browse.query({
          ...(path ? { path } : {}),
          includeHidden: includeHidden ?? showHiddenRef.current,
          machineId: selectedMachineId,
        })
        setListing(next)
        if (historyMode === 'replace') {
          historyRef.current = [next.path]
          historyIndexRef.current = 0
          setHistory([next.path])
          setHistoryIndex(0)
        } else if (historyMode === 'push') {
          const current = historyRef.current[historyIndexRef.current]
          if (current !== next.path) {
            const paths = [...historyRef.current.slice(0, historyIndexRef.current + 1), next.path]
            historyRef.current = paths
            historyIndexRef.current = paths.length - 1
            setHistory(paths)
            setHistoryIndex(paths.length - 1)
          }
        }
        onProgress?.({ browsePath: next.path })
        return true
      } catch (e) {
        setListing(null)
        setError(browseError(e, selectedMachine?.name))
        return false
      } finally {
        setLoading(false)
      }
    },
    [trpc, selectedMachineId, selectedMachine?.name, onProgress],
  )

  // Land on the selected machine's home. Re-homes on every machine change: a path
  // from one machine's disk means nothing on another's.
  useEffect(() => {
    setListing(null)
    historyRef.current = []
    historyIndexRef.current = -1
    setHistory([])
    setHistoryIndex(-1)
    if (machineReady) {
      const path =
        restoredPath.current.machineId === selectedMachineId ? restoredPath.current.path : undefined
      restoredPath.current = { machineId: selectedMachineId, path: undefined }
      void load(path, undefined, 'replace')
    }
  }, [load, machineReady, selectedMachineId])

  function toggleHidden(): void {
    const next = !showHidden
    setShowHidden(next)
    void load(listing?.path, next, 'preserve')
  }

  // `busy` gates actions needing the CURRENT LISTING (navigate, add, scan here);
  // `writing` gates the typed-path fallback, which stands on its own so an in-flight
  // listing (a read) never blocks it — that's exactly when you reach for it.
  const busy = loading || saving || scanning
  const writing = saving || scanning

  async function pickPath(path: string): Promise<void> {
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

  async function pickCurrent(): Promise<void> {
    if (!listing?.isRepo) return
    await pickPath(listing.path)
  }

  function visitHistory(nextIndex: number): void {
    const path = history[nextIndex]
    if (!path) return
    void load(path, undefined, 'preserve').then((loaded) => {
      if (!loaded) return
      historyIndexRef.current = nextIndex
      setHistoryIndex(nextIndex)
    })
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
      await onScan(listing.path)
    } catch (e) {
      setError(formatAppError(e, 'Could not scan folder'))
    } finally {
      setScanning(false)
    }
  }

  const showMachinePicker = onMachineChange !== undefined && machines.length > 1

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
        {resultPanel ? (
          resultPanel
        ) : (
          <>
            <DialogHeader className="gap-1 border-b border-border px-4 py-4 pr-10">
              <DialogTitle className="text-base font-semibold text-foreground">
                {onScan ? 'Find a repository' : 'Add a repository'}
              </DialogTitle>
              <p className="text-sm text-muted-foreground">
                Choose a repository already on this machine, or bring one in from GitHub.
              </p>
            </DialogHeader>

            {onCloneGithub && (
              <fieldset className="grid gap-2 border-b border-border p-4 sm:grid-cols-2">
                <legend className="col-span-full mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Where from?
                </legend>
                <button
                  type="button"
                  data-pressable
                  aria-pressed={source === 'local'}
                  className={cn(
                    'flex min-h-16 items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors',
                    source === 'local'
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  )}
                  onClick={() => {
                    setSource('local')
                    onProgress?.({ source: 'local' })
                  }}
                >
                  <HardDrive size={18} className="flex-none" aria-hidden="true" />
                  <span>
                    <span className="block text-sm font-semibold">On this machine</span>
                    <span className="block text-xs">Browse folders already on its disk</span>
                  </span>
                </button>
                <button
                  type="button"
                  data-pressable
                  aria-pressed={source === 'github'}
                  className={cn(
                    'flex min-h-16 items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors',
                    source === 'github'
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  )}
                  onClick={() => {
                    setSource('github')
                    onProgress?.({ source: 'github' })
                  }}
                >
                  <GitFork size={18} className="flex-none" aria-hidden="true" />
                  <span>
                    <span className="block text-sm font-semibold">From GitHub</span>
                    <span className="block text-xs">
                      Sign in, choose a repository, then clone it
                    </span>
                  </span>
                </button>
              </fieldset>
            )}

            {(source === 'local' || showMachinePicker) && (
              <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-border-strong px-4 py-2">
                {showMachinePicker ? (
                  <div className="flex min-w-48 flex-col gap-1 max-md:w-full">
                    <label htmlFor="repo-machine-select" className="text-xs text-muted-foreground">
                      Machine
                    </label>
                    <select
                      id="repo-machine-select"
                      aria-label="Machine"
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
                      value={selectedMachineId ?? ''}
                      disabled={busy}
                      onChange={(e) => {
                        setError(null)
                        onMachineChange(
                          e.currentTarget.value ? asMachineId(e.currentTarget.value) : undefined,
                        )
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
                ) : null}
                {source === 'local' && (
                  <>
                    <div className="flex h-8 flex-none items-center gap-0.5 rounded-md border border-border bg-muted/20 p-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={historyIndex <= 0 || busy}
                        onClick={() => visitHistory(historyIndex - 1)}
                        aria-label="Back"
                        title="Back"
                      >
                        <ChevronLeft size={16} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={historyIndex < 0 || historyIndex >= history.length - 1 || busy}
                        onClick={() => visitHistory(historyIndex + 1)}
                        aria-label="Forward"
                        title="Forward"
                      >
                        <ChevronRight size={16} />
                      </Button>
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
                        disabled={!listing || busy}
                        onClick={() => listing && void load(listing.path, undefined, 'preserve')}
                        aria-label="Refresh"
                        title="Refresh"
                      >
                        <RefreshCw size={16} />
                      </Button>
                    </div>
                    <span
                      className="flex h-8 min-w-0 flex-1 items-center truncate rounded-md border border-border bg-background px-2.5 font-mono text-xs text-foreground"
                      title={headerPath}
                    >
                      {headerPath}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className={cn(showHidden && 'border-primary text-foreground')}
                      disabled={!machineReady || busy}
                      onClick={toggleHidden}
                      aria-pressed={showHidden}
                    >
                      {showHidden ? <Eye size={16} /> : <EyeOff size={16} />}
                      Hidden
                    </Button>
                    {onScan && (
                      <Button
                        size="sm"
                        disabled={!listing || busy}
                        onClick={() => void scanCurrent()}
                      >
                        <Search size={16} />
                        {scanning ? 'Scanning…' : 'Scan this folder'}
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}
            {source === 'local' && error && (
              <div className="border-b border-border-strong px-4 py-3">
                <SetupError>{error}</SetupError>
              </div>
            )}
            {source === 'github' && onCloneGithub && (
              <GitHubProjectIntake
                machine={selectedMachine}
                homePath={listing?.homePath}
                onClone={async (repository, destination) => {
                  await onCloneGithub(repository, destination)
                  onClose()
                }}
              />
            )}
            <div hidden={source === 'github'} className="flex min-h-0 flex-1 flex-col">
              {addRepoName && (
                <div className="flex items-center justify-between gap-3 border-b border-border-strong bg-primary/[0.06] px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{addRepoName}</p>
                    <p className="text-xs text-muted-foreground">
                      The current folder is a Git repository.
                    </p>
                  </div>
                  <Button size="sm" disabled={busy} onClick={() => void pickCurrent()}>
                    <Check size={16} /> Use repository
                  </Button>
                </div>
              )}
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
                {machineReady && !loading && listing?.parentPath && (
                  <button
                    type="button"
                    data-pressable
                    className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm text-foreground hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-50"
                    onClick={() => void load(listing.parentPath ?? undefined)}
                    disabled={busy}
                    aria-label={`Open parent folder ${listing.parentPath}`}
                  >
                    <Folder
                      size={16}
                      className="flex-none text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="font-mono font-medium">..</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {listing.parentPath}
                    </span>
                  </button>
                )}
                {machineReady &&
                  !loading &&
                  listing?.entries.map((entry) => (
                    <div
                      className="group flex min-h-11 items-center gap-2 rounded-md px-1 hover:bg-muted/60"
                      key={entry.path}
                    >
                      <button
                        type="button"
                        data-pressable
                        className="flex min-w-0 flex-1 items-center gap-2.5 px-1 py-2 text-left text-sm text-foreground disabled:pointer-events-none disabled:opacity-50"
                        onClick={() => void load(entry.path)}
                        disabled={busy}
                        aria-label={`Open folder ${entry.name}`}
                      >
                        {entry.isRepo ? (
                          <FolderGit2
                            size={16}
                            className="flex-none text-primary"
                            aria-hidden="true"
                          />
                        ) : (
                          <Folder
                            size={16}
                            className="flex-none text-muted-foreground"
                            aria-hidden="true"
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                        <ChevronRight
                          size={15}
                          className="flex-none text-muted-foreground/60"
                          aria-hidden="true"
                        />
                      </button>
                      {entry.isRepo && (
                        <Button
                          size="sm"
                          className="mr-1 flex-none"
                          disabled={busy}
                          onClick={() => void pickPath(entry.path)}
                          aria-label={`Use repository ${entry.name}`}
                        >
                          Use repository
                        </Button>
                      )}
                    </div>
                  ))}
              </div>
              <div className="border-t-2 border-border-strong bg-muted/[0.12] px-4 pt-4 pb-5">
                <div className="mb-3 flex items-center gap-3">
                  <span className="text-xs font-semibold text-foreground">
                    Or use a repository path
                  </span>
                  <span className="h-px flex-1 bg-border-strong" aria-hidden="true" />
                </div>
                <div className="flex gap-2 max-sm:flex-col">
                  <Input
                    id="repo-machine-path"
                    aria-label={machinePathLabel}
                    className="h-8 text-sm"
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
                    Use repository
                  </Button>
                </div>
              </div>
            </div>
            {(saving || scanning) && (
              <SetupBusyOverlay
                title={scanning ? 'Looking for repositories…' : 'Using this repository…'}
                detail={
                  scanning
                    ? 'Podium is scanning this folder and will update this dialog when it finishes.'
                    : 'Podium is registering the repository and preparing the project list.'
                }
              />
            )}
          </>
        )}
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
