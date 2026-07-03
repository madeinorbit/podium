import type { IssueStage } from '@podium/protocol'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import type { JSX } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { issueCardModel, STAGE_LABELS } from './issue-card'
import { AssigneeAvatar, PriorityGlyph, StageGlyph } from './issue-glyphs'
import { type IssueRow, isEpic } from './issue-hierarchy'
import type { IssuesDisplay } from './issues-display'

/**
 * Linear-style list: rows grouped by stage under sticky group headers. Rows come
 * pre-computed (`issueRowsByStage` in the parent) so the render, the keyboard
 * nav, and the flatten toggle all agree on the visible order. Parent rows with
 * children get a chevron that expands nested (indented) child rows.
 */
export function IssueListView({
  groups,
  display,
  onOpen,
  onCreateIn,
  focusId,
  selected,
  onToggleSelect,
  onToggleExpand,
}: {
  groups: { stage: IssueStage; rows: IssueRow[] }[]
  display: IssuesDisplay
  onOpen: (id: string) => void
  onCreateIn: (stage: IssueStage) => void
  focusId: string | null
  selected: string[]
  onToggleSelect: (id: string) => void
  onToggleExpand: (id: string) => void
}): JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="issues-list">
      {groups.map(({ stage, rows }) =>
        rows.length === 0 ? null : (
          <section key={stage} aria-label={STAGE_LABELS[stage]}>
            <div className="group sticky top-0 z-10 flex items-center gap-1.5 border-border border-b bg-muted/60 px-4 py-1.5 backdrop-blur">
              <StageGlyph stage={stage} />
              <h3 className="font-medium text-[13px]">{STAGE_LABELS[stage]}</h3>
              <span className="text-[11px] text-muted-foreground tabular-nums">{rows.length}</span>
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
            {rows.map(({ issue, depth, childCount, expanded }) => {
              const m = issueCardModel(issue)
              const epic = isEpic(issue)
              return (
                <button
                  key={issue.id}
                  type="button"
                  data-issue-id={issue.id}
                  className={cn(
                    'flex w-full items-center gap-2 border-border/50 border-b px-4 py-2 text-left hover:bg-muted/40',
                    focusId === issue.id && 'ring-2 ring-primary/60 ring-inset',
                    selected.includes(issue.id) && 'bg-primary/10',
                  )}
                  style={depth > 0 ? { paddingLeft: `${16 + depth * 22}px` } : undefined}
                  onClick={(e) => (e.shiftKey ? onToggleSelect(issue.id) : onOpen(issue.id))}
                >
                  {childCount > 0 ? (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: the row button handles keyboard; this is a pointer affordance (nested-button markup is invalid)
                    // biome-ignore lint/a11y/useSemanticElements: a real <button> here would nest inside the row's <button> (invalid markup) — same pattern as the card's AssigneeMenu trigger
                    <span
                      role="button"
                      tabIndex={-1}
                      className="-ml-1 flex-none rounded p-0.5 text-muted-foreground/70 hover:bg-muted hover:text-foreground"
                      aria-expanded={expanded}
                      aria-label={expanded ? `Collapse ${issue.title}` : `Expand ${issue.title}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleExpand(issue.id)
                      }}
                    >
                      {expanded ? (
                        <ChevronDown size={13} aria-hidden="true" />
                      ) : (
                        <ChevronRight size={13} aria-hidden="true" />
                      )}
                    </span>
                  ) : (
                    depth > 0 && (
                      // Child rows show their own stage glyph — a nested child may
                      // live in a different stage than the parent's group.
                      <StageGlyph stage={issue.stage} size={12} />
                    )
                  )}
                  <PriorityGlyph priority={issue.priority} />
                  <span className="w-10 shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {m.seqLabel}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{m.title}</span>
                  {epic && (
                    <Badge
                      variant="outline"
                      className="border-violet-500/50 font-normal text-violet-600 dark:text-violet-400"
                    >
                      Epic
                    </Badge>
                  )}
                  {m.subProgress && (
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {m.subProgress.done}/{m.subProgress.total}
                    </span>
                  )}
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
