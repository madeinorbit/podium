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
import { issueIdTitle } from '../issue-card'
import { AssigneeAvatar, StageGlyph } from '../issue-glyphs'
import { SectionHeading } from './chrome'

/** A child is DONE for the fold when the issue slice's own finished predicate
 *  says so — `stage === 'done'` or a recorded close reason. */
function isFinished(child: IssueViewModel): boolean {
  return child.stage === 'done' || child.closedReason != null
}

export function IssueSubIssues({
  issue,
  children,
  busy,
  addingChild,
  childTitle,
  onAddingChange,
  onChildTitleChange,
  onCreate,
  onNavigate,
}: {
  issue: IssueViewModel
  children: IssueViewModel[]
  busy: boolean
  addingChild: boolean
  childTitle: string
  onAddingChange: (adding: boolean) => void
  onChildTitleChange: (title: string) => void
  onCreate: (title: string) => void
  onNavigate: (id: IssueId) => void
}): JSX.Element {
  const doneChildren = children.filter(isFinished)
  const openChildren = children.filter((child) => !isFinished(child))
  return (
    <section className="mb-7 flex flex-col gap-1" data-testid="sub-issues">
      <SectionHeading
        count={issue.childCount > 0 ? `${issue.childDoneCount}/${issue.childCount}` : undefined}
      >
        Sub-tasks
      </SectionHeading>
      {openChildren.map((c) => (
        <button
          data-pressable
          key={c.id}
          type="button"
          className={cn(
            'flex items-center gap-2 rounded px-1.5 py-1 text-left text-[13px] hover:bg-muted/50',
            c.archived && 'opacity-60',
          )}
          title={issueIdTitle(c)}
          onClick={() => onNavigate(c.id)}
        >
          <StageGlyph stage={c.stage} />
          <span className="text-[11px] text-muted-foreground">{issueDisplayRef(c)}</span>
          <span className="min-w-0 flex-1 truncate">{c.title}</span>
          {c.archived && (
            <span className="flex-none rounded border px-1 text-[9px] text-muted-foreground uppercase tracking-wide">
              archived
            </span>
          )}
          <AssigneeAvatar assignee={c.assignee || undefined} size={16} />
        </button>
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
