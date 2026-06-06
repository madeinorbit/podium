import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { formatAppError } from './AppErrorPage'
import { RepoPickerModal } from './RepoPickerModal'
import { RepoScanResults } from './RepoScanResults'
import { type RepoCandidate, rankRepoCandidates } from './ranking'
import { useStore } from './store'

type Results = { path: string; candidates: RepoCandidate[] }

/**
 * The reusable scan-and-select flow: browse to a folder, scan it for repos, pick
 * from the ranked results, and persist the selection. Used by the onboarding wizard
 * and the sidebar's "+ Add repo". The directory browser also keeps a direct
 * "Add this folder" path for when you already know the repo's path.
 */
export function RepoScanFlow({
  onClose,
  onDone,
  intro,
}: {
  onClose: () => void
  onDone: (addedCount: number) => void
  intro?: ReactNode
}): JSX.Element {
  const { trpc, refreshRepos } = useStore()
  const [results, setResults] = useState<Results | null>(null)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  async function scanFolder(path: string): Promise<void> {
    const res = await trpc.discovery.scanFolder.mutate({ path })
    const fatal = res.diagnostics.find((d) => d.severity === 'error')
    if (res.repositories.length === 0 && fatal) throw new Error(fatal.message || 'Scan failed')
    setResults({ path, candidates: rankRepoCandidates(res.repositories) })
  }

  // Direct single-folder add. The picker closes itself afterward (its onClose),
  // and refreshRepos has already updated the sidebar, so no onDone is needed here.
  async function addThisFolder(path: string): Promise<void> {
    await trpc.repos.add.mutate({ path })
    await refreshRepos()
  }

  async function addSelected(paths: string[]): Promise<void> {
    setAdding(true)
    setAddError(null)
    try {
      const res = await trpc.repos.addMany.mutate({ paths })
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

  return (
    <RepoPickerModal
      onClose={onClose}
      onPick={addThisFolder}
      onScan={scanFolder}
      {...(intro ? { intro } : {})}
    />
  )
}
