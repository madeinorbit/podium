/**
 * The Linear-style properties aside for the issue page — a stack of labelled
 * `PropertyMenu` / inline rows, then relations, sessions, git, and the About
 * block. Rendered in the desktop `<aside>` and mirrored inside the mobile
 * `Details` disclosure.
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
 * All mutations still go through the named commands in
 * `../issue-page-commands.ts`; the pure derivations still come from
 * `../issue-page-model.ts`.
 */
import { shallowEqual } from '@podium/client-core'
import { ISSUE_STAGES, type IssueId, IssueType } from '@podium/model'
import { ExternalLink, Plus, X } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { type IssueViewModel, useReplicaIssues, useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { IssueAbout } from './IssueAbout'
import { IssueGitBlock } from './IssueGitBlock'
import { useIssueEdgeResolver } from './issue-edges'
import { IssueParentRow } from './IssueParentRow'
import { IssueRelations } from './IssueRelations'
import { IssueSessionsBlock } from './IssueSessionsBlock'
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
  const [deferDate, setDeferDate] = useState('')
  // Relation add is two steps: pick a dep type, then a target issue.
  const [addRelType, setAddRelType] = useState('blocks')

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => {
    setDeferDate('')
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col">
        {/* Status */}
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

        {/* Priority */}
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

        {/* Assignee */}
        <PropertyRow label="Assignee">
          <PropertyMenu
            allowFreeText
            selectedValue={issue.assignee || UNASSIGNED}
            options={assigneeOptions}
            placeholder="Assign to…"
            onSelect={(v) => commands.update({ assignee: v === UNASSIGNED ? '' : v })}
            trigger={
              <TriggerButton disabled={busy}>
                {issue.assignee || <span className="text-muted-foreground">Unassigned</span>}
              </TriggerButton>
            }
          />
        </PropertyRow>

        {/* Type */}
        <PropertyRow label="Type">
          <PropertyMenu
            selectedValue={issue.type}
            options={IssueType.options.map((t) => ({ value: t, label: t }))}
            onSelect={(v) => commands.update({ type: v as IssueType })}
            trigger={<TriggerButton disabled={busy}>{issue.type}</TriggerButton>}
          />
        </PropertyRow>

        {/* Labels */}
        <PropertyRow label="Labels">
          <div className="flex flex-wrap items-center gap-1.5">
            {issue.labels.map((label) => (
              <span
                key={label}
                className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/5 py-0.5 pr-1 pl-1.5 text-[11px] text-primary"
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
                  <X size={11} aria-hidden="true" />
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
                  className="h-6 gap-1 px-1.5 text-[12px] text-muted-foreground"
                >
                  <Plus size={12} aria-hidden="true" /> Add
                </Button>
              }
            />
          </div>
        </PropertyRow>

        {/* Estimate (minutes) */}
        <PropertyRow label="Estimate">
          <Input
            key={`estimate-${issue.id}`}
            type="number"
            min={0}
            defaultValue={issue.estimateMin ?? ''}
            placeholder="minutes"
            aria-label="Estimate (minutes)"
            disabled={busy}
            className="h-7 max-w-[120px]"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.currentTarget.blur()
              }
            }}
            onBlur={(e) => {
              const raw = e.currentTarget.value.trim()
              if (raw === '') return
              const n = Number(raw)
              if (!Number.isInteger(n) || n === (issue.estimateMin ?? null)) return
              commands.update({ estimateMin: n })
            }}
          />
        </PropertyRow>

        {/* Due date */}
        <PropertyRow label="Due">
          <div className="flex items-center gap-1.5">
            <Input
              key={`due-${issue.id}`}
              type="date"
              defaultValue={issue.dueAt ? issue.dueAt.slice(0, 10) : ''}
              aria-label="Due date"
              disabled={busy}
              className="h-7 max-w-[150px]"
              onChange={(e) => commands.setDueDate(e.currentTarget.value)}
            />
            {issue.dueAt && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Clear due date"
                aria-label="Clear due date"
                disabled={busy}
                onClick={() => commands.setDueDate('')}
              >
                <X size={13} aria-hidden="true" />
              </Button>
            )}
          </div>
        </PropertyRow>

        {/* Defer */}
        <PropertyRow label="Defer">
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              type="date"
              value={deferDate}
              aria-label="Defer until"
              disabled={busy}
              className="h-7 max-w-[150px]"
              onChange={(e) => setDeferDate(e.target.value)}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7"
              disabled={busy || !deferDate}
              onClick={() => commands.defer(deferDate, () => setDeferDate(''))}
            >
              Defer
            </Button>
            {issue.deferUntil && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7"
                disabled={busy}
                onClick={commands.undefer}
              >
                Unsnooze
              </Button>
            )}
          </div>
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

        {/* Linear (integration link — identifier + click-through) */}
        {(issue.linearUrl || issue.linearIdentifier) && (
          <PropertyRow label="Linear">
            {issue.linearUrl ? (
              <a
                href={issue.linearUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 pt-1 text-[13px] text-primary hover:underline"
              >
                {issue.linearIdentifier ?? 'Open'} <ExternalLink size={12} aria-hidden="true" />
              </a>
            ) : (
              <span className="block pt-1 text-[13px]">{issue.linearIdentifier}</span>
            )}
          </PropertyRow>
        )}
      </div>

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

      <IssueSessionsBlock
        issue={issue}
        busy={busy}
        commands={commands}
        memberSessions={memberSessions}
        movedOn={movedOn}
        machines={machines}
        onOpenSession={openSession}
      />

      <IssueGitBlock issue={issue} busy={busy} commands={commands} mergeStyle={mergeStyle} />

      <IssueAbout issue={issue} />
    </div>
  )
}

/** Re-exported for the call sites that used to import it from the properties
 *  module; the component itself now lives with the sessions block it belongs to. */
export { IssueAgentAction } from './IssueSessionsBlock'
