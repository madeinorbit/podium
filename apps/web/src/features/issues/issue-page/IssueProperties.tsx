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
 * near the top while being empty on nearly every task. The order follows the
 * questions an operator actually asks, in order:
 *
 *   what state is it in    → the property head
 *   who is working it      → sessions
 *   where is the branch    → git
 *   what does it touch     → parent + relations
 *   where it came from     → Origin
 *
 * -------------------------------------------------------------------------
 * POD-1163: ONE COLUMN, ONE RHYTHM, AND NO FOLD OVER THE LONG TAIL.
 * -------------------------------------------------------------------------
 *
 * THE COLUMN. Every value in this rail starts at the same x: a 72px label
 * column plus a 12px gap. It did not before — the label chips' add button sat
 * 6px right of it, the parent trigger 8px right of that, and the About block
 * ran its own 80px label column 4px right again. Four value columns inside
 * 272px is what "a bit all over the place" looks like from the outside, and no
 * single one of them was wrong enough to notice on its own. {@link PropertyRow}
 * now owns the measurement and every band uses it.
 *
 * THE RHYTHM. Each band is `px-5 py-4`, and a band's heading sits 8px above its
 * content — 32px between bands against 8px inside one, which is the contrast
 * that makes the rail read as five answers rather than one long form. The head
 * band was `pt-5 pb-3` and the Origin block drew the rail's only horizontal
 * rule; both are gone.
 *
 * THE LONG TAIL. "More fields" was a fold that opened itself whenever it had
 * anything in it — so it was a disclosure that mostly disclosed nothing, and a
 * heading over an empty box on every ordinary task. POD-1163 replaced it with a
 * `+ Add property` menu at the foot of the head band; POD-1224 removed that too.
 * Estimate, Due, Snooze and Type are now purely DISPLAY: a row when the field is
 * set (editable and clearable there), and nothing at all when it is not. The
 * rail's job on an ordinary task is to answer five questions, and a permanent
 * control for four fields that almost no task carries was the fifth thing on
 * screen competing with them. Setting one from empty is `podium issue update`
 * (estimate / due / defer / type) — the same route the agents already use.
 *
 * All mutations still go through the named commands in
 * `../issue-page-commands.ts`; the pure derivations still come from
 * `../issue-page-model.ts`.
 */
import { shallowEqual } from '@podium/client-core'
import {
  type IssueId,
  IssueType,
  issueStatusLabel,
  issueStatusMenuEntries,
  issueStatusOf,
  issueStatusValueOf,
  parseIssueStatusValue,
} from '@podium/model/browser'
import { Plus, X } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { type IssueViewModel, useReplicaIssues, useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { PropertyMenu, type PropertyOption } from '@/lib/PropertyMenu'
import { cn } from '@/lib/utils'
import { PriorityGlyph, StatusGlyph } from '../issue-glyphs'
import type { IssueCloseReason } from '../issue-lifecycle'
import type { IssuePageCommands } from '../issue-page-commands'
import { labelPoolOf, mateOptionsOf, repoMatesOf, useMergeStyle } from '../issue-page-model'
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

  // ---- Status (POD-1074): ONE list, ordered by category with a rule wherever
  // the category changes, exactly as the dock and the board context menu render
  // it. Picking a lane on a closed issue reopens it; the endings are guarded by
  // the shared close dialog mounted on the full page.
  //
  // `groupKey`, not `group`: the rules are drawn, the categories are NOT written
  // out. A heading here would have to say something over `Done`, and every word
  // available ("Closed") lumps it in with Cancelled — the one fusion Linear's
  // status model exists to prevent. The glyphs already say it. ----
  const statusOptions: PropertyOption[] = issueStatusMenuEntries().map((entry) => ({
    value: entry.value,
    label: entry.label,
    icon: <StatusGlyph status={entry.status} />,
    groupKey: entry.outcome,
  }))

  // A long-tail property earns a row when it is SET, and never otherwise
  // (POD-1224) — see the module note's LONG TAIL section.
  const shows = (key: LongTailKey): boolean => {
    if (key === 'estimate') return issue.estimateMin != null
    if (key === 'due') return issue.dueAt != null
    if (key === 'defer') return issue.deferUntil != null
    return issue.type !== 'task'
  }

  return (
    <div className="flex flex-col">
      <RailSection>
        <PropertyRow label="Status">
          <PropertyMenu
            selectedValue={issueStatusValueOf(issue)}
            options={statusOptions}
            onSelect={(value) => {
              const intent = parseIssueStatusValue(value)
              if (intent?.kind === 'close') onRequestClose(intent.reason)
              else commands.selectStatus(value)
            }}
            trigger={
              <TriggerButton disabled={busy} testId="status-trigger">
                <StatusGlyph status={issueStatusOf(issue)} />
                {issueStatusLabel(issue)}
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

        {/* NO ASSIGNEE ROW (POD-1163). Work here is placed on AGENTS, in
            sessions, from the Sessions band below — the free-text assignee was
            a second, disconnected answer to "who is working this" that nothing
            else on the page read. The field survives on the wire and on the
            board; the rail no longer offers a second place to set it. */}

        <PropertyRow label="Labels">
          {/* `-ml-1.5` on the add button, so its glyph starts on the same value
              column the pickers above do — the chips wrap around it and the
              column survives an empty label set. */}
          <div className="-ml-1.5 flex flex-wrap items-center gap-1">
            {issue.labels.map((label) => (
              <span
                key={label}
                className="ml-1.5 inline-flex items-center gap-1 rounded-[4px] bg-primary/10 py-px pr-1 pl-1.5 text-[11px] text-primary"
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
                // Every `+ Add` in the rail is one control: 28px, 12px, faint.
                // These ran 11px/h-6 here, 12px/muted in Relations and 12px
                // faint at the foot of this band — three treatments of one
                // affordance inside 272px.
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className="h-7 gap-1 px-1.5 text-[12px] text-text-faint"
                >
                  <Plus size={12} aria-hidden="true" /> Add
                </Button>
              }
            />
          </div>
        </PropertyRow>

        {shows('type') && (
          <PropertyRow label="Type">
            <PropertyMenu
              selectedValue={issue.type}
              options={IssueType.options.map((t) => ({ value: t, label: t }))}
              onSelect={(v) => commands.update({ type: v as IssueType })}
              trigger={<TriggerButton disabled={busy}>{issue.type}</TriggerButton>}
            />
          </PropertyRow>
        )}

        {shows('estimate') && (
          <PropertyRow label="Estimate">
            <EstimateProperty
              value={issue.estimateMin}
              disabled={busy}
              onSelect={(minutes) => commands.update({ estimateMin: minutes })}
              onClear={() => commands.update({ estimateMin: null })}
            />
          </PropertyRow>
        )}

        {shows('due') && (
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
        )}

        {shows('defer') && (
          <PropertyRow label="Snooze">
            <DateProperty
              value={issue.deferUntil}
              placeholder="Snooze until…"
              ariaLabel="Defer until"
              disabled={busy}
              onSelect={(value) => commands.defer(value, () => {})}
              {...(issue.deferUntil ? { onClear: commands.undefer } : {})}
            />
          </PropertyRow>
        )}
      </RailSection>

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

      <RailSection gap="loose">
        <IssueParentRow
          issue={issue}
          parentEdge={resolve(issue.parentId)}
          busy={busy}
          mateOptions={mateOptions}
          matesById={matesById}
          onSetParent={(id) => commands.setParent(id)}
          onNavigate={onNavigate}
        />
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
        <IssueAbout issue={issue} />
      </RailSection>
    </div>
  )
}

/** The long-tail properties: a row each when SET, nothing when not. */
type LongTailKey = 'estimate' | 'due' | 'defer' | 'type'

/** ONE BAND OF THE RAIL, ONE RHYTHM (POD-1163).
 *
 *  Every band — including the property head, which used to run `pt-5 pb-3` —
 *  is `px-5 py-4`, so the gap between two bands is always 32px against the 8px
 *  a band spends between its own heading and its content. No band draws a rule:
 *  repeated dividers made the secondary column feel like a settings table, and
 *  a single divider (the Origin block had the rail's only one) reads as a
 *  mistake rather than as structure. */
function RailSection({
  children,
  /** `loose` puts a heading's own 16px above it when a band holds two blocks
   *  rather than one — the parent row followed by Relations. Property rows
   *  inside a band stack flush; they carry their own 30px. */
  gap = 'flush',
}: {
  children: ReactNode
  gap?: 'flush' | 'loose'
}): JSX.Element {
  return <div className={cn('flex flex-col px-5 py-4', gap === 'loose' && 'gap-4')}>{children}</div>
}
