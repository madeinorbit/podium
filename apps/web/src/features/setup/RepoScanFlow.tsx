import { shallowEqual } from '@podium/client-core/store'
import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { formatAppError } from '@/app/AppErrorPage'
import { useStoreSelector } from '@/app/store'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { RepoPickerModal } from './RepoPickerModal'
import { RepoScanResults } from './RepoScanResults'
import { type MachineScanRepo, type RepoCandidate, rankMachineScanRepos } from './ranking'

type Results = { path: string; candidates: RepoCandidate[] }

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
  intro,
  initialMachineId,
}: {
  onClose: () => void
  /** Fired once the selection is committed; the count covers adds + removals. */
  onDone: (changedCount: number) => void
  intro?: ReactNode
  /** Preselect a machine (e.g. the machines panel's per-row "Find repos"). */
  initialMachineId?: string
}): JSX.Element {
  const { trpc, refreshRepos, machines } = useStoreSelector(
    (s) => ({ trpc: s.trpc, refreshRepos: s.refreshRepos, machines: s.machines }),
    shallowEqual,
  )
  const [results, setResults] = useState<Results | null>(null)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [selectedMachineId, setSelectedMachineId] = useState<string | undefined>(initialMachineId)

  // Settle on a machine as soon as the fleet is known: the picker browses a
  // machine's daemon, so "none selected" is not a usable state. Preference order —
  // the caller's pick, then the device the user is sitting at (the desktop shell
  // knows its own machineId), then any online machine, then the first known one.
  // A single-machine install has exactly one, and lands on it.
  useEffect(() => {
    if (selectedMachineId !== undefined || machines.length === 0) return
    const thisDevice = nativeDesktopBridge()?.machineId
    const preferred =
      machines.find((m) => m.id === thisDevice && m.online) ??
      machines.find((m) => m.online) ??
      machines[0]
    if (preferred) setSelectedMachineId(preferred.id)
  }, [machines, selectedMachineId])

  function repoMachineInput(): { machineId?: string } {
    return selectedMachineId ? { machineId: selectedMachineId } : {}
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
    setResults({ path, candidates: rankMachineScanRepos(res.repos as MachineScanRepo[]) })
  }

  // Direct add of the browsed repo. The picker closes itself afterward (its
  // onClose), and refreshRepos has already updated the sidebar.
  async function addThisFolder(path: string): Promise<void> {
    await trpc.repos.add.mutate({ path, ...repoMachineInput() })
    await refreshRepos()
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
      onDone(add.length + remove.length)
    } catch (e) {
      setAddError(formatAppError(e, 'Could not save repos'))
      setAdding(false)
    }
  }

  if (results) {
    return (
      <RepoScanResults
        scannedPath={results.path}
        candidates={results.candidates}
        saving={adding}
        error={addError}
        onApply={(changes) => void applyChanges(changes)}
        onBack={() => {
          setResults(null)
          setAddError(null)
        }}
      />
    )
  }

  return (
    <RepoPickerModal
      onClose={onClose}
      onPick={addThisFolder}
      onScan={scanFrom}
      machines={machines}
      selectedMachineId={selectedMachineId}
      onMachineChange={setSelectedMachineId}
      {...(intro ? { intro } : {})}
    />
  )
}
