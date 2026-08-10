/**
 * The issue's own text: inline-editable title, the at-a-glance status strip, the
 * description, the agent brief, and the long-form spec fields. Split out of
 * IssuePage.tsx (POD-646); the editors and their commit semantics are unchanged.
 */

import { relativeTime } from '@podium/client-core/focus'
import { isPendingSync, isUpstreamStale, isViaHub } from '@podium/model'
import { ChevronRight, Pin, Plus } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { IssuePageCommands } from '../issue-page-commands'
import { MACHINE_LABEL, SectionHeading, StatusChip } from './chrome'

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
        className="mb-2 h-auto font-semibold text-[22px] leading-[1.25] tracking-[-0.018em]"
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
      className="mb-2 block w-full break-words text-left font-semibold text-[22px] text-foreground leading-[1.25] tracking-[-0.018em] transition-colors hover:text-foreground/80"
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
    <section className="group/section mb-9">
      {editing ? (
        <Textarea
          key={`desc-${issue.id}`}
          defaultValue={issue.description}
          aria-label="Task description"
          autoFocus
          disabled={busy}
          className="min-h-[120px] text-[14.5px] leading-[1.6]"
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
            'block w-full whitespace-pre-wrap break-words text-left text-[14.5px] leading-[1.6]',
            issue.description
              ? 'text-foreground/90 hover:text-foreground'
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
    // Collapsed by default and framed by hairlines rather than a box: the brief
    // is long, written FOR an agent, and sits between two things a human reads.
    // A bordered card here made the page's least-read text its loudest object.
    <details className="mb-9 border-border/60 border-y py-2.5" data-testid="issue-brief">
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <span className={MACHINE_LABEL}>Brief</span>
        <span className="text-[11px] text-text-faint">written for the agent</span>
        <ChevronRight
          size={12}
          aria-hidden="true"
          className="ml-auto text-text-faint transition-transform group-open:rotate-90 [details[open]>summary>&]:rotate-90"
        />
      </summary>
      <div className="mt-3 whitespace-pre-wrap break-words text-[13px] text-muted-foreground leading-[1.6]">
        {issue.brief}
      </div>
    </details>
  )
}

/**
 * THE DOSSIER LINE under the title — one line of machine voice, plus a chip for
 * each EXCEPTION.
 *
 * It used to be nine pills of equal weight: stage, type, draft, pinned,
 * archived, agent-created, internal, hub state, and a timestamp pair. Nine
 * emphasised things emphasise nothing, and the two facts an operator actually
 * reads here — what stage is this, and how stale is it — were the hardest to
 * find in the row.
 *
 * The rule now: the rail owns ordinary editable properties (stage, type,
 * priority, assignee). The line keeps recency plus EXCEPTIONS (draft, pinned,
 * archived, agent-created, internal, a stale hub mirror), because a chip means
 * "this one is not like the others". One fact, one home.
 */
export function StatusStrip({ issue }: { issue: IssueViewModel }): JSX.Element {
  const now = Date.now()
  const created = relativeTime(issue.createdAt, now)
  const updated = relativeTime(issue.updatedAt, now)
  const facts: { key: string; text: string; title?: string }[] = [
    ...(issue.closedReason ? [{ key: 'closed', text: `Closed · ${issue.closedReason}` }] : []),
    ...(created ? [{ key: 'created', text: `created ${created}`, title: issue.createdAt }] : []),
    ...(updated ? [{ key: 'updated', text: `updated ${updated}`, title: issue.updatedAt }] : []),
  ]
  return (
    <div
      className="mb-8 flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[10.5px] text-text-dim tabular-nums"
      data-testid="status-strip"
    >
      {facts.map((fact, index) => (
        <span key={fact.key} className="flex items-center gap-1.5">
          {index > 0 && (
            <span aria-hidden="true" className="text-text-faint">
              ·
            </span>
          )}
          <span title={fact.title}>{fact.text}</span>
        </span>
      ))}
      {issue.draft && <StatusChip tone="sky">draft</StatusChip>}
      {issue.pinned && (
        <StatusChip tone="amber">
          <Pin size={9} aria-hidden="true" /> pinned
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
        <section key={field} className="group/section mb-9 flex flex-col gap-2">
          <SectionHeading tone="narrative">{label}</SectionHeading>
          {editing === field ? (
            <Textarea
              key={`${field}-${issue.id}`}
              defaultValue={issue[field] ?? ''}
              aria-label={`Task ${field}`}
              autoFocus
              disabled={busy}
              className="min-h-[100px] text-[14.5px] leading-[1.6]"
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
              className="block w-full whitespace-pre-wrap break-words text-left text-[14.5px] text-foreground/90 leading-[1.6] hover:text-foreground"
              onClick={() => setEditing(field)}
              title={`Click to edit ${field}`}
            >
              {issue[field]}
            </button>
          )}
        </section>
      ))}
      {empty.length > 0 && (
        <div className="mb-9 flex flex-wrap items-center gap-1">
          {empty.map(({ field, label }) =>
            editing === field ? (
              <Textarea
                key={`${field}-${issue.id}`}
                defaultValue=""
                aria-label={`Task ${field}`}
                autoFocus
                disabled={busy}
                placeholder={`Add ${label.toLowerCase()}…`}
                className="min-h-[100px] w-full text-[14.5px] leading-[1.6]"
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
