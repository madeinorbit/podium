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
import { motionPhase } from '@podium/client-core/viewmodels'
import type { IssueId, IssueWire, SessionMeta } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { ArrowLeft, ChevronDown, ChevronUp, MoreHorizontal } from 'lucide-react'
import { Fragment, type JSX } from 'react'
import { type IssueViewModel, useReplicaIssues } from '@/app/store'
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
import { WorkingMark } from '@/lib/motion'
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
  sessions,
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
  /** Member sessions — the header's live-state readout (POD-591). */
  sessions: SessionMeta[]
  prev?: IssueId
  next?: IssueId
  onBack: () => void
  onNavigate: (id: IssueId) => void
}): JSX.Element {
  const issues = useReplicaIssues()
  const parent = issue.parentId ? issues.find((i) => i.id === issue.parentId) : undefined
  const phases = sessions.map((s) => motionPhase(s, issue as unknown as IssueWire))
  const working = phases.filter((p) => p === 'working').length
  // "Needs you" is the ISSUE's own flag or any session waiting on a human. Both
  // mean the same thing to the operator, and the header is where they look
  // before deciding whether this task is their next move.
  const needsYou = issue.needsHuman || phases.includes('waiting')
  return (
    <header className="flex h-10 flex-none items-center gap-2 border-hairline-bar border-b bg-bar px-3">
      <Button type="button" variant="ghost" size="icon-sm" title="Back" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden="true" />
      </Button>
      {/* ONE BASELINE (POD-1224). The crumbs mix a 11.5px sans repo name with
          10.5px mono refs, and `items-center` on the bar centred each one's LINE
          BOX — two fonts at two sizes have different ascent/descent, so centring
          the boxes put the baselines a pixel apart and the chain read as
          stepped. They are their own baseline-aligned group now, and that group
          is what the bar centres. `leading-none` so the group's own box is the
          text and nothing else. */}
      <div className="flex min-w-0 items-baseline gap-2 leading-none">
        <span className="text-[11.5px] text-text-dim">{repoName}</span>
        <span className="text-[11.5px] text-text-faint">›</span>
        {parent && (
          <>
            <button
              data-pressable
              type="button"
              className="max-w-[160px] truncate font-mono text-[11px] text-text-dim tabular-nums leading-none hover:text-foreground"
              title={`${issueDisplayRef(parent)} · ${parent.title}${parent.archived ? ' · archived' : ''}`}
              onClick={() => onNavigate(parent.id)}
            >
              {issueDisplayRef(parent)}
              {parent.archived ? ' · archived' : ''}
            </button>
            <span className="text-[11.5px] text-text-faint">›</span>
          </>
        )}
        <button
          data-pressable
          type="button"
          className="cursor-pointer rounded font-mono text-[11px] text-foreground tabular-nums leading-none hover:text-primary"
          title={`${issueDisplayRef(issue)} · ${issue.title} — click to copy "${issueDisplayRef(issue)}"`}
          onClick={() =>
            copyToClipboard(issueDisplayRef(issue), `Copied ${issueDisplayRef(issue)}`)
          }
        >
          {issueDisplayRef(issue)}
        </button>
      </div>

      {/* TRANSIENT URGENCY ONLY (POD-635). This band is always on screen, so it
          carries the two facts that decide whether this task is your next move:
          is it waiting on you, and is anything computing.

          It used to carry the git chip too — branch, merge axis, dirty count —
          while the rail's Branch section carried the same three, three hundred
          pixels to the right and always visible beside it. DESIGN.md's git rule
          is that one git fact is never restated in two places, and the band
          repeating what the rail already said is what made the top of the page
          read as an instrument cluster rather than the start of a document. */}
      {(needsYou || working > 0) && (
        <div className="ml-1 flex min-w-0 items-center gap-2.5 self-center border-hairline-bar border-l py-1 pl-2.5">
          {needsYou && (
            <span className="flex flex-none items-center gap-1.5 text-[11px] leading-none text-attention">
              <span className="size-[5px] rounded-full bg-attention" aria-hidden="true" />
              needs you
            </span>
          )}
          {working > 0 && (
            <span className="flex flex-none items-center gap-1.5 font-mono shell-type-micro text-live tabular-nums">
              <WorkingMark size={12} />
              {working} working
            </span>
          )}
        </div>
      )}

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
    if (issue.archived) {
      commands.toggleArchived()
      return
    }
    const subtree = issue.childCount > 0
    if (!issue.closedReason && issue.stage !== 'done') {
      const ok = window.confirm(
        subtree
          ? 'Archive this open issue and every sub-task beneath it? They will leave active views.'
          : 'Archive this open issue? It will leave active views.',
      )
      if (!ok) return
    } else if (subtree) {
      const ok = window.confirm(
        'Archive this issue and every sub-task beneath it? They will leave active views.',
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
                  variant={entry.danger ? 'destructive' : 'default'}
                >
                  <Icon aria-hidden="true" className="size-3.5 flex-none" /> {label}
                </DropdownMenuItem>
              )}
            </Fragment>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
