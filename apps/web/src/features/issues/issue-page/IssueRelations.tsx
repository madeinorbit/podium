/**
 * THE DEPENDENCY GRAPH SECTION — and the concrete site of §3.1.2's open
 * cross-boundary-edge question (POD-646).
 *
 * Every entry here is an edge to another issue: blocks, blocked-by, related.
 * Before the port each one was `byId.get(entry.id)`, and a miss rendered the raw
 * id as an inert label — which is `not-visible` rendered as `removed`, the exact
 * defect §3.1's rule 1 forbids. Each entry now resolves through the issues
 * slice's `resolveIssueEdge` and renders per this surface's declared policy; see
 * ./issue-edges.tsx, which holds the single call site for that policy and the
 * argument for the shipped choice.
 *
 * REMOVING an edge stays possible for every state, including opaque. The
 * relation is stored on THIS issue, so removing it is a write to a row the
 * principal already holds — it does not require seeing the other end, and
 * withholding the control would strand a blocker nobody can clear.
 *
 * AGENT NOTES are NOT edges. `blockedByNotes` / `dependencyNote` are free text
 * an agent wrote; they name nothing resolvable and are rendered as prose, kept
 * visually distinct from the real graph exactly as before.
 *
 * `blockedByNotes` was called `blockedBy` on the wire until POD-1530, which is
 * precisely the confusion this block's heading exists to undo — the old name
 * read like the dependency list two sections up. The key now says what it
 * holds.
 */

import { groupRelations } from '@podium/client-core/viewmodels'
import type { IssueId } from '@podium/model'
import { ISSUE_DEP_TYPES } from '@podium/model'
import { Plus, X } from 'lucide-react'
import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import { PropertyMenu, type PropertyOption } from '@/lib/PropertyMenu'
import { StageGlyph } from '../issue-glyphs'
import type { IssuePageCommands } from '../issue-page-commands'
import { MACHINE_LABEL, SectionHeading } from './chrome'
import { edgeIssue, IssueEdgeLink, useIssueEdgeResolver } from './issue-edges'

export function IssueRelations({
  issue,
  busy,
  commands,
  mateOptions,
  hasMates,
  addRelType,
  onAddRelTypeChange,
  onNavigate,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssuePageCommands
  mateOptions: PropertyOption[]
  hasMates: boolean
  addRelType: string
  onAddRelTypeChange: (type: string) => void
  onNavigate: (id: IssueId) => void
}): JSX.Element {
  const resolve = useIssueEdgeResolver()
  const relations = groupRelations(issue)
  return (
    <section className="group/section flex flex-col gap-2">
      <SectionHeading>Relations</SectionHeading>
      {relations.length === 0 && !issue.dependencyNote && issue.blockedByNotes.length === 0 && (
        <p className="text-[11px] text-text-faint">No links to other tasks.</p>
      )}
      {relations.map((group) => (
        <div key={group.section} className="flex flex-col gap-0.5">
          <span className={MACHINE_LABEL}>{group.section}</span>
          {group.entries.map((entry) => {
            const edge = resolve(entry.id)
            // A `hidden` edge draws nothing — under a `hidden` policy, and for a
            // genuinely deleted target, there is no edge to show. The REMOVE
            // control goes with it: an entry with no visible subject would be a
            // bare X with nothing beside it.
            if (edge.render === 'hidden') return null
            const target = edgeIssue(edge)
            return (
              <div
                key={`${group.section}-${entry.direction}-${entry.id}`}
                className="group -mx-1.5 flex min-h-[24px] items-center justify-between gap-2 rounded-[4.8px] px-1.5 transition-colors hover:bg-accent"
              >
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px]">
                  {target && <StageGlyph stage={target.stage} size={12} />}
                  <IssueEdgeLink edge={edge} onNavigate={onNavigate} fallbackId={entry.id} />
                </span>
                <button
                  data-pressable
                  type="button"
                  data-hover-reveal
                  aria-label={`Remove relation ${entry.type} ${entry.id}`}
                  title="Remove relation"
                  disabled={busy}
                  className="shrink-0 rounded-sm text-muted-foreground/60 opacity-0 hover:text-foreground disabled:opacity-50 group-hover:opacity-100"
                  onClick={() => commands.removeRelation(entry)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>
      ))}
      {/* Agent-noted soft blockers (issues.blocked_by / dependency_note) —
          free-text notes, distinct from the real dependency graph above. */}
      {(issue.blockedByNotes.length > 0 || issue.dependencyNote) && (
        <div
          className="flex flex-col gap-0.5 rounded-md border border-border border-dashed bg-muted/20 px-2 py-1.5"
          data-testid="agent-blockers"
        >
          <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
            Agent notes
          </span>
          {issue.blockedByNotes.map((b) => (
            <span key={b} className="break-words text-[12px] text-muted-foreground">
              blocked by: {b}
            </span>
          ))}
          {issue.dependencyNote && (
            <span className="break-words text-[12px] text-muted-foreground">
              {issue.dependencyNote}
            </span>
          )}
        </div>
      )}
      {hasMates && (
        <div className="flex items-center gap-1.5">
          <PropertyMenu
            selectedValue={addRelType}
            options={ISSUE_DEP_TYPES.filter((t) => t !== 'parent-child' && t !== 'supersedes').map(
              (t) => ({ value: t, label: t }),
            )}
            onSelect={onAddRelTypeChange}
            trigger={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                className="h-7 gap-1 px-2 text-[12px]"
              >
                {addRelType}
              </Button>
            }
          />
          <PropertyMenu
            options={mateOptions}
            placeholder="Add relation…"
            onSelect={(v) => commands.addRelation(addRelType, v)}
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                className="h-7 gap-1 px-2 text-[12px] text-muted-foreground"
              >
                <Plus size={12} aria-hidden="true" /> Add relation
              </Button>
            }
          />
        </div>
      )}
    </section>
  )
}
