/**
 * The issue page's header: repo breadcrumb, the copyable display ref, prev/next
 * navigation, and the `…` overflow menu. Split out of IssuePage.tsx (POD-646).
 *
 * The overflow menu is a RENDERER over `./issue-page-menu.ts` — it walks the
 * entry list, draws separators where the config says a group starts, and maps
 * each id to a handler. It contains no eligibility logic of its own, which is
 * what keeps this menu and any other renderer of the same config (a command
 * palette) offering the same set. See that module's header for the rights
 * predicate and its ownership note.
 */
import type { IssueId } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { ArrowLeft, ChevronDown, ChevronUp, MoreHorizontal } from 'lucide-react'
import { Fragment, type JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { copyToClipboard } from '@/lib/clipboard'
import { issueRefLong } from '../issue-card'
import type { IssuePageCommands } from '../issue-page-commands'
import {
  type IssuePageMenuAction,
  type IssuePageMenuEntry,
  issuePageMenuEntries,
  startsGroup,
} from './issue-page-menu'

export function IssueDetailHeader({
  issue,
  repoName,
  busy,
  commands,
  targets,
  prev,
  next,
  onBack,
  onNavigate,
}: {
  issue: IssueViewModel
  repoName: string
  busy: boolean
  commands: IssuePageCommands
  /** Repo-mates — supersede/duplicate targets, from the page model. */
  targets: IssueViewModel[]
  prev?: IssueId
  next?: IssueId
  onBack: () => void
  onNavigate: (id: IssueId) => void
}): JSX.Element {
  return (
    <header className="flex items-center gap-2 border-border border-b px-4 py-2.5">
      <Button type="button" variant="ghost" size="icon-sm" title="Back" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden="true" />
      </Button>
      <span className="text-[13px] text-muted-foreground">{repoName}</span>
      <span className="text-[13px] text-muted-foreground">›</span>
      <button
        data-pressable
        type="button"
        className="cursor-pointer rounded font-medium text-[13px] hover:text-primary"
        title={`${issueDisplayRef(issue)} · ${issue.title} — click to copy "${issueDisplayRef(issue)}"`}
        onClick={() => copyToClipboard(issueDisplayRef(issue), `Copied ${issueDisplayRef(issue)}`)}
      >
        {issueDisplayRef(issue)}
      </button>
      <div className="ml-auto flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Previous task"
          disabled={!prev}
          onClick={() => prev && onNavigate(prev)}
        >
          <ChevronUp size={15} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Next task"
          disabled={!next}
          onClick={() => next && onNavigate(next)}
        >
          <ChevronDown size={15} aria-hidden="true" />
        </Button>
        <IssueOverflowMenu
          issue={issue}
          busy={busy}
          commands={commands}
          targets={targets}
          onDeleted={onBack}
        />
      </div>
    </header>
  )
}

/**
 * The header `…` overflow menu. `commands` is the page's named-command set
 * (toast-wrapping runner included); `onDeleted` returns to the board after a
 * confirmed delete or restore.
 */
export function IssueOverflowMenu({
  issue,
  busy,
  commands,
  targets,
  onDeleted,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssuePageCommands
  targets: IssueViewModel[]
  onDeleted: () => void
}): JSX.Element {
  const entries = issuePageMenuEntries({ issue, targetCount: targets.length })

  const flagForHuman = (): void => {
    const q = window.prompt('Flag for human — question (optional):')
    if (q === null) return // cancelled
    const question = q.trim()
    commands.flagForHuman(question || undefined)
  }

  const handleDelete = (): void => {
    const sessionCount = (issue.memberSessionIds ?? []).length
    const message = `Delete "${issueRefLong(issue)}" and ${sessionCount} session${sessionCount === 1 ? '' : 's'}? The task and sessions can be restored; running processes will be stopped.`
    if (!window.confirm(message)) return
    commands.deleteIssue(onDeleted)
  }

  const handleArchive = (): void => {
    if (!issue.archived && !issue.closedReason && issue.stage !== 'done') {
      const ok = window.confirm(
        'Archive this open issue? It will leave active views, but it will not be closed and its sessions will not be retired.',
      )
      if (!ok) return
    }
    commands.toggleArchived()
  }

  const fire: Record<IssuePageMenuAction, () => void> = {
    'copy-branch': () => copyToClipboard(issue.branch ?? '', 'Copied branch name'),
    'open-linear': () => window.open(issue.linearUrl, '_blank', 'noopener,noreferrer'),
    'toggle-pin': commands.togglePinned,
    'toggle-archive': handleArchive,
    'flag-human': flagForHuman,
    // Submenu entries fire per target, not on the trigger.
    supersede: () => {},
    duplicate: () => {},
    delete: handleDelete,
    restore: () => commands.restoreIssue(onDeleted),
  }

  const pickTarget = (entry: IssuePageMenuEntry, id: IssueId): void => {
    if (entry.id === 'supersede') commands.supersedeWith(id)
    else if (entry.id === 'duplicate') commands.duplicateOf(id)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type="button" variant="ghost" size="icon-sm" title="More actions" disabled={busy}>
            <MoreHorizontal size={16} aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-52">
        {entries.map((entry, index) => {
          const Icon = entry.icon(issue)
          const label = entry.label(issue)
          return (
            <Fragment key={entry.id}>
              {startsGroup(entries, index) && <DropdownMenuSeparator />}
              {entry.submenu === 'issue-targets' ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                    {targets.map((t) => (
                      <DropdownMenuItem key={t.id} onClick={() => pickTarget(entry, t.id)}>
                        {issueRefLong(t)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : (
                <DropdownMenuItem
                  onClick={fire[entry.id]}
                  className={entry.danger ? 'text-destructive focus:text-destructive' : undefined}
                >
                  <Icon size={14} aria-hidden="true" /> {label}
                </DropdownMenuItem>
              )}
            </Fragment>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
