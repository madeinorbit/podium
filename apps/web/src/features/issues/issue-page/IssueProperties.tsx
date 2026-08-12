/**
 * The properties rail for the issue page. Rendered in the desktop `<aside>` and
 * mirrored inside the mobile `Details` disclosure.
 *
 * This file is COMPOSITION. POD-646 split the 821-line
 * `issue-page-properties.tsx` by the question each part answers rather than by
 * size: the parent row owns the reparent-scope decision (./IssueParentRow.tsx),
 * the dependency graph owns cross-boundary edges (./IssueRelations.tsx),
 * sessions own placement (./IssueSessionsBlock.tsx), git owns the merge-style
 * ordering (./IssueGitBlock.tsx), and About owns owner/visibility display
 * (./IssueAbout.tsx). Each of those has a reason to change that the others do
 * not, which is why they are separate files and not one file with headings.
 *
 * POD-591 RANKED IT. It used to be a flat form — ten property rows of identical
 * weight, then relations, sessions, git and About — so Status and Estimate
 * looked equally important, and Estimate / Due / Defer took three permanent rows
 * near the top while being empty on nearly every task. The order now follows the
 * questions an operator actually asks, in order:
 *
 *   what state is it in, and whose is it   → the property head
 *   who is working it                      → sessions
 *   where is the branch                    → git
 *   what does it touch                     → relations
 *   the long tail                          → "More fields", folded
 *   provenance                             → About
 *
 * NOTHING WAS REMOVED. "More fields" holds exactly what used to sit inline, and
 * it opens by default whenever any of those fields is set, so a task that HAS an
 * estimate or a due date still shows it without a click.
 *
 * All mutations still go through the named commands in
 * `../issue-page-commands.ts`; the pure derivations still come from
 * `../issue-page-model.ts`.
 */
import { shallowEqual } from '@podium/client-core'
import { ISSUE_STAGES, type IssueId, IssueType } from '@podium/model'
import { ChevronRight, ExternalLink, Plus, X } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { type IssueViewModel, useReplicaIssues, useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { PropertyMenu, type PropertyOption } from '@/lib/PropertyMenu'
import { STAGE_LABELS } from '../issue-card'
import { PriorityGlyph, StageGlyph } from '../issue-glyphs'
import type { IssueCloseReason } from '../issue-lifecycle'
import type { IssuePageCommands } from '../issue-page-commands'
import {
  assigneeOptionsOf,
  labelPoolOf,
  mateOptionsOf,
  repoMatesOf,
  UNASSIGNED,
  useMergeStyle,
} from '../issue-page-model'
import { MACHINE_LABEL } from './chrome'
import { DateProperty, EstimateProperty } from './DateProperty'
import { IssueAbout } from './IssueAbout'
import { IssueGitBlock } from './IssueGitBlock'
import { IssueParentRow } from './IssueParentRow'
import { IssueRelations } from './IssueRelations'
import { IssueSessionsBlock } from './IssueSessionsBlock'
import { useIssueEdgeResolver } from './issue-edges'
import { PropertyRow, TriggerButton } from './property-chrome'

/** The properties stack. `commands` is the page's named-command set (all
 *  mutations run through its toast-wrapping runner); `onNavigate` re-points the
 *  open issue (parent / relation click-through). */
export function IssueProperties({
  issue,
  busy,
  commands,
  onNavigate,
  onRequestClose,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssuePageCommands
  onNavigate: (id: IssueId) => void
  onRequestClose: (reason: IssueCloseReason) => void
}): JSX.Element {
  const { trpc, machines, sessions, navigateToSession } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      sessions: s.sessions,
      machines: s.machines,
      navigateToSession: s.navigateToSession,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const resolve = useIssueEdgeResolver()
  const memberSessions = (issue.memberSessionIds ?? [])
    .map((id) => sessions.find((session) => session.sessionId === id))
    .filter((session) => session !== undefined)
  const mergeStyle = useMergeStyle(trpc)
  // Relation add is two steps: pick a dep type, then a target issue.
  const [addRelType, setAddRelType] = useState('blocks')

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => {
    setAddRelType('blocks')
  }, [issue.id])

  // Repo-mates: the pool for relations + parent, excluding self, seq-ordered.
  const repoMates = repoMatesOf(issues, issue)
  const matesById = new Map(repoMates.map((i) => [i.id as string, i]))
  const mateOptions = mateOptionsOf(repoMates)
  const assigneeOptions = assigneeOptionsOf(issues)
  const labelPool = labelPoolOf(issues, issue)

  // [spec:SP-a1c0] (#411) Route through the central action — never roll per-feature
  // navigation (setPane+setView flips the URL then reverts off the workspace view).
  const openSession = (session: { sessionId: (typeof sessions)[number]['sessionId'] }): void => {
    navigateToSession(session.sessionId)
  }

  // Forwarding ghosts (POD-89): sessions BORN here (permanent refIssueId) that
  // re-homed elsewhere.
  const movedOn = (sessions ?? []).filter(
    (s) => s.refIssueId === issue.id && s.issueId != null && s.issueId !== issue.id && !s.archived,
  )

  // ---- Status: lifecycle stages reopen a closed issue; close choices are guarded
  // by the shared dialog mounted on the full page. ----
  const statusOptions: PropertyOption[] = [
    ...ISSUE_STAGES.map((s) => ({
      value: `stage:${s}`,
      label: STAGE_LABELS[s],
      icon: <StageGlyph stage={s} />,
    })),
    { value: 'close:done', label: 'Close: done' },
    { value: 'close:wontfix', label: 'Close: wontfix' },
  ]

  // The fold opens itself when it has something to say — see the module note.
  const hasLongTail =
    issue.type !== 'task' ||
    issue.parentId != null ||
    issue.estimateMin != null ||
    issue.dueAt != null ||
    issue.deferUntil != null ||
    Boolean(issue.linearUrl || issue.linearIdentifier)

  return (
    <div className="flex flex-col">
      <div className="flex flex-col px-5 pt-5 pb-3">
        <PropertyRow label="Status">
          <PropertyMenu
            selectedValue={`stage:${issue.stage}`}
            options={statusOptions}
            onSelect={(value) => {
              if (value === 'close:done') onRequestClose('done')
              else if (value === 'close:wontfix') onRequestClose('wontfix')
              else commands.selectStatus(value)
            }}
            trigger={
              <TriggerButton disabled={busy} testId="status-trigger">
                <StageGlyph stage={issue.stage} />
                {issue.closedReason ? `Closed — ${issue.closedReason}` : STAGE_LABELS[issue.stage]}
              </TriggerButton>
            }
          />
        </PropertyRow>

        <PropertyRow label="Priority">
          <PropertyMenu
            selectedValue={String(issue.priority)}
            options={[0, 1, 2, 3, 4].map((p) => ({
              value: String(p),
              label: `P${p}`,
              icon: <PriorityGlyph priority={p} />,
            }))}
            onSelect={(v) => commands.update({ priority: Number(v) })}
            trigger={
              <TriggerButton disabled={busy}>
                <PriorityGlyph priority={issue.priority} />P{issue.priority}
              </TriggerButton>
            }
          />
        </PropertyRow>

        <PropertyRow label="Assignee">
          <PropertyMenu
            allowFreeText
            selectedValue={issue.assignee || UNASSIGNED}
            options={assigneeOptions}
            placeholder="Assign to…"
            onSelect={(v) => commands.update({ assignee: v === UNASSIGNED ? '' : v })}
            trigger={
              <TriggerButton disabled={busy}>
                {issue.assignee || <span className="text-text-faint">Unassigned</span>}
              </TriggerButton>
            }
          />
        </PropertyRow>

        <PropertyRow label="Labels">
          <div className="flex flex-wrap items-center gap-1">
            {issue.labels.map((label) => (
              <span
                key={label}
                className="inline-flex items-center gap-1 rounded-[4px] bg-primary/10 py-px pr-1 pl-1.5 text-[11px] text-primary"
              >
                {label}
                <button
                  data-pressable
                  type="button"
                  aria-label={`Remove label ${label}`}
                  title={`Remove ${label}`}
                  disabled={busy}
                  className="rounded-sm text-primary/70 hover:text-primary disabled:opacity-50"
                  onClick={() => commands.removeLabel(label)}
                >
                  <X size={10} aria-hidden="true" />
                </button>
              </span>
            ))}
            <PropertyMenu
              allowFreeText
              options={labelPool.map((l) => ({ value: l, label: l }))}
              placeholder="Add label…"
              onSelect={commands.addLabel}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className="h-6 gap-1 px-1.5 text-[11px] text-text-faint"
                >
                  <Plus size={11} aria-hidden="true" /> Add
                </Button>
              }
            />
          </div>
        </PropertyRow>
      </div>

      <RailSection>
        <IssueSessionsBlock
          issue={issue}
          busy={busy}
          commands={commands}
          memberSessions={memberSessions}
          movedOn={movedOn}
          machines={machines}
          onOpenSession={openSession}
        />
      </RailSection>

      {issue.worktreePath && (
        <RailSection>
          <IssueGitBlock issue={issue} busy={busy} commands={commands} mergeStyle={mergeStyle} />
        </RailSection>
      )}

      <RailSection>
        <IssueRelations
          issue={issue}
          busy={busy}
          commands={commands}
          mateOptions={mateOptions}
          hasMates={repoMates.length > 0}
          addRelType={addRelType}
          onAddRelTypeChange={setAddRelType}
          onNavigate={onNavigate}
        />
      </RailSection>

      <RailSection>
        <details className="group/more" open={hasLongTail}>
          <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
            <ChevronRight
              size={11}
              aria-hidden="true"
              className="flex-none text-text-faint transition-transform group-open/more:rotate-90"
            />
            <span className={MACHINE_LABEL}>More fields</span>
            {!hasLongTail && (
              <span className="ml-auto font-mono text-[9px] text-text-faint">none set</span>
            )}
          </summary>
          <div className="mt-1 flex flex-col">
            <PropertyRow label="Type">
              <PropertyMenu
                selectedValue={issue.type}
                options={IssueType.options.map((t) => ({ value: t, label: t }))}
                onSelect={(v) => commands.update({ type: v as IssueType })}
                trigger={<TriggerButton disabled={busy}>{issue.type}</TriggerButton>}
              />
            </PropertyRow>

            <IssueParentRow
              issue={issue}
              parentEdge={resolve(issue.parentId)}
              busy={busy}
              mateOptions={mateOptions}
              matesById={matesById}
              onSetParent={(id) => commands.setParent(id)}
              onNavigate={onNavigate}
            />

            <PropertyRow label="Estimate">
              <EstimateProperty
                value={issue.estimateMin}
                disabled={busy}
                onSelect={(minutes) => commands.update({ estimateMin: minutes })}
                onClear={() => commands.update({ estimateMin: null })}
              />
            </PropertyRow>

            <PropertyRow label="Due">
              <DateProperty
                value={issue.dueAt}
                placeholder="No due date"
                ariaLabel="Due date"
                disabled={busy}
                onSelect={(value) => commands.setDueDate(value)}
                onClear={() => commands.setDueDate('')}
              />
            </PropertyRow>

            <PropertyRow label="Defer">
              <DateProperty
                value={issue.deferUntil}
                placeholder="Snooze until…"
                ariaLabel="Defer until"
                disabled={busy}
                onSelect={(value) => commands.defer(value, () => {})}
                {...(issue.deferUntil ? { onClear: commands.undefer } : {})}
              />
            </PropertyRow>

            {/* Linear (integration link — identifier + click-through) */}
            {(issue.linearUrl || issue.linearIdentifier) && (
              <PropertyRow label="Linear">
                {issue.linearUrl ? (
                  <a
                    href={issue.linearUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 pt-1 text-[12px] text-primary hover:underline"
                  >
                    {issue.linearIdentifier ?? 'Open'} <ExternalLink size={11} aria-hidden="true" />
                  </a>
                ) : (
                  <span className="block pt-1 text-[12px]">{issue.linearIdentifier}</span>
                )}
              </PropertyRow>
            )}
          </div>
        </details>
      </RailSection>

      <RailSection>
        <IssueAbout issue={issue} />
      </RailSection>
    </div>
  )
}

/** A quiet, whitespace-separated band of the rail. Repeated dividers made the
 *  secondary column feel like a settings table instead of supporting context. */
function RailSection({ children }: { children: ReactNode }): JSX.Element {
  return <div className="px-5 py-4">{children}</div>
}

/** Re-exported for the call sites that used to import it from the properties
 *  module; the component itself now lives with the sessions block it belongs to. */
export { IssueAgentAction } from './IssueSessionsBlock'
