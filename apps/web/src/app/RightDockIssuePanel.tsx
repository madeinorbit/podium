import type { JSX } from 'react'
import { IssueExplorer, IssueExplorerCrumbs } from '@/features/issues/explorer/IssueExplorer'

type Props =
  | { kind: 'crumbs' }
  | { kind: 'explorer'; cwd: string; machineId?: string }

export default function RightDockIssuePanel(props: Props): JSX.Element {
  if (props.kind === 'crumbs') return <IssueExplorerCrumbs />
  return <IssueExplorer cwd={props.cwd} machineId={props.machineId} />
}
