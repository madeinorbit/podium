import { asIssueId, type MachineId } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { CircleDot, CornerUpLeft } from 'lucide-react'
import type { JSX } from 'react'
import { useDockIssue, useDockIssueRows } from '@/features/issues/dock-issue'
import { IssuePanelEmpty, IssuePanelView } from '@/features/issues/IssuePanelView'

type Props = { kind: 'header' } | { kind: 'panel'; cwd: string; machineId?: MachineId }

export default function RightDockIssuePanel(props: Props): JSX.Element {
  if (props.kind === 'header') return <DockIssueHeader />
  return <DockIssueBody cwd={props.cwd} machineId={props.machineId} />
}

/**
 * The panel's one header: which task this is, by ref. The task's name is the
 * head of the panel below, where it can wrap. When a chip or a linked row has
 * pointed the panel away from the shell's task, a quiet way back sits beside it.
 */
function DockIssueHeader(): JSX.Element {
  const { issueId, shellIssueId, show } = useDockIssue()
  const detour = issueId !== null && shellIssueId !== null && issueId !== shellIssueId
  const ids = [issueId, detour ? shellIssueId : null].filter((id): id is string => id !== null)
  const rows = useDockIssueRows(ids)
  const shown = rows.find((row) => row.id === issueId)
  const home = detour ? rows.find((row) => row.id === shellIssueId) : undefined
  return (
    <span className="flex min-w-0 flex-1 items-center gap-[9px]">
      <CircleDot size={16} className="flex-none text-text-dim" aria-hidden="true" />
      {shown ? (
        <span
          className="flex-none font-mono text-[12px] leading-none whitespace-nowrap text-muted-foreground"
          data-dock-title="panel"
          title={`${shown.title}${shown.archived ? ' · archived' : ''}`}
        >
          {issueDisplayRef(shown)}
          {shown.archived ? ' · archived' : ''}
        </span>
      ) : (
        <span
          className="truncate text-[13.5px] leading-none font-semibold text-text-strong"
          data-dock-title="panel"
        >
          Task
        </span>
      )}
      {detour && shellIssueId && (
        <button
          data-pressable
          type="button"
          data-testid="dock-issue-back"
          onClick={() => show(shellIssueId)}
          title={home ? `Back to ${home.title}` : 'Back to the selected task'}
          className="ml-auto flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 font-mono text-[11px] whitespace-nowrap text-text-dim hover:bg-accent/60 hover:text-foreground"
        >
          <CornerUpLeft size={12} className="flex-none" aria-hidden="true" />
          <span className="truncate">{home ? issueDisplayRef(home) : 'Back'}</span>
        </button>
      )}
    </span>
  )
}

function DockIssueBody({ cwd, machineId }: { cwd: string; machineId?: MachineId }): JSX.Element {
  const { issueId, show } = useDockIssue()
  if (!issueId) return <IssuePanelEmpty />
  return (
    <IssuePanelView
      cwd={cwd}
      machineId={machineId}
      issueId={asIssueId(issueId)}
      onNavigate={show}
    />
  )
}
