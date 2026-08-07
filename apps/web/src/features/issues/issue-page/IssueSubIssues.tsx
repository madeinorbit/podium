/**
 * The sub-task list, with the done children folded away and an inline add-row.
 * Split out of IssuePage.tsx (POD-646).
 *
 * WHERE THE CHILDREN COME FROM. The list is `subIssuesOf` from the ISSUES slice,
 * read once by the page model — not a `.filter(i => i.parentId === id)` here.
 * The slice's version is the one that keeps ARCHIVED children visible (POD-133),
 * and re-deriving it locally is how that decision silently gets lost on one
 * surface. The open/done partition below is a rendering split of that one list,
 * not a second derivation of it.
 *
 * PARTIAL WORLD. This counts and lists what the replica HOLDS. A child the
 * principal cannot see is not listed and is not hinted at either — the slice's
 * `branchRollup` note says the same thing about counts, since a count IS an
 * existence fact and §3.1.2 leaves that policy open.
 */
import type { IssueId } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { Plus } from 'lucide-react'
import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { issueIdTitle, issueStateWord } from '../issue-card'
import { AssigneeAvatar, StageGlyph } from '../issue-glyphs'
import { SectionHeading } from './chrome'

/** A child is DONE for the fold when the issue slice's own finished predicate
 *  says so — `stage === 'done'` or a recorded close reason. */
function isFinished(child: IssueViewModel): boolean {
  return child.stage === 'done' || child.closedReason != null
}

const STATE_TONE = {
  attention: 'text-attention',
  alert: 'text-destructive',
  live: 'text-live',
  quiet: 'text-text-dim',
} as const

/**
 * One sub-task, in the BOARD CARD'S GRAMMAR (POD-591).
 *
 * A sub-task is a task, so it ends in the same word the card's state line starts
 * with — `issueStateWord` reads the top of the same ranked list. Before this the
 * row ended in an assignee avatar, which is the one thing about a sub-task that
 * almost never changes, and said nothing about whether the child was blocked,
 * working or waiting on the operator.
 */
function SubTaskRow({
  child,
  onNavigate,
}: {
  child: IssueViewModel
  onNavigate: (id: IssueId) => void
}): JSX.Element {
  const state = issueStateWord(child)
  return (
    <button
      data-pressable
      type="button"
      className={cn(
        '-mx-2 flex min-h-[28px] items-center gap-2 rounded-[4.8px] px-2 text-left text-[12px] transition-colors hover:bg-accent',
        child.archived && 'opacity-60',
      )}
      title={issueIdTitle(child)}
      onClick={() => onNavigate(child.id)}
    >
      <StageGlyph stage={child.stage} size={12} />
      <span className="w-[56px] flex-none font-mono text-[9.5px] text-text-faint tabular-nums">
        {issueDisplayRef(child)}
      </span>
      <span className="min-w-0 flex-1 truncate">{child.title}</span>
      {child.archived && (
        <span className="flex-none font-mono text-[9px] text-text-faint uppercase tracking-[0.04em]">
          archived
        </span>
      )}
      {state ? (
        <span className={cn('flex-none font-mono text-[9px] tabular-nums', STATE_TONE[state.tone])}>
          {state.text}
        </span>
      ) : (
        <AssigneeAvatar assignee={child.assignee || undefined} size={15} />
      )}
    </button>
  )
}

export function IssueSubIssues({
  issue,
  subIssues,
  busy,
  addingChild,
  childTitle,
  onAddingChange,
  onChildTitleChange,
  onCreate,
  onNavigate,
}: {
  issue: IssueViewModel
  /** Named `subIssues` rather than `children`: a `children` PROP on a component
   *  that does not render its React children is the one thing React's own
   *  vocabulary reserves, and biome's noChildrenProp is right to refuse it. */
  subIssues: IssueViewModel[]
  busy: boolean
  addingChild: boolean
  childTitle: string
  onAddingChange: (adding: boolean) => void
  onChildTitleChange: (title: string) => void
  onCreate: (title: string) => void
  onNavigate: (id: IssueId) => void
}): JSX.Element {
  const doneChildren = subIssues.filter(isFinished)
  const openChildren = subIssues.filter((child) => !isFinished(child))
  return (
    <section className="mb-7 flex flex-col gap-1" data-testid="sub-issues">
      <SectionHeading
        count={issue.childCount > 0 ? `${issue.childDoneCount}/${issue.childCount}` : undefined}
      >
        Sub-tasks
      </SectionHeading>
      {openChildren.map((c) => (
        <SubTaskRow key={c.id} child={c} onNavigate={onNavigate} />
      ))}
      {doneChildren.length > 0 && issue.stage !== 'done' && !issue.closedReason && (
        <details className="mt-1 rounded border border-border/50 px-2 py-1">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            ✓ {doneChildren.length} done
          </summary>
          <div className="mt-1 flex flex-col gap-1">
            {doneChildren.map((child) => (
              <button
                data-pressable
                key={child.id}
                type="button"
                className="flex items-center gap-2 rounded px-1 py-1 text-left text-[12px] opacity-65 hover:bg-muted/50"
                onClick={() => onNavigate(child.id)}
              >
                <StageGlyph stage={child.stage} />
                <span className="text-[10px] text-muted-foreground">{issueDisplayRef(child)}</span>
                <span className="min-w-0 flex-1 truncate">{child.title}</span>
              </button>
            ))}
          </div>
        </details>
      )}
      {addingChild ? (
        <Input
          autoFocus
          placeholder="Sub-task title…"
          aria-label="Sub-task title"
          value={childTitle}
          onChange={(e) => onChildTitleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && childTitle.trim()) {
              e.preventDefault()
              // Guard double-submit ourselves — the input stays enabled
              // across creates so rapid Enter-driven entry keeps flowing.
              if (busy) return
              onCreate(childTitle.trim())
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onAddingChange(false)
              onChildTitleChange('')
            }
          }}
        />
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-fit justify-start text-muted-foreground"
          onClick={() => onAddingChange(true)}
        >
          <Plus size={13} aria-hidden="true" /> Add sub-task
        </Button>
      )}
    </section>
  )
}
