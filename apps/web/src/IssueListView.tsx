import type { IssueStage, IssueWire } from '@podium/protocol'
import { Plus } from 'lucide-react'
import type { JSX } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { issueCardModel, STAGE_LABELS } from './issue-card'
import { AssigneeAvatar, PriorityGlyph, StageGlyph } from './issue-glyphs'
import { groupIssuesByStage } from './issue-list'
import type { IssuesDisplay } from './issues-display'

/** Linear-style list: rows grouped by stage under sticky group headers. */
export function IssueListView({
  issues,
  display,
  onOpen,
  onCreateIn,
}: {
  issues: IssueWire[]
  display: IssuesDisplay
  onOpen: (id: string) => void
  onCreateIn: (stage: IssueStage) => void
}): JSX.Element {
  const groups = groupIssuesByStage(issues, display.ordering)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="issues-list">
      {groups.map(({ stage, issues: members }) =>
        members.length === 0 ? null : (
          <section key={stage} aria-label={STAGE_LABELS[stage]}>
            <div className="group sticky top-0 z-10 flex items-center gap-1.5 border-border border-b bg-muted/60 px-4 py-1.5 backdrop-blur">
              <StageGlyph stage={stage} />
              <h3 className="font-medium text-[13px]">{STAGE_LABELS[stage]}</h3>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {members.length}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="ml-auto size-5 opacity-0 group-hover:opacity-100"
                title={`New issue in ${STAGE_LABELS[stage]}`}
                aria-label={`New issue in ${STAGE_LABELS[stage]}`}
                onClick={() => onCreateIn(stage)}
              >
                <Plus size={13} aria-hidden="true" />
              </Button>
            </div>
            {members.map((issue) => {
              const m = issueCardModel(issue)
              return (
                <button
                  key={issue.id}
                  type="button"
                  className="flex w-full items-center gap-2 border-border/50 border-b px-4 py-2 text-left hover:bg-muted/40"
                  onClick={() => onOpen(issue.id)}
                >
                  <PriorityGlyph priority={issue.priority} />
                  <span className="w-10 shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {m.seqLabel}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{m.title}</span>
                  {display.badges.labels &&
                    m.labels.slice(0, 2).map((l) => (
                      <Badge
                        key={l}
                        variant="secondary"
                        className="hidden font-normal md:inline-flex"
                      >
                        {l}
                      </Badge>
                    ))}
                  {display.badges.due && m.dueLabel && (
                    <span className="hidden text-[11px] text-muted-foreground md:inline">
                      {m.dueLabel}
                    </span>
                  )}
                  <span className="hidden text-[11px] text-muted-foreground md:inline">
                    {new Date(issue.updatedAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                  <AssigneeAvatar assignee={m.assignee} />
                </button>
              )
            })}
          </section>
        ),
      )}
    </div>
  )
}
