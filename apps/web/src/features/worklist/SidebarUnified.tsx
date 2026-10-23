import type { JSX } from 'react'
import { useNewTaskDraftRow } from './new-task-overlay'
import { PoolSidebarUnified, PoolWorkSections } from './pool-sidebar'

/** Both sidebar surfaces read the principal-owned pool. */
export function SidebarUnified(): JSX.Element {
  // The New task overlay's draft lands in its project's folder (design 6a).
  const draft = useNewTaskDraftRow()
  return <PoolSidebarUnified draft={draft} />
}
export function WorkSections({ query = '' }: { query?: string } = {}): JSX.Element {
  return <PoolWorkSections query={query} />
}
