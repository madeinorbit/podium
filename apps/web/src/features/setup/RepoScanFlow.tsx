import { shallowEqual } from '@podium/client-core/store'
import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { formatAppError } from '@/app/AppErrorPage'
import { useStoreSelector } from '@/app/store'
import { RepoPickerModal } from './RepoPickerModal'
import { RepoScanResults } from './RepoScanResults'
import {
  type MachineScanRepo,
  type RepoCandidate,
  rankMachineScanRepos,
  rankRepoCandidates,
} from './ranking'

type Results = { path: string; candidates: RepoCandidate[] }

/**
 * The reusable scan-and-select flow: browse to a folder, scan it for repos, pick
 * from the ranked results, and persist the selection. Used by the onboarding wizard
 * and the sidebar's "+ Add repo". The directory browser also keeps a direct
 * "Add this folder" path for when you already know the repo's path.
 *
 * Machine-aware (POD-787): selecting a machine offers the tiered machine scan
 * (probes of known repo paths → shallow adjacent walk → bounded home sweep) with the
 * results in the same selection screen; a direct path field remains as fallback.
 */
export function RepoScanFlow({
  onClose,
  onDone,
  intro,
  initialMachineId,
}: {
  onClose: () => void
  onDone: (addedCount: number) => void
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
  const [lastScan, setLastScan] = useState<{ machineId: string; repos: MachineScanRepo[] } | null>(
    null,
  )

  // Surface the machine's most recent discovery (e.g. the automatic connect scan)
  // as a "view results" shortcut instead of forcing a rescan.
  useEffect(() => {
    setLastScan(null)
    if (!selectedMachineId) return
    let cancelled = false
    void Promise.resolve()
      .then(() => trpc.discovery.lastMachineScan.query({ machineId: selectedMachineId }))
      .then((res) => {
        if (!cancelled && res)
          setLastScan({ machineId: selectedMachineId, repos: res.repos as MachineScanRepo[] })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [trpc, selectedMachineId])

  async function scanFolder(path: string): Promise<void> {
    const res = await trpc.discovery.scanFolder.mutate({ path })
    const fatal = res.diagnostics.find((d) => d.severity === 'error')
    if (res.repositories.length === 0 && fatal) throw new Error(fatal.message || 'Scan failed')
    setResults({ path, candidates: rankRepoCandidates(res.repositories) })
  }

  function machineLabel(machineId: string): string {
    return machines.find((m) => m.id === machineId)?.name ?? machineId
  }

  async function scanMachine(machineId: string): Promise<void> {
    const res = await trpc.discovery.scanMachine.mutate({ machineId, deep: true })
    // Origin matches were auto-registered server-side — reflect them in the sidebar.
    await refreshRepos()
    const fatal = res.diagnostics.find((d) => d.severity === 'error')
    if (res.repos.length === 0 && fatal) throw new Error(fatal.message || 'Scan failed')
    setResults({
      path: machineLabel(machineId),
      candidates: rankMachineScanRepos(res.repos as MachineScanRepo[]),
    })
  }

  function viewLastScan(): void {
    if (!lastScan) return
    setResults({
      path: machineLabel(lastScan.machineId),
      candidates: rankMachineScanRepos(lastScan.repos),
    })
  }

  function repoMachineInput(): { machineId?: string } {
    return selectedMachineId ? { machineId: selectedMachineId } : {}
  }

  // Direct single-folder add. The picker closes itself afterward (its onClose),
  // and refreshRepos has already updated the sidebar, so no onDone is needed here.
  async function addThisFolder(path: string): Promise<void> {
    await trpc.repos.add.mutate({ path, ...repoMachineInput() })
    await refreshRepos()
  }

  async function addSelected(paths: string[]): Promise<void> {
    setAdding(true)
    setAddError(null)
    try {
      const res = await trpc.repos.addMany.mutate({ paths, ...repoMachineInput() })
      await refreshRepos()
      if (res.failed.length > 0) {
        setAddError(
          `${res.failed.length} could not be added: ${res.failed.map((f) => f.path).join(', ')}`,
        )
        setAdding(false)
        return
      }
      onDone(paths.length)
    } catch (e) {
      setAddError(formatAppError(e, 'Could not add repos'))
      setAdding(false)
    }
  }

  if (results) {
    return (
      <RepoScanResults
        scannedPath={results.path}
        candidates={results.candidates}
        adding={adding}
        error={addError}
        onAdd={(paths) => void addSelected(paths)}
        onBack={() => {
          setResults(null)
          setAddError(null)
        }}
      />
    )
  }

  const lastForSelected =
    lastScan && lastScan.machineId === selectedMachineId
      ? { count: lastScan.repos.length, view: viewLastScan }
      : null

  return (
    <RepoPickerModal
      onClose={onClose}
      onPick={addThisFolder}
      onScan={scanFolder}
      machines={machines}
      selectedMachineId={selectedMachineId}
      onMachineChange={setSelectedMachineId}
      onScanMachine={scanMachine}
      lastMachineScan={lastForSelected}
      {...(intro ? { intro } : {})}
    />
  )
}
