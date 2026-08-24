import { shallowEqual } from '@podium/client-core/store'
import { LOCAL_PROJECT_INTAKE_DRAFT_KEY } from '@podium/client-core/ui-state'
import type { MachineId } from '@podium/model'
import { asMachineId, HOST_REPOS, machinesFor } from '@podium/model'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatAppError } from '@/app/AppErrorPage'
import { useStoreSelector } from '@/app/store'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { RepoPickerModal } from './RepoPickerModal'
import { RepoScanResults } from './RepoScanResults'
import { type MachineScanRepo, type RepoCandidate, rankMachineScanRepos } from './ranking'

type Results = { path: string; candidates: RepoCandidate[] }
type LocalProjectDraft = {
  selectedMachineId?: string
  browsePath?: string
  source?: 'github' | 'local'
  results?: Results
  selectedPaths?: string[]
}

function readLocalProjectDraft(raw: string | null | undefined): LocalProjectDraft {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    const results = value.results as Partial<Results> | undefined
    const candidates = Array.isArray(results?.candidates)
      ? results.candidates.filter(
          (candidate): candidate is RepoCandidate =>
            candidate !== null &&
            typeof candidate === 'object' &&
            typeof (candidate as { path?: unknown }).path === 'string' &&
            typeof (candidate as { name?: unknown }).name === 'string',
        )
      : undefined
    return {
      ...(typeof value.selectedMachineId === 'string'
        ? { selectedMachineId: value.selectedMachineId }
        : {}),
      ...(typeof value.browsePath === 'string' && value.browsePath.startsWith('/')
        ? { browsePath: value.browsePath }
        : {}),
      ...(value.source === 'github' || value.source === 'local' ? { source: value.source } : {}),
      ...(typeof results?.path === 'string' && candidates
        ? { results: { path: results.path, candidates } }
        : {}),
      ...(Array.isArray(value.selectedPaths)
        ? {
            selectedPaths: value.selectedPaths.filter(
              (path): path is string => typeof path === 'string',
            ),
          }
        : {}),
    }
  } catch {
    return {}
  }
}

/**
 * The reusable scan-and-select flow: pick a machine, browse ITS directories, and
 * either add the repo you're standing in or scan for repos from here. The scan
 * covers the browsed folder AND this machine's known repo locations (POD-855)
 * [spec:SP-5eb6], returning one grouped result view (already-added / found).
 *
 * Machine-aware (POD-814) [spec:SP-3701]: every action names its machine and runs
 * on that machine's daemon. One machine is always selected — there is no server-host
 * filesystem to fall back to.
 */
export function RepoScanFlow({
  onClose,
  onDone,
  onboarding = false,
  initialMachineId,
}: {
  onClose: () => void
  /** Fired once the selection is committed; the count covers adds + removals. */
  onDone: (changedCount: number) => void
  /** Persist first-run intake progress across reloads and restarts. */
  onboarding?: boolean
  /** Preselect a machine (e.g. the machines panel's per-row "Find repos"). */
  initialMachineId?: MachineId
}): JSX.Element {
  const { trpc, refreshRepos, machines, uiState } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      refreshRepos: s.refreshRepos,
      machines: s.machines,
      uiState: s.uiState,
    }),
    shallowEqual,
  )
  const [initialDraft] = useState<LocalProjectDraft>(() =>
    onboarding ? readLocalProjectDraft(uiState?.get(LOCAL_PROJECT_INTAKE_DRAFT_KEY)) : {},
  )
  const [draft, setDraftState] = useState<LocalProjectDraft>(initialDraft)
  const [results, setResults] = useState<Results | null>(() => initialDraft.results ?? null)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [selectedMachineId, setSelectedMachineIdState] = useState<string | undefined>(
    initialMachineId ?? initialDraft.selectedMachineId,
  )
  // RepoPickerModal closes after a successful direct add/clone. Remember that
  // the close belongs to completion so it cannot also drive the caller's
  // cancel/back route after onDone has advanced activation.
  const committed = useRef(false)

  const persistDraft = useCallback(
    (patch: Partial<LocalProjectDraft>): void => {
      if (!onboarding) return
      setDraftState((current) => {
        const next = { ...current, ...patch }
        uiState?.set(LOCAL_PROJECT_INTAKE_DRAFT_KEY, JSON.stringify(next))
        return next
      })
    },
    [onboarding, uiState],
  )

  function setSelectedMachineId(machineId: string | undefined): void {
    setSelectedMachineIdState(machineId)
    persistDraft({
      selectedMachineId: machineId,
      browsePath: undefined,
      results: undefined,
      selectedPaths: undefined,
    })
  }

  function finish(changedCount: number): void {
    committed.current = true
    if (onboarding) uiState?.set(LOCAL_PROJECT_INTAKE_DRAFT_KEY, null)
    onDone(changedCount)
  }

  /**
   * Machines that could EVER own a repository (POD-2700) — the population this
   * screen may select from, offer, or restore a persisted pin out of.
   *
   * Structural, not live: an offline laptop is still a repo host and stays in
   * the list (disabled, labelled offline), because "wake it up" is real advice.
   * A machine that runs no daemon is excluded and counted instead — see
   * `RepoPickerModal`, which renders the count and the empty state.
   */
  const repoHosts = useMemo(() => machinesFor(machines, HOST_REPOS), [machines])

  // Settle on a machine as soon as the fleet is known: the picker browses a
  // machine's daemon, so "none selected" is not a usable state. Preference order —
  // the caller's pick, then the device the user is sitting at (the desktop shell
  // knows its own machineId), then any online machine, then the first known one.
  // A single-machine install has exactly one, and lands on it.
  //
  // POD-2700 §3.3: EVERY arm of this now draws from `repoHosts`, and there is no
  // final `machines[0]`. Auto-selection is a listing site with no visible list,
  // and this fallback is what pinned the operator's repo screen to the
  // server-only coordinator: it was the only row, so it was `machines[0]`, so it
  // was silently selected, and every action on it dead-ended. When nothing
  // qualifies the answer is now NO SELECTION, which is what makes the modal
  // render its empty state instead of a dud.
  useEffect(() => {
    if (
      selectedMachineId !== undefined &&
      repoHosts.some((machine) => machine.id === selectedMachineId)
    ) {
      return
    }
    const thisDevice = nativeDesktopBridge()?.machineId
    const preferred =
      repoHosts.find((m) => m.id === thisDevice && m.online) ??
      repoHosts.find((m) => m.online) ??
      repoHosts[0]
    // A STALE PIN IS NOT RESTORED, it is replaced. `selectedMachineId` seeds from
    // the persisted draft, which may name a machine that has since lost its
    // daemon or left the fleet; re-validating it against the predicate above is
    // the difference between a remembered convenience and a resurrected dud.
    setSelectedMachineId(preferred?.id)
  }, [repoHosts, selectedMachineId])

  function repoMachineInput(): { machineId?: MachineId } {
    return selectedMachineId ? { machineId: asMachineId(selectedMachineId) } : {}
  }

  // "Scan for repos": the tiered discovery rooted at the browsed folder plus this
  // machine's known repo locations (POD-855). Origin matches are auto-registered
  // server-side; refresh so the sidebar reflects them, then show the grouped view.
  async function scanFrom(path: string): Promise<void> {
    if (!selectedMachineId) return
    const res = await trpc.discovery.scanMachine.mutate({
      machineId: selectedMachineId,
      deep: false,
      atPath: path,
    })
    await refreshRepos()
    const fatal = res.diagnostics.find((d) => d.severity === 'error')
    if (res.repos.length === 0 && fatal) throw new Error(fatal.message || 'Scan failed')
    const next = { path, candidates: rankMachineScanRepos(res.repos as MachineScanRepo[]) }
    setResults(next)
    persistDraft({ results: next, selectedPaths: undefined, browsePath: path })
  }

  // Direct add of the browsed repo. The picker closes itself afterward (its
  // onClose), and refreshRepos has already updated the sidebar.
  async function addThisFolder(path: string): Promise<void> {
    await trpc.repos.add.mutate({ path, ...repoMachineInput() })
    await refreshRepos()
    finish(1)
  }

  /**
   * Make the repository the fresh machine did not have (POD-1295). The server
   * creates the folder, runs `git init` with its seed commit, and registers the
   * result — so this completes activation exactly as adding an existing repo
   * does, and the picker closes behind it.
   */
  async function createRepoHere(parentPath: string, name: string): Promise<void> {
    if (!selectedMachineId) return
    await trpc.repos.createRepo.mutate({
      machineId: asMachineId(selectedMachineId),
      parentPath,
      name,
    })
    await refreshRepos()
    finish(1)
  }

  /** A plain folder registers nothing; the picker re-lists and the user carries on. */
  async function createFolderHere(parentPath: string, name: string): Promise<void> {
    if (!selectedMachineId) return
    await trpc.repos.createFolder.mutate({
      machineId: asMachineId(selectedMachineId),
      parentPath,
      name,
    })
  }

  async function renameFolderHere(
    parentPath: string,
    currentName: string,
    name: string,
  ): Promise<void> {
    if (!selectedMachineId) return
    await trpc.repos.renameFolder.mutate({
      machineId: asMachineId(selectedMachineId),
      parentPath,
      currentName,
      name,
    })
  }

  async function cloneFromGitHub(repository: string, destination: string): Promise<void> {
    if (!selectedMachineId) return
    await trpc.repos.cloneGithub.mutate({
      machineId: selectedMachineId,
      repository,
      destination,
    })
    await refreshRepos()
    finish(1)
  }

  /** Commit the results screen's desired end state: add what was checked, remove
   *  what was unchecked. Removals go one per path — repos.remove is per-repo, and
   *  a failure on one shouldn't abandon the rest. */
  async function applyChanges({ add, remove }: { add: string[]; remove: string[] }): Promise<void> {
    setAdding(true)
    setAddError(null)
    try {
      const failed: string[] = []
      if (add.length > 0) {
        const res = await trpc.repos.addMany.mutate({ paths: add, ...repoMachineInput() })
        failed.push(...res.failed.map((f) => f.path))
      }
      for (const path of remove) {
        try {
          await trpc.repos.remove.mutate({ path, ...repoMachineInput() })
        } catch {
          failed.push(path)
        }
      }
      await refreshRepos()
      if (failed.length > 0) {
        setAddError(`${failed.length} could not be saved: ${failed.join(', ')}`)
        setAdding(false)
        return
      }
      finish(add.length + remove.length)
    } catch (e) {
      setAddError(formatAppError(e, 'Could not save repos'))
      setAdding(false)
    }
  }

  return (
    <RepoPickerModal
      onClose={() => {
        if (!committed.current) onClose()
      }}
      onPick={addThisFolder}
      onScan={scanFrom}
      onCloneGithub={cloneFromGitHub}
      onCreateRepo={createRepoHere}
      onCreateFolder={createFolderHere}
      onRenameFolder={renameFolderHere}
      initialSource={draft.source ?? 'local'}
      initialPath={draft.browsePath}
      onProgress={persistDraft}
      machines={machines}
      selectedMachineId={
        selectedMachineId === undefined ? undefined : asMachineId(selectedMachineId)
      }
      onMachineChange={setSelectedMachineId}
      resultPanel={
        results ? (
          <RepoScanResults
            embedded
            scannedPath={results.path}
            candidates={results.candidates}
            saving={adding}
            error={addError}
            onApply={(changes) => void applyChanges(changes)}
            onBack={() => {
              setResults(null)
              setAddError(null)
              persistDraft({ results: undefined, selectedPaths: undefined })
            }}
            initialSelectedPaths={draft.selectedPaths}
            onSelectionChange={(selectedPaths) => persistDraft({ selectedPaths })}
          />
        ) : undefined
      }
    />
  )
}
