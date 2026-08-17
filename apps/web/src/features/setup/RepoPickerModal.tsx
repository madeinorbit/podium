import { asMachineId, type MachineWire, type MachineId } from '@podium/model/browser'
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
  const [browserPath, setBrowserPath] = useState('')
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
        setBrowserPath(next.path)
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
    setBrowserPath('')
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
      <DialogContent className="flex max-h-[calc(100dvh-48px)] w-full max-w-[calc(100%-24px)] flex-col gap-0 overflow-hidden rounded-[14px] border-0 bg-[#22262d] p-0 text-[#f2f3f5] shadow-[0_30px_70px_-20px_rgba(0,0,0,.75),inset_0_0_0_1px_#2f343d] sm:max-w-[1100px] [&>button]:right-6 [&>button]:top-[22px] [&>button]:size-7 [&>button]:rounded-lg [&>button]:text-[#9ba1ab]">
        {resultPanel ? (
          resultPanel
        ) : (
          <>
            <DialogHeader className="gap-[7px] px-6 pt-[22px] pr-16 pb-[18px]">
              <DialogTitle className="text-[21px] leading-[1.15] font-semibold tracking-[-0.015em] text-[#f2f3f5]">
                {onScan ? 'Find a repository' : 'Add a repository'}
              </DialogTitle>
              <p className="text-[13.5px] leading-[1.5] text-[#9ba1ab]">
                Choose a repository already on this machine, or bring one in from GitHub.
              </p>
            </DialogHeader>

            {onCloneGithub && (
              <fieldset className="grid gap-3.5 border-t border-[#2b2f37] px-6 pb-4 sm:grid-cols-2">
                <legend className="col-span-full w-full pt-3.5 pb-[11px] font-mono text-[10px] leading-none font-semibold tracking-[0.2em] text-[#8a9099] uppercase">
                  Where from?
                </legend>
                <button
                  type="button"
                  data-pressable
                  aria-pressed={source === 'local'}
                  className={cn(
                    'flex min-h-[70px] items-center gap-3.5 rounded-[11px] px-4 py-[15px] text-left transition-colors',
                    source === 'local'
                      ? 'bg-[#2a2718] text-[#e3ba52] shadow-[inset_0_0_0_1.5px_#e3ba52]'
                      : 'bg-[#1b1e24] text-[#8a9099] shadow-[inset_0_0_0_1px_#2f343d] hover:bg-[#252a31]',
                  )}
                  onClick={() => {
                    setSource('local')
                    onProgress?.({ source: 'local' })
                  }}
                >
                  <HardDrive size={21} className="flex-none" aria-hidden="true" />
                  <span>
                    <span className="block text-[14.5px] leading-none font-semibold text-[#f2f3f5]">
                      On this machine
                    </span>
                    <span
                      className={cn(
                        'mt-1 block text-[12.5px] leading-[1.4]',
                        source === 'local' ? 'text-[#b9bec6]' : 'text-[#9ba1ab]',
                      )}
                    >
                      Browse folders already on its disk
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  data-pressable
                  aria-pressed={source === 'github'}
                  className={cn(
                    'flex min-h-[70px] items-center gap-3.5 rounded-[11px] px-4 py-[15px] text-left transition-colors',
                    source === 'github'
                      ? 'bg-[#2a2718] text-[#e3ba52] shadow-[inset_0_0_0_1.5px_#e3ba52]'
                      : 'bg-[#1b1e24] text-[#8a9099] shadow-[inset_0_0_0_1px_#2f343d] hover:bg-[#252a31]',
                  )}
                  onClick={() => {
                    setSource('github')
                    onProgress?.({ source: 'github' })
                  }}
                >
                  <GitFork size={21} className="flex-none" aria-hidden="true" />
                  <span>
                    <span className="block text-[14.5px] leading-none font-semibold text-[#f2f3f5]">
                      From GitHub
                    </span>
                    <span
                      className={cn(
                        'mt-1 block text-[12.5px] leading-[1.4]',
                        source === 'github' ? 'text-[#b9bec6]' : 'text-[#9ba1ab]',
                      )}
                    >
                      Sign in, choose a repository, then clone it
                    </span>
                  </span>
                </button>
              </fieldset>
            )}

            {(source === 'local' || showMachinePicker) && (
              <div className="flex min-h-16 flex-wrap items-center gap-3 border-t border-[#2b2f37] bg-[#1f2329] px-6 py-3.5">
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
                    <div className="flex flex-none items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-[30px] border-0 rounded-lg"
                        disabled={historyIndex <= 0 || busy}
                        onClick={() => visitHistory(historyIndex - 1)}
                        aria-label="Back"
                        title="Back"
                      >
                        <ChevronLeft size={18} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-[30px] border-0 rounded-lg"
                        disabled={historyIndex < 0 || historyIndex >= history.length - 1 || busy}
                        onClick={() => visitHistory(historyIndex + 1)}
                        aria-label="Forward"
                        title="Forward"
                      >
                        <ChevronRight size={18} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-[30px] border-0 rounded-lg"
                        disabled={!listing || busy}
                        onClick={() => listing && void load(listing.homePath)}
                        aria-label="Home"
                        title="Home"
                      >
                        <Home size={17} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-[30px] border-0 rounded-lg"
                        disabled={!listing || busy}
                        onClick={() => listing && void load(listing.path, undefined, 'preserve')}
                        aria-label="Refresh"
                        title="Refresh"
                      >
                        <RefreshCw size={17} />
                      </Button>
                    </div>
                    <Input
                      aria-label="Folder path"
                      className="h-9 min-w-0 flex-1 rounded-[9px] border-0 bg-[#15171b] px-[13px] font-mono text-[13px] text-[#e6e8ec] shadow-[inset_0_0_0_1px_#2f343d]"
                      value={machineReady ? browserPath : headerPath}
                      disabled={!machineReady || busy}
                      onChange={(event) => setBrowserPath(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void load(browserPath)
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        'h-9 rounded-[9px] border-0 px-[13px] text-[12.5px] font-semibold text-[#a8adb6] shadow-[inset_0_0_0_1px_#333842]',
                        showHidden && 'text-[#f2f3f5] shadow-[inset_0_0_0_1px_#454b56]',
                      )}
                      disabled={!machineReady || busy}
                      onClick={toggleHidden}
                      aria-pressed={showHidden}
                    >
                      {showHidden ? <Eye size={16} /> : <EyeOff size={16} />}
                      Hidden
                    </Button>
                    {onScan && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 rounded-[9px] border-0 px-[15px] text-[12.5px] font-semibold text-[#f2f3f5] shadow-[inset_0_0_0_1px_#454b56]"
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
              <div className="border-t border-[#2b2f37] px-6 py-3">
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
              <div
                className="min-h-[260px] flex-1 overflow-y-auto overscroll-contain"
                aria-busy={loading}
              >
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
                    className="flex min-h-[46px] w-full items-center gap-[13px] border-t border-[#272b33] px-6 py-[13px] text-left disabled:pointer-events-none disabled:opacity-50"
                    onClick={() => void load(listing.parentPath ?? undefined)}
                    disabled={busy}
                    aria-label={`Open parent folder ${listing.parentPath}`}
                  >
                    <Folder size={19} className="flex-none text-[#8a9099]" aria-hidden="true" />
                    <span className="font-mono text-[13px] text-[#8a9099]">..</span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-[#9ba1ab]">
                      {listing.parentPath}
                    </span>
                  </button>
                )}
                {machineReady &&
                  !loading &&
                  listing?.entries.map((entry) => (
                    <div
                      className="group flex min-h-[46px] items-center gap-[13px] border-t border-[#272b33] px-6 hover:bg-[#252a31]"
                      key={entry.path}
                    >
                      <button
                        type="button"
                        data-pressable
                        className="flex min-w-0 flex-1 items-center gap-[13px] py-[11px] text-left disabled:pointer-events-none disabled:opacity-50"
                        onClick={() => void load(entry.path)}
                        disabled={busy}
                        aria-label={`Open folder ${entry.name}`}
                      >
                        {entry.isRepo ? (
                          <FolderGit2
                            size={19}
                            className="flex-none text-[#e3ba52]"
                            aria-hidden="true"
                          />
                        ) : (
                          <Folder
                            size={19}
                            className="flex-none text-[#8a9099]"
                            aria-hidden="true"
                          />
                        )}
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-[14px]',
                            entry.isRepo ? 'font-semibold text-[#f2f3f5]' : 'text-[#e6e8ec]',
                          )}
                        >
                          {entry.name}
                        </span>
                        <ChevronRight
                          size={18}
                          className="flex-none text-[#6f757f]"
                          aria-hidden="true"
                        />
                      </button>
                      {entry.isRepo && (
                        <button
                          type="button"
                          data-pressable
                          className="h-8 w-[132px] flex-none rounded-[9px] text-[12.5px] leading-none font-semibold text-[#f2f3f5] shadow-[inset_0_0_0_1px_#454b56] group-hover:bg-[#e3ba52] group-hover:text-[#1a1408] group-hover:shadow-none"
                          disabled={busy}
                          onClick={() => void pickPath(entry.path)}
                          aria-label={`Use repository ${entry.name}`}
                        >
                          Use repository
                        </button>
                      )}
                    </div>
                  ))}
              </div>
              <div className="border-t border-[#2b2f37] bg-[#1f2329] px-6 pt-[18px] pb-[22px]">
                <p className="text-[12.5px] leading-none font-semibold text-[#a8adb6]">
                  Or use a repository path
                </p>
                <div className="mt-[11px] flex gap-3 max-sm:flex-col">
                  <Input
                    id="repo-machine-path"
                    aria-label={machinePathLabel}
                    className="h-[38px] rounded-[9px] border-0 bg-[#15171b] px-[13px] font-mono text-[13px] text-[#e6e8ec] shadow-[inset_0_0_0_1px_#2f343d] placeholder:text-[#6f757f]"
                    value={manualPath}
                    placeholder="/home/user/project"
                    disabled={writing || !machineReady}
                    onChange={(e) => setManualPath(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void pickManual()
                    }}
                  />
                  <Button
                    className="h-[38px] rounded-[9px] border-0 bg-[#e3ba52] px-[15px] text-[12.5px] font-semibold text-[#1a1408] disabled:bg-transparent disabled:text-[#5f656e] disabled:shadow-[inset_0_0_0_1px_#2b2f37] max-sm:w-full"
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
                    : `Podium is registering ${listing?.path ?? manualPath.trim()} and preparing the project list.`
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
