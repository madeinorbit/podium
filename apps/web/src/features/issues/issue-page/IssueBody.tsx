/**
 * The issue's own text: inline-editable title, the at-a-glance status strip, the
 * description, the agent brief, and the long-form spec fields. Split out of
 * IssuePage.tsx (POD-646); the editors and their commit semantics are unchanged.
 */

import { relativeTime } from '@podium/client-core/focus'
import { isPendingSync, isUpstreamStale, isViaHub } from '@podium/model'
import { Pin, Plus } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { STAGE_LABELS } from '../issue-card'
import { StageGlyph } from '../issue-glyphs'
import type { IssuePageCommands } from '../issue-page-commands'
import { SectionHeading, StatusChip } from './chrome'

/** Inline-editable title. `editing` is owned by the page so Escape-to-board and
 *  the issue-switch reset stay in one place. */
export function IssueTitle({
  issue,
  busy,
  editing,
  onEditingChange,
  onCommit,
}: {
  issue: IssueViewModel
  busy: boolean
  editing: boolean
  onEditingChange: (editing: boolean) => void
  onCommit: (value: string) => void
}): JSX.Element {
  if (editing) {
    return (
      <Input
        key={`title-${issue.id}`}
        defaultValue={issue.title}
        aria-label="Task title"
        autoFocus
        disabled={busy}
        className="mb-2 h-auto font-semibold text-[22px] tracking-tight"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onCommit(e.currentTarget.value)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onEditingChange(false)
          }
        }}
        onBlur={(e) => onCommit(e.currentTarget.value)}
      />
    )
  }
  return (
    <button
      data-pressable
      type="button"
      className="mb-2 block w-full break-words text-left font-semibold text-[22px] text-foreground leading-snug tracking-tight hover:opacity-80"
      onClick={() => onEditingChange(true)}
      title="Click to edit title"
    >
      {issue.title}
    </button>
  )
}

/** Inline-editable description. Cmd/Ctrl+Enter commits; Escape cancels. */
export function IssueDescription({
  issue,
  busy,
  editing,
  onEditingChange,
  onCommit,
}: {
  issue: IssueViewModel
  busy: boolean
  editing: boolean
  onEditingChange: (editing: boolean) => void
  onCommit: (value: string) => void
}): JSX.Element {
  return (
    <section className="mb-7">
      {editing ? (
        <Textarea
          key={`desc-${issue.id}`}
          defaultValue={issue.description}
          aria-label="Task description"
          autoFocus
          disabled={busy}
          className="min-h-[120px] text-[13px]"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              onCommit(e.currentTarget.value)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onEditingChange(false)
            }
          }}
          onBlur={(e) => onCommit(e.currentTarget.value)}
        />
      ) : (
        <button
          data-pressable
          type="button"
          className={cn(
            'block w-full whitespace-pre-wrap break-words text-left text-[13px] leading-relaxed',
            issue.description
              ? 'text-foreground/85 hover:text-foreground'
              : 'text-muted-foreground/70 italic hover:text-foreground',
          )}
          onClick={() => onEditingChange(true)}
          title="Click to edit description"
        >
          {issue.description || 'Add a description…'}
        </button>
      )}
    </section>
  )
}

/** The agent brief, collapsed by default — long, and written for agents. */
export function IssueBrief({ issue }: { issue: IssueViewModel }): JSX.Element | null {
  if (!issue.brief) return null
  return (
    <details className="mb-7 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
      <summary className="cursor-pointer font-medium text-[12px] text-muted-foreground">
        Brief
      </summary>
      <div className="mt-2 whitespace-pre-wrap break-words text-[12px] text-foreground/80 leading-relaxed">
        {issue.brief}
      </div>
    </details>
  )
}

/**
 * The at-a-glance dossier line under the title: workflow state (with closed
 * reason), lifecycle flags (draft / pinned / archived), provenance (agent-created,
 * internal audience), hub-sync state, and freshness (created / updated). These are
 * the row-level facts agents stamp that previously never surfaced on the page.
 */
export function StatusStrip({ issue }: { issue: IssueViewModel }): JSX.Element {
  const now = Date.now()
  const created = relativeTime(issue.createdAt, now)
  const updated = relativeTime(issue.updatedAt, now)
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5" data-testid="status-strip">
      <StatusChip>
        <StageGlyph stage={issue.stage} size={12} />
        {issue.closedReason ? `Closed · ${issue.closedReason}` : STAGE_LABELS[issue.stage]}
      </StatusChip>
      <StatusChip>{issue.type}</StatusChip>
      {issue.draft && <StatusChip tone="sky">draft</StatusChip>}
      {issue.pinned && (
        <StatusChip tone="amber">
          <Pin size={10} aria-hidden="true" /> pinned
        </StatusChip>
      )}
      {issue.archived && <StatusChip>archived</StatusChip>}
      {issue.origin === 'agent' && (
        <StatusChip tone="violet" title="Created by an agent">
          agent-created
        </StatusChip>
      )}
      {issue.audience === 'agent' && (
        <StatusChip tone="violet" title="Agent-internal working detail — kept off the board">
          internal
        </StatusChip>
      )}
      {/* Replica PROVENANCE, read through the envelope accessors rather than off
          the entity (POD-304). Identical rendering — the point is that when
          POD-308 nests the carrier under an `envelope` key, this indicator does
          not have to be found and changed again. */}
      {isViaHub(issue) && (
        <StatusChip
          tone={isUpstreamStale(issue) ? 'amber' : 'sky'}
          title={
            isUpstreamStale(issue)
              ? 'Mirrored from an unreachable hub — last-known state'
              : isPendingSync(issue)
                ? 'Edit queued for the hub — shown optimistically'
                : 'Mirrored from this node’s upstream hub'
          }
        >
          {isUpstreamStale(issue) ? 'hub · stale' : isPendingSync(issue) ? 'hub · syncing' : 'hub'}
        </StatusChip>
      )}
      {(created || updated) && (
        <span className="ml-1 text-[11px] text-muted-foreground/70">
          {created && <span title={issue.createdAt}>created {created}</span>}
          {created && updated && ' · '}
          {updated && <span title={issue.updatedAt}>updated {updated}</span>}
        </span>
      )}
    </div>
  )
}

const LONG_FORM_FIELDS = [
  { field: 'design', label: 'Design' },
  { field: 'acceptance', label: 'Acceptance' },
  { field: 'notes', label: 'Notes' },
] as const

type LongFormField = (typeof LONG_FORM_FIELDS)[number]['field']

/**
 * Design / Acceptance / Notes — the long-form spec fields agents fill via
 * `podium issue update`. Filled fields render as full sections (inline-editable,
 * same pattern as the description); empty ones collapse into one quiet add-row.
 */
export function LongFormFields({
  issue,
  busy,
  commands,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssuePageCommands
}): JSX.Element | null {
  const [editing, setEditing] = useState<LongFormField | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => setEditing(null), [issue.id])

  const filled = LONG_FORM_FIELDS.filter(({ field }) => (issue[field] ?? '').trim() !== '')
  const empty = LONG_FORM_FIELDS.filter(({ field }) => (issue[field] ?? '').trim() === '')

  const commit = (field: LongFormField, value: string): void => {
    setEditing(null)
    commands.commitLongForm(field, value)
  }

  return (
    <div data-testid="long-form-fields">
      {filled.map(({ field, label }) => (
        <section key={field} className="mb-7 flex flex-col gap-1.5">
          <SectionHeading>{label}</SectionHeading>
          {editing === field ? (
            <Textarea
              key={`${field}-${issue.id}`}
              defaultValue={issue[field] ?? ''}
              aria-label={`Task ${field}`}
              autoFocus
              disabled={busy}
              className="min-h-[100px] text-[13px]"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  commit(field, e.currentTarget.value)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditing(null)
                }
              }}
              onBlur={(e) => commit(field, e.currentTarget.value)}
            />
          ) : (
            <button
              data-pressable
              type="button"
              className="block w-full whitespace-pre-wrap break-words text-left text-[13px] text-foreground/85 leading-relaxed hover:text-foreground"
              onClick={() => setEditing(field)}
              title={`Click to edit ${field}`}
            >
              {issue[field]}
            </button>
          )}
        </section>
      ))}
      {empty.length > 0 && (
        <div className="mb-7 flex flex-wrap items-center gap-1">
          {empty.map(({ field, label }) =>
            editing === field ? (
              <Textarea
                key={`${field}-${issue.id}`}
                defaultValue=""
                aria-label={`Task ${field}`}
                autoFocus
                disabled={busy}
                placeholder={`Add ${label.toLowerCase()}…`}
                className="min-h-[100px] w-full text-[13px]"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    commit(field, e.currentTarget.value)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setEditing(null)
                  }
                }}
                onBlur={(e) => commit(field, e.currentTarget.value)}
              />
            ) : (
              <Button
                key={field}
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[12px] text-muted-foreground"
                disabled={busy}
                onClick={() => setEditing(field)}
              >
                <Plus size={12} aria-hidden="true" /> {label}
              </Button>
            ),
          )}
        </div>
      )}
    </div>
  )
}
