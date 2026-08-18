import { asMachineId, type MachineId, type MachineWire } from '@podium/model/browser'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderGit2,
  FolderPlus,
  GitFork,
  HardDrive,
  Home,
  Pencil,
  RefreshCw,
  Search,
} from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
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
  onCreateFolder,
  onCreateRepo,
  onRenameFolder,
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
  /** Create a folder in the browsed directory (POD-1295). Registers nothing —
   *  the dialog stays open and re-lists so the folder is there to step into. */
  onCreateFolder?: (parentPath: string, name: string) => Promise<void>
  /** Create a folder, initialise it as a repository, and register it. Completes
   *  the dialog exactly as picking an existing repo does. */
  onCreateRepo?: (parentPath: string, name: string) => Promise<void>
  /** Rename a folder in the browsed directory. */
  onRenameFolder?: (parentPath: string, currentName: string, name: string) => Promise<void>
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
  // The one row that is being typed into, if any (POD-1295). `kind` says what
  // Enter will do: a brand-new repo, a brand-new plain folder, or a rename of
  // `from`. Only ever one at a time — this is a list, not a form.
  // Three members rather than `kind: 'repo' | 'folder'` in one: a discriminant
  // that is itself a union does not narrow, and `edit.from` stops resolving.
  const [edit, setEdit] = useState<
    | { kind: 'repo'; name: string }
    | { kind: 'folder'; name: string }
    | { kind: 'rename'; from: string; name: string }
    | null
  >(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [writingKind, setWritingKind] = useState<'repo' | 'folder' | 'rename' | null>(null)
  // The right-click menu's position is stored in the DIALOG's coordinate space,
  // not the viewport's — see `openRowMenu`.
  const [rowMenu, setRowMenu] = useState<{ entry: DirectoryEntry; x: number; y: number } | null>(
    null,
  )
  const dialogRef = useRef<HTMLDivElement | null>(null)
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
  const busy = loading || saving || scanning || writingKind !== null
  const writing = saving || scanning || writingKind !== null

  // Standing INSIDE a repo, the per-entry "Use repository" buttons are all below you
  // and the typed-path row was the only way out — empty, so its button was dead
  // (POD-1236). Offer the browsed repo as the field's placeholder: the button acts on
  // it, and anything you type takes over, button state and all.
  const browsedRepoPath = listing?.isRepo === true ? listing.path : null
  const manualTarget = manualPath.trim() || browsedRepoPath || ''

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
    const path = manualTarget
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

  /** Open the one editable row. Anything already being typed is dropped: two
   *  open editors would leave the user guessing which one Enter belongs to. */
  function startEdit(next: NonNullable<typeof edit>): void {
    setEdit(next)
    setEditError(null)
    setError(null)
    setRowMenu(null)
  }

  /**
   * THE MENU LIVES INSIDE THE DIALOG, AND ITS COORDINATES SAY SO.
   *
   * `DialogContent` is centred with a CSS transform, which makes it the
   * containing block for any `position: fixed` descendant — so a menu placed at
   * viewport coordinates would land at the wrong point, and `useCursorMenu`'s
   * clamp (which measures against `window`) cannot be reused as-is. Storing the
   * offset from the dialog's own box keeps the arithmetic honest.
   *
   * Rendering it inside the dialog rather than portalling to `document.body`
   * also keeps it out of the modal's outside-press path: a click on a portalled
   * menu reads as a click outside the dialog, which would close the picker
   * underneath the menu the user just opened.
   */
  function openRowMenu(entry: DirectoryEntry, event: ReactMouseEvent): void {
    const box = dialogRef.current?.getBoundingClientRect()
    if (!box) return
    event.preventDefault()
    setRowMenu({ entry, x: event.clientX - box.left, y: event.clientY - box.top })
  }

  function cancelEdit(): void {
    setEdit(null)
    setEditError(null)
  }

  /**
   * Commit the open row. Creating a REPO completes the dialog the way picking an
   * existing one does (the parent registers it and closes); the other two leave
   * the dialog open and re-list, because the user is still choosing.
   */
  async function commitEdit(): Promise<void> {
    if (!edit || !listing) return
    const name = edit.name.trim()
    if (name === '') {
      setEditError('Enter a name for the folder')
      return
    }
    if (name.includes('/')) {
      setEditError('A folder name cannot contain "/"')
      return
    }
    if (edit.kind === 'rename' && name === edit.from) {
      cancelEdit()
      return
    }

    setWritingKind(edit.kind)
    setEditError(null)
    try {
      if (edit.kind === 'repo') {
        await onCreateRepo?.(listing.path, name)
        onClose()
        return
      }
      if (edit.kind === 'folder') await onCreateFolder?.(listing.path, name)
      else await onRenameFolder?.(listing.path, edit.from, name)
      setEdit(null)
      await load(listing.path, undefined, 'preserve')
    } catch (e) {
      // Stays open with what the user typed: "already here" and "too long" are
      // both fixed by editing the name, not by starting over.
      setEditError(formatAppError(e, 'Could not save the folder'))
    } finally {
      setWritingKind(null)
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
      <DialogContent
        ref={dialogRef}
        className="flex max-h-[calc(100dvh-48px)] w-full max-w-[calc(100%-24px)] flex-col gap-0 overflow-hidden rounded-[14px] border-0 bg-[#22262d] p-0 text-[#f2f3f5] shadow-[0_30px_70px_-20px_rgba(0,0,0,.75),inset_0_0_0_1px_#2f343d] sm:max-w-[1100px] [&>button]:right-6 [&>button]:top-[22px] [&>button]:size-7 [&>button]:rounded-lg [&>button]:text-[#9ba1ab]"
      >
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
                    {/* The route a machine with nothing on its disk never had
                        (POD-1295): make the repository here instead of finding one. */}
                    {onCreateFolder && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-9 rounded-[9px] border-0 text-[#a8adb6] shadow-[inset_0_0_0_1px_#333842]"
                        disabled={!listing || busy}
                        onClick={() => startEdit({ kind: 'folder', name: '' })}
                        aria-label="New folder"
                        title="New folder"
                      >
                        <FolderPlus size={17} />
                      </Button>
                    )}
                    {onCreateRepo && (
                      <Button
                        size="sm"
                        className="h-9 rounded-[9px] border-0 bg-[#e3ba52] px-[15px] text-[12.5px] font-semibold text-[#1a1408] hover:bg-[#efc964] disabled:bg-transparent disabled:text-[#5f656e] disabled:shadow-[inset_0_0_0_1px_#2b2f37]"
                        disabled={!listing || busy}
                        onClick={() => startEdit({ kind: 'repo', name: '' })}
                      >
                        <FolderGit2 size={16} />
                        New repository
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
                {machineReady && edit?.kind !== 'rename' && edit && (
                  <EditRow
                    icon={
                      edit.kind === 'repo' ? (
                        <FolderGit2 size={19} className="flex-none text-[#e3ba52]" />
                      ) : (
                        <Folder size={19} className="flex-none text-[#8a9099]" />
                      )
                    }
                    label={edit.kind === 'repo' ? 'New repository name' : 'New folder name'}
                    placeholder={edit.kind === 'repo' ? 'my-project' : 'projects'}
                    value={edit.name}
                    busy={writingKind !== null}
                    commitLabel={edit.kind === 'repo' ? 'Create repository' : 'Create folder'}
                    error={editError}
                    // Standing inside a checkout, a repo created here nests inside
                    // it — legal, occasionally meant, and never what someone
                    // expects to have done by accident.
                    warning={
                      edit.kind === 'repo' && listing?.isRepo === true
                        ? `This will sit inside ${listing.path}, which is already a repository.`
                        : null
                    }
                    onChange={(name) => setEdit({ ...edit, name })}
                    onCommit={() => void commitEdit()}
                    onCancel={cancelEdit}
                  />
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
                  listing?.entries.map((entry) =>
                    edit?.kind === 'rename' && edit.from === entry.name ? (
                      <EditRow
                        key={entry.path}
                        icon={
                          entry.isRepo ? (
                            <FolderGit2 size={19} className="flex-none text-[#e3ba52]" />
                          ) : (
                            <Folder size={19} className="flex-none text-[#8a9099]" />
                          )
                        }
                        label={`Rename folder ${entry.name}`}
                        placeholder={entry.name}
                        value={edit.name}
                        busy={writingKind !== null}
                        commitLabel="Rename"
                        error={editError}
                        warning={null}
                        onChange={(name) => setEdit({ ...edit, name })}
                        onCommit={() => void commitEdit()}
                        onCancel={cancelEdit}
                      />
                    ) : (
                      <div
                        className="group flex min-h-[46px] items-center gap-[13px] border-t border-[#272b33] px-6 hover:bg-[#252a31]"
                        key={entry.path}
                      >
                        <button
                          type="button"
                          data-pressable
                          className="flex min-w-0 flex-1 items-center gap-[13px] py-[11px] text-left disabled:pointer-events-none disabled:opacity-50"
                          onClick={() => void load(entry.path)}
                          // Right-click the row. On the button rather than the row
                          // wrapper because the wrapper is a plain div — and this
                          // is also what the keyboard's menu key targets, since it
                          // fires `contextmenu` at whatever has focus.
                          onContextMenu={(event) => {
                            if (!onRenameFolder || busy) return
                            openRowMenu(entry, event)
                          }}
                          // F2 is the rename key everywhere a file list has one, and
                          // it is the only rename gesture a keyboard user gets: the
                          // row's click already means "open", so a double-click would
                          // have navigated before the second click landed.
                          onKeyDown={(event) => {
                            if (event.key !== 'F2' || !onRenameFolder || busy) return
                            event.preventDefault()
                            startEdit({ kind: 'rename', from: entry.name, name: entry.name })
                          }}
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
                    ),
                  )}
              </div>
              <div className="border-t border-[#2b2f37] bg-[#1f2329] px-6 pt-[18px] pb-[22px]">
                <p className="text-[12.5px] leading-none font-semibold text-[#a8adb6]">
                  {browsedRepoPath
                    ? 'Use this folder, or another path'
                    : 'Or use a repository path'}
                </p>
                <div className="mt-[11px] flex gap-3 max-sm:flex-col">
                  <Input
                    id="repo-machine-path"
                    aria-label={machinePathLabel}
                    className={cn(
                      'h-[38px] rounded-[9px] border-0 bg-[#15171b] px-[13px] font-mono text-[13px] text-[#e6e8ec] shadow-[inset_0_0_0_1px_#2f343d] placeholder:text-[#6f757f]',
                      // The offered path is what the button will act on, so it reads as
                      // content rather than as the usual dim hint.
                      browsedRepoPath && 'placeholder:text-[#9ba1ab]',
                    )}
                    value={manualPath}
                    placeholder={browsedRepoPath ?? '/home/user/project'}
                    disabled={writing || !machineReady}
                    onChange={(e) => setManualPath(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void pickManual()
                    }}
                  />
                  <Button
                    className="h-[38px] rounded-[9px] border-0 bg-[#e3ba52] px-[15px] text-[12.5px] font-semibold text-[#1a1408] disabled:bg-transparent disabled:text-[#5f656e] disabled:shadow-[inset_0_0_0_1px_#2b2f37] max-sm:w-full"
                    disabled={writing || !machineReady || manualTarget === ''}
                    onClick={() => void pickManual()}
                  >
                    <Check size={16} />
                    Use repository
                  </Button>
                </div>
              </div>
            </div>
            {rowMenu && (
              <RowMenu
                entry={rowMenu.entry}
                x={rowMenu.x}
                y={rowMenu.y}
                bounds={dialogRef.current}
                onClose={() => setRowMenu(null)}
                onOpen={() => {
                  setRowMenu(null)
                  void load(rowMenu.entry.path)
                }}
                onUse={
                  rowMenu.entry.isRepo
                    ? () => {
                        setRowMenu(null)
                        void pickPath(rowMenu.entry.path)
                      }
                    : undefined
                }
                onRename={() =>
                  startEdit({ kind: 'rename', from: rowMenu.entry.name, name: rowMenu.entry.name })
                }
              />
            )}
            {/* Only the long writes take the overlay. Creating a plain folder or
                renaming one is a single syscall and finishes before a curtain
                would finish fading in. */}
            {(saving || scanning || writingKind === 'repo') && (
              <SetupBusyOverlay
                title={
                  scanning
                    ? 'Looking for repositories…'
                    : writingKind === 'repo'
                      ? 'Creating the repository…'
                      : 'Using this repository…'
                }
                detail={
                  scanning
                    ? 'Podium is scanning this folder and will update this dialog when it finishes.'
                    : writingKind === 'repo'
                      ? `Podium is creating the folder, running git init, and registering it in ${listing?.path ?? ''}.`
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

/**
 * A folder row's right-click menu (POD-1295).
 *
 * Rename lives here rather than on a per-row button: it is a rare action next to
 * "open this folder" and "use this repository", and a control on every row reads
 * as an invitation to use it. The gestures that remain are the two a file list
 * teaches — right-click, and F2 on the focused row.
 *
 * Styled from the picker's own palette rather than `menu-surface.ts`: this
 * dialog is a fixed dark surface whatever the app's theme is, and a themed panel
 * would render a light menu on a dark modal.
 */
function RowMenu({
  entry,
  x,
  y,
  bounds,
  onClose,
  onOpen,
  onUse,
  onRename,
}: {
  entry: DirectoryEntry
  x: number
  y: number
  /** The dialog box these coordinates are relative to; the menu clamps inside it. */
  bounds: HTMLElement | null
  onClose: () => void
  onOpen: () => void
  onUse?: () => void
  onRename: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ x, y })

  // Clamp once the panel has a real size, against the DIALOG rather than the
  // window — the dialog's transform makes it the containing block, so a
  // viewport clamp (what `useCursorMenu` does for the app's other menus) would
  // be measuring the wrong box.
  useEffect(() => {
    const el = ref.current
    const box = bounds?.getBoundingClientRect()
    if (!el || !box) return
    const size = el.getBoundingClientRect()
    setPos({
      x: Math.max(6, Math.min(x, box.width - size.width - 6)),
      y: Math.max(6, Math.min(y, box.height - size.height - 6)),
    })
  }, [x, y, bounds])

  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      // The dialog closes on Escape too, so this has to stop before it gets there.
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const item =
    'flex w-full cursor-pointer items-center gap-2 rounded-md px-[7px] py-[5px] text-left text-[12.5px] text-[#c9ced6] outline-none hover:bg-[#2f343d] hover:text-[#f2f3f5] focus-visible:bg-[#2f343d] focus-visible:text-[#f2f3f5]'

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${entry.name}`}
      style={{ left: pos.x, top: pos.y }}
      className="absolute z-50 min-w-[168px] rounded-[10px] border border-[#3a404a] bg-[#272c34] p-[5px] shadow-[0_18px_40px_-12px_rgba(0,0,0,.8)]"
    >
      <button type="button" role="menuitem" className={item} onClick={onOpen}>
        <ChevronRight size={14} className="flex-none text-[#8a9099]" aria-hidden="true" />
        Open
      </button>
      {onUse && (
        <button type="button" role="menuitem" className={item} onClick={onUse}>
          <Check size={14} className="flex-none text-[#8a9099]" aria-hidden="true" />
          Use repository
        </button>
      )}
      <hr className="my-[4px] h-px border-0 bg-[#3a404a]" />
      <button type="button" role="menuitem" className={item} onClick={onRename}>
        <Pencil size={14} className="flex-none text-[#8a9099]" aria-hidden="true" />
        Rename…
      </button>
    </div>
  )
}

/**
 * The one row being typed into (POD-1295) — a new folder, a new repository, or a
 * rename. It reuses the listing's row geometry deliberately: naming happens in
 * the list the user is already reading, not in a second dialog stacked on the
 * first, so the name lands where the folder will appear.
 */
function EditRow({
  icon,
  label,
  placeholder,
  value,
  busy,
  commitLabel,
  error,
  warning,
  onChange,
  onCommit,
  onCancel,
}: {
  icon: ReactNode
  label: string
  placeholder: string
  value: string
  busy: boolean
  commitLabel: string
  error: string | null
  warning: string | null
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <div className="border-t border-[#272b33] bg-[#252a31] px-6 py-[9px]">
      <div className="flex items-center gap-[13px]">
        {icon}
        <Input
          autoFocus
          aria-label={label}
          className="h-8 min-w-0 flex-1 rounded-[7px] border-0 bg-[#15171b] px-[10px] font-mono text-[13px] text-[#f2f3f5] shadow-[inset_0_0_0_1.5px_#e3ba52] placeholder:text-[#6f757f]"
          value={value}
          placeholder={placeholder}
          disabled={busy}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onCommit()
            }
            // Stop the Escape from reaching the dialog, which would close the
            // whole picker over a mistyped folder name.
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              onCancel()
            }
          }}
        />
        <button
          type="button"
          data-pressable
          className="h-8 flex-none rounded-[9px] bg-[#e3ba52] px-[13px] text-[12.5px] leading-none font-semibold text-[#1a1408] disabled:bg-transparent disabled:text-[#5f656e] disabled:shadow-[inset_0_0_0_1px_#2b2f37]"
          disabled={busy || value.trim() === ''}
          onClick={onCommit}
        >
          {commitLabel}
        </button>
        <button
          type="button"
          data-pressable
          className="h-8 flex-none rounded-[9px] px-[11px] text-[12.5px] leading-none font-semibold text-[#a8adb6] shadow-[inset_0_0_0_1px_#333842] disabled:opacity-50"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 pl-8 text-[12.5px] leading-[1.4] text-[#f0a58f]">
          {error}
        </p>
      )}
      {!error && warning && (
        <p className="mt-2 pl-8 text-[12.5px] leading-[1.4] text-[#c8ab6a]">{warning}</p>
      )}
    </div>
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
