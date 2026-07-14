import { shallowEqual } from '@podium/client-core'
import type { IssuePanelArtifact, IssueWire } from '@podium/protocol'
import {
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDot,
  ExternalLink,
  FileText,
  Flag,
  FlagOff,
  GitBranch,
  GitMerge,
  Link2,
  type LucideIcon,
  Mail,
  MoreHorizontal,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Unlock,
} from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { MediaLightbox } from '@/components/MediaLightbox'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { copyToClipboard } from '@/lib/clipboard'
import { artifactKind, basename, worktreeAssetUrl } from '@/lib/dock-panel'
import { relativeTime } from '@/lib/home'
import { cn } from '@/lib/utils'
import { issueIdTitle, STAGE_LABELS } from './issue-card'
import type { IssueEventIcon } from './issue-events'
import { AssigneeAvatar, StageGlyph } from './issue-glyphs'
import {
  type IssueMailMessage,
  type IssuePageCommands,
  issuePageCommands,
} from './issue-page-commands'
import { repoMatesOf, useIssuePageModel } from './issue-page-model'
import { IssueProperties } from './issue-page-properties'

/**
 * The full issue page — an in-view (not overlay) replacement for the detail
 * drawer. A header with breadcrumb + prev/next + overflow menu, a scrolling main
 * column (banners → inline-editable title → status strip → description →
 * long-form spec fields → agent panel → sub-issues → mail → activity feed), and
 * a desktop-only properties aside. The `issue` prop is the live store row, so it
 * re-renders as `issuesChanged` broadcasts land.
 * Navigation re-points `openIssueId` via `onNavigate`; `onBack` clears it.
 *
 * Split (P5d, issue #264): what to show comes from `useIssuePageModel`, every
 * mutation is a named command in `issue-page-commands.ts`, and the properties
 * aside lives in `issue-page-properties.tsx` — this file is composition + JSX.
 */
export function IssuePage({
  issue,
  orderedIds,
  onBack,
  onNavigate,
}: {
  issue: IssueWire
  orderedIds: string[]
  onBack: () => void
  onNavigate: (id: string) => void
}): JSX.Element {
  const model = useIssuePageModel(issue, orderedIds)
  const { busy, toast, run, prev, next, repoName, feed, mail, children } = model
  const commands = issuePageCommands({ trpc: model.trpc, issue, run })

  const [commentBody, setCommentBody] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [addingChild, setAddingChild] = useState(false)
  const [childTitle, setChildTitle] = useState('')

  // Reset transient compose/edit state on issue switch so a half-typed comment or
  // an open editor never carries across to the next issue.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => {
    setCommentBody('')
    setEditingTitle(false)
    setEditingDesc(false)
    setAddingChild(false)
    setChildTitle('')
  }, [issue.id])

  // Post the composed comment, appending it optimistically so it shows without
  // waiting for the broadcast round-trip (the commentCount-keyed refetch then
  // replaces the local copy with server truth).
  const postComment = (): void => {
    const body = commentBody.trim()
    if (!body) return
    commands.postComment(body, (posted) => {
      model.appendLocalComment(posted)
      setCommentBody('')
    })
  }

  // Escape returns to the board — but not while an editor/menu is open (Esc there
  // cancels the local edit), nor while a form field is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const el = document.activeElement as HTMLElement | null
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      )
        return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  const commitTitle = (value: string): void => {
    setEditingTitle(false)
    commands.commitTitle(value)
  }

  const commitDescription = (value: string): void => {
    setEditingDesc(false)
    commands.commitDescription(value)
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="issue-page">
      <header className="flex items-center gap-2 border-border border-b px-4 py-2.5">
        <Button type="button" variant="ghost" size="icon-sm" title="Back" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden="true" />
        </Button>
        <span className="text-[13px] text-muted-foreground">{repoName}</span>
        <span className="text-[13px] text-muted-foreground">›</span>
        <button
          type="button"
          className="cursor-pointer rounded font-medium text-[13px] hover:text-primary"
          title={`${issue.id} — click to copy "#${issue.seq}"`}
          onClick={() => copyToClipboard(`#${issue.seq}`, `Copied #${issue.seq}`)}
        >
          #{issue.seq}
        </button>
        {/* The internal id agents quote in transcripts/CLI output — shown so it can
            be matched by eye, click-to-copy for pasting into commands (#21). */}
        <button
          type="button"
          className="max-w-44 cursor-pointer truncate rounded font-mono text-[11px] text-muted-foreground/70 hover:text-foreground"
          title={`${issue.id} — click to copy`}
          onClick={() => copyToClipboard(issue.id, 'Copied internal issue id')}
        >
          {issue.id}
        </button>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Previous issue"
            disabled={!prev}
            onClick={() => prev && onNavigate(prev)}
          >
            <ChevronUp size={15} aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Next issue"
            disabled={!next}
            onClick={() => next && onNavigate(next)}
          >
            <ChevronDown size={15} aria-hidden="true" />
          </Button>
          <IssueOverflowMenu issue={issue} busy={busy} commands={commands} onDeleted={onBack} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-5 md:px-8">
            {/* ---- Banners ---- */}
            {issue.deletedAt && (
              <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-[13px]">
                <p>
                  This issue and its sessions were deleted. Restoring it returns the sessions as
                  exited records; their running processes were stopped.
                </p>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => commands.restoreIssue(onBack)}
                >
                  <ArchiveRestore size={14} aria-hidden="true" /> Restore issue
                </Button>
              </div>
            )}
            <LifecycleBanner issue={issue} onNavigate={onNavigate} />
            {issue.suggestedStage && (
              <div className="mb-4 flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-[13px]">
                <p className="text-foreground">
                  Move to <b>{STAGE_LABELS[issue.suggestedStage]}</b>?
                  {issue.suggestedReason ? ` ${issue.suggestedReason}` : ''}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={commands.applySuggestion}
                  >
                    Approve
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={commands.dismissSuggestion}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            )}

            {issue.needsHuman && (
              <div className="mb-4 flex flex-col gap-2 rounded-lg border border-amber-500/60 bg-amber-500/10 p-3">
                <p className="font-medium text-[12px] text-amber-600 uppercase tracking-wide dark:text-amber-400">
                  Needs human
                </p>
                <p className="break-words text-[13px] text-foreground">
                  {issue.humanQuestion || 'Needs a human decision'}
                </p>
                <Button
                  type="button"
                  size="sm"
                  className="w-fit"
                  disabled={busy}
                  onClick={commands.resolveNeedsHuman}
                >
                  Resolve
                </Button>
              </div>
            )}

            {/* ---- Title (inline edit) ---- */}
            {editingTitle ? (
              <Input
                key={`title-${issue.id}`}
                defaultValue={issue.title}
                aria-label="Issue title"
                autoFocus
                disabled={busy}
                className="mb-2 h-auto font-semibold text-[22px] tracking-tight"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitTitle(e.currentTarget.value)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setEditingTitle(false)
                  }
                }}
                onBlur={(e) => commitTitle(e.currentTarget.value)}
              />
            ) : (
              <button
                type="button"
                className="mb-2 block w-full break-words text-left font-semibold text-[22px] text-foreground leading-snug tracking-tight hover:opacity-80"
                onClick={() => setEditingTitle(true)}
                title="Click to edit title"
              >
                {issue.title}
              </button>
            )}

            <StatusStrip issue={issue} />

            {/* ---- Description (inline edit) ---- */}
            <section className="mb-7">
              {editingDesc ? (
                <Textarea
                  key={`desc-${issue.id}`}
                  defaultValue={issue.description}
                  aria-label="Issue description"
                  autoFocus
                  disabled={busy}
                  className="min-h-[120px] text-[13px]"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      commitDescription(e.currentTarget.value)
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setEditingDesc(false)
                    }
                  }}
                  onBlur={(e) => commitDescription(e.currentTarget.value)}
                />
              ) : (
                <button
                  type="button"
                  className={cn(
                    'block w-full whitespace-pre-wrap break-words text-left text-[13px] leading-relaxed',
                    issue.description
                      ? 'text-foreground/85 hover:text-foreground'
                      : 'text-muted-foreground/70 italic hover:text-foreground',
                  )}
                  onClick={() => setEditingDesc(true)}
                  title="Click to edit description"
                >
                  {issue.description || 'Add a description…'}
                </button>
              )}
            </section>

            {/* ---- Long-form spec fields (design / acceptance / notes) ----
                Written by agents via `podium issue update`; empty ones collapse
                into a single quiet add-row so the page stays short. */}
            <LongFormFields issue={issue} busy={busy} commands={commands} />

            {/* ---- Agent panel: todos / artifacts / deferred (issues.panel) ---- */}
            <PanelSections issue={issue} busy={busy} commands={commands} />

            {/* ---- Sub-issues ---- */}
            <section className="mb-7 flex flex-col gap-1" data-testid="sub-issues">
              <SectionHeading
                count={
                  issue.childCount > 0 ? `${issue.childDoneCount}/${issue.childCount}` : undefined
                }
              >
                Sub-issues
              </SectionHeading>
              {children.map((c) => (
                <button
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
                  <span className="text-[11px] text-muted-foreground">#{c.seq}</span>
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {c.archived && (
                    <span className="flex-none rounded border px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                      archived
                    </span>
                  )}
                  <AssigneeAvatar assignee={c.assignee || undefined} size={16} />
                </button>
              ))}
              {addingChild ? (
                <Input
                  autoFocus
                  placeholder="Sub-issue title…"
                  aria-label="Sub-issue title"
                  value={childTitle}
                  onChange={(e) => setChildTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && childTitle.trim()) {
                      e.preventDefault()
                      // Guard double-submit ourselves — the input stays enabled
                      // across creates so rapid Enter-driven entry keeps flowing.
                      if (busy) return
                      commands.createSubIssue(childTitle.trim())
                      setChildTitle('')
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setAddingChild(false)
                      setChildTitle('')
                    }
                  }}
                />
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-fit justify-start text-muted-foreground"
                  onClick={() => setAddingChild(true)}
                >
                  <Plus size={13} aria-hidden="true" /> Add sub-issue
                </Button>
              )}
            </section>

            {/* ---- Agent mail (issue #103) ---- */}
            <MailSection mail={mail} />

            {/* ---- Properties (mobile) — the desktop aside is hidden <md, so mirror
                  its rows in a collapsible disclosure above the activity feed. ---- */}
            <details
              className="mb-4 rounded-lg border border-border md:hidden"
              data-testid="issue-details-mobile"
            >
              <summary className="cursor-pointer select-none px-3 py-2 font-medium text-[13px] text-foreground">
                Details
              </summary>
              <div className="border-border border-t px-3 py-2">
                <IssueProperties
                  issue={issue}
                  busy={busy}
                  commands={commands}
                  onNavigate={onNavigate}
                />
              </div>
            </details>

            {/* ---- Activity ---- */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <SectionHeading>Activity</SectionHeading>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title="Refresh AI notes"
                  disabled={busy}
                  onClick={commands.refreshAssistant}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                </Button>
              </div>

              {issue.activityNotes && (
                <div className="flex flex-col gap-0.5 rounded-lg border border-border border-dashed bg-muted/30 p-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                      Assistant
                    </span>
                    {issue.notesUpdatedAt && (
                      <span
                        className="text-[10px] text-muted-foreground/70"
                        title={issue.notesUpdatedAt}
                      >
                        {relativeTime(issue.notesUpdatedAt, Date.now())}
                      </span>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
                    {issue.activityNotes}
                  </p>
                </div>
              )}

              {feed.length > 0 && (
                <div className="flex flex-col gap-2" data-testid="activity-feed">
                  {feed.map((item) =>
                    item.kind === 'comment' ? (
                      <div
                        key={item.id}
                        className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/40 p-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-[12px] text-foreground">
                            {item.author}
                          </span>
                          <span className="text-[11px] text-muted-foreground">{item.ts}</span>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
                          {item.body}
                        </p>
                      </div>
                    ) : (
                      <ActivityEvent
                        key={item.id}
                        icon={item.line.icon}
                        text={item.line.text}
                        ts={item.ts}
                      />
                    ),
                  )}
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Textarea
                  value={commentBody}
                  placeholder="Add a comment…"
                  aria-label="Add a comment"
                  disabled={busy}
                  className="min-h-[60px] text-[13px]"
                  onChange={(e) => setCommentBody(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && commentBody.trim()) {
                      e.preventDefault()
                      postComment()
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  className="w-fit"
                  disabled={busy || commentBody.trim().length === 0}
                  onClick={postComment}
                >
                  Post
                </Button>
              </div>
            </section>
          </div>
        </div>

        <aside
          data-testid="issue-aside"
          className="hidden w-[280px] shrink-0 overflow-y-auto border-border border-l px-4 py-4 md:block"
        >
          <IssueProperties issue={issue} busy={busy} commands={commands} onNavigate={onNavigate} />
        </aside>
      </div>

      {toast && (
        <div
          className={cn(
            'border-border border-t px-4 py-2 text-[12px]',
            'whitespace-pre-wrap break-words text-muted-foreground',
          )}
          role="status"
        >
          {toast}
        </div>
      )}
    </div>
  )
}

/** Uniform small-caps section heading; `count` renders as a quiet tabular badge. */
function SectionHeading({ children, count }: { children: ReactNode; count?: string }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <h3 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
        {children}
      </h3>
      {count !== undefined && (
        <span className="font-mono text-[11px] text-muted-foreground/70 tabular-nums">{count}</span>
      )}
    </div>
  )
}

/** One quiet pill in the status strip. */
function StatusChip({
  children,
  tone = 'muted',
  title,
}: {
  children: ReactNode
  tone?: 'muted' | 'amber' | 'violet' | 'sky'
  title?: string
}): JSX.Element {
  const tones = {
    muted: 'border-border bg-muted/40 text-muted-foreground',
    amber: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    violet: 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400',
    sky: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  } as const
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
        tones[tone],
      )}
    >
      {children}
    </span>
  )
}

/**
 * The at-a-glance dossier line under the title: workflow state (with closed
 * reason), lifecycle flags (draft / pinned / archived), provenance (agent-created,
 * internal audience), hub-sync state, and freshness (created / updated). These are
 * the row-level facts agents stamp that previously never surfaced on the page.
 */
function StatusStrip({ issue }: { issue: IssueWire }): JSX.Element {
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
      {issue.viaHub && (
        <StatusChip
          tone={issue.upstreamStale ? 'amber' : 'sky'}
          title={
            issue.upstreamStale
              ? 'Mirrored from an unreachable hub — last-known state'
              : issue.pendingSync
                ? 'Edit queued for the hub — shown optimistically'
                : 'Mirrored from this node’s upstream hub'
          }
        >
          {issue.upstreamStale ? 'hub · stale' : issue.pendingSync ? 'hub · syncing' : 'hub'}
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

/** Superseded-by / duplicate-of banner — the stored relation values were only
 *  settable before; now the current state reads back, with click-through. */
function LifecycleBanner({
  issue,
  onNavigate,
}: {
  issue: IssueWire
  onNavigate: (id: string) => void
}): JSX.Element | null {
  const issues = useStoreSelector((s) => s.issues)
  const link = (id: string, verb: string): JSX.Element => {
    const target = issues.find((i) => i.id === id)
    return (
      <p className="text-[13px] text-foreground">
        {verb}{' '}
        <button
          type="button"
          className="font-medium text-primary hover:underline"
          onClick={() => target && onNavigate(id)}
          title={id}
        >
          {target ? `#${target.seq} ${target.title}` : id}
        </button>
      </p>
    )
  }
  if (!issue.supersededBy && !issue.duplicateOf) return null
  return (
    <div className="mb-4 flex flex-col gap-1 rounded-lg border border-border bg-muted/30 p-3">
      {issue.supersededBy && link(issue.supersededBy, 'Superseded by')}
      {issue.duplicateOf && link(issue.duplicateOf, 'Duplicate of')}
    </div>
  )
}

const LONG_FORM_FIELDS = [
  { field: 'design', label: 'Design' },
  { field: 'acceptance', label: 'Acceptance' },
  { field: 'notes', label: 'Notes' },
] as const

/**
 * Design / Acceptance / Notes — the long-form spec fields agents fill via
 * `podium issue update`. Filled fields render as full sections (inline-editable,
 * same pattern as the description); empty ones collapse into one quiet add-row.
 */
function LongFormFields({
  issue,
  busy,
  commands,
}: {
  issue: IssueWire
  busy: boolean
  commands: IssuePageCommands
}): JSX.Element | null {
  const [editing, setEditing] = useState<'design' | 'acceptance' | 'notes' | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => setEditing(null), [issue.id])

  const filled = LONG_FORM_FIELDS.filter(({ field }) => (issue[field] ?? '').trim() !== '')
  const empty = LONG_FORM_FIELDS.filter(({ field }) => (issue[field] ?? '').trim() === '')

  const commit = (field: 'design' | 'acceptance' | 'notes', value: string): void => {
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
              aria-label={`Issue ${field}`}
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
                aria-label={`Issue ${field}`}
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

/**
 * The agent-published panel (issues.panel): todos with a progress bar (checkable
 * from here — same 1-based index API the dock uses), artifacts with inline
 * image/video previews + lightbox, and deferred items. Previously this data only
 * surfaced in the right-dock Issue tab; the detail page now shows it too.
 * Sections render only when non-empty — an issue with no panel adds no chrome.
 */
function PanelSections({
  issue,
  busy,
  commands,
}: {
  issue: IssueWire
  busy: boolean
  commands: IssuePageCommands
}): JSX.Element | null {
  const { httpOrigin, openFileInWorktree } = useStoreSelector(
    (s) => ({ httpOrigin: s.httpOrigin, openFileInWorktree: s.openFileInWorktree }),
    shallowEqual,
  )
  const [lightbox, setLightbox] = useState<{
    kind: 'image' | 'video'
    src: string
    label: string
  } | null>(null)

  const todos = issue.panel?.todos ?? []
  const artifacts = issue.panel?.artifacts ?? []
  const deferred = issue.panel?.deferred ?? []
  if (todos.length === 0 && artifacts.length === 0 && deferred.length === 0) return null

  const doneCount = todos.filter((t) => t.done).length
  // An issue with no dedicated worktree is worked in the repo's primary
  // checkout — serve its artifacts from there.
  const root = issue.worktreePath ?? issue.repoPath

  const openArtifact = (a: IssuePanelArtifact): void => {
    // Artifact paths may be worktree-relative; file tabs need absolute.
    openFileInWorktree({
      machineId: issue.machineId,
      root,
      path: a.path.startsWith('/') ? a.path : `${root}/${a.path}`,
    })
  }

  return (
    <div data-testid="issue-panel-sections">
      {todos.length > 0 && (
        <section className="mb-7 flex flex-col gap-1.5">
          <SectionHeading count={`${doneCount}/${todos.length}`}>Todo</SectionHeading>
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-success/80 transition-[width] duration-300"
              style={{ width: `${(doneCount / todos.length) * 100}%` }}
            />
          </div>
          <div className="flex flex-col gap-0.5">
            {todos.map((t, i) => (
              // biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox inside renders a Base UI role=checkbox button, which biome can't see as a control
              <label
                // biome-ignore lint/suspicious/noArrayIndexKey: todos are positional (1-based index API)
                key={i}
                className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-[13px] hover:bg-muted/50"
              >
                <Checkbox
                  checked={t.done}
                  disabled={busy}
                  onCheckedChange={(checked) => commands.toggleTodo(i + 1, checked === true)}
                  className="mt-0.5"
                />
                <span
                  className={cn(
                    t.done
                      ? 'text-muted-foreground line-through decoration-muted-foreground/40'
                      : 'text-foreground',
                  )}
                >
                  {t.text}
                </span>
              </label>
            ))}
          </div>
        </section>
      )}

      {artifacts.length > 0 && (
        <section className="mb-7 flex flex-col gap-2" data-testid="issue-artifacts">
          <SectionHeading count={String(artifacts.length)}>Artifacts</SectionHeading>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {artifacts.map((a) => {
              const kind = artifactKind(a.path)
              const label = a.title ?? basename(a.path)
              const added = relativeTime(a.addedAt, Date.now())
              if (kind === 'image' || kind === 'video') {
                const src = worktreeAssetUrl({
                  httpOrigin,
                  root,
                  path: a.path,
                  machineId: issue.machineId,
                })
                return (
                  <figure key={a.path}>
                    <button
                      type="button"
                      className="group relative block w-full cursor-zoom-in"
                      title={kind === 'image' ? `View ${label} full size` : `Play ${label}`}
                      onClick={() => setLightbox({ kind, src, label })}
                    >
                      {kind === 'image' ? (
                        <img
                          src={src}
                          alt={label}
                          className="max-h-56 w-full rounded-md border border-border object-cover shadow-sm"
                        />
                      ) : (
                        <>
                          <video
                            src={src}
                            preload="metadata"
                            muted
                            className="pointer-events-none max-h-56 w-full rounded-md border border-border object-cover shadow-sm"
                          />
                          <span className="absolute inset-0 flex items-center justify-center">
                            <span className="flex size-9 items-center justify-center rounded-full bg-black/55 text-white transition-colors group-hover:bg-black/75">
                              <Play size={16} aria-hidden="true" className="translate-x-px" />
                            </span>
                          </span>
                        </>
                      )}
                    </button>
                    <figcaption className="mt-1 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
                      <span className="min-w-0 truncate">{label}</span>
                      {added && (
                        <span className="flex-none text-muted-foreground/60" title={a.addedAt}>
                          {added}
                        </span>
                      )}
                    </figcaption>
                  </figure>
                )
              }
              return (
                <Button
                  key={a.path}
                  variant="ghost"
                  size="sm"
                  className="h-auto w-full justify-start gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-left font-normal hover:bg-accent/60 sm:col-span-2"
                  onClick={() => openArtifact(a)}
                >
                  <FileText size={14} aria-hidden="true" className="flex-none text-primary/70" />
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px]">
                    {label}
                  </span>
                  <span className="flex-none font-mono text-[10px] text-muted-foreground/60">
                    {basename(a.path)}
                  </span>
                </Button>
              )
            })}
          </div>
        </section>
      )}

      {deferred.length > 0 && (
        <section className="mb-7 flex flex-col gap-1" data-testid="issue-deferred">
          <SectionHeading count={String(deferred.length)}>Deferred</SectionHeading>
          {deferred.map((d) => (
            <div
              key={`${d.addedAt}:${d.text}`}
              className="flex items-baseline gap-2 rounded px-1 py-0.5 text-[13px] text-foreground/80"
            >
              <span className="size-1 flex-none translate-y-[-2px] rounded-full bg-amber-400/70" />
              <span className="min-w-0 flex-1">{d.text}</span>
              <span className="flex-none font-mono text-[10px] text-muted-foreground/60">
                {new Date(d.addedAt).toLocaleDateString()}
              </span>
            </div>
          ))}
        </section>
      )}

      {lightbox && <MediaLightbox {...lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}

/** Agent mail addressed to this issue (issue #103) — durable messages other
 *  agents sent to whoever works it. Read-only operator view; listing here never
 *  consumes the recipient's unread status. */
function MailSection({ mail }: { mail: IssueMailMessage[] }): JSX.Element | null {
  if (mail.length === 0) return null
  const now = Date.now()
  return (
    <section className="mb-7 flex flex-col gap-1.5" data-testid="issue-mail">
      <SectionHeading count={String(mail.length)}>Mail</SectionHeading>
      {mail.map((m) => (
        <div
          key={m.id}
          className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/20 p-2"
        >
          <div className="flex items-center gap-2">
            <Mail
              size={12}
              aria-hidden="true"
              className={cn('flex-none', m.status === 'unread' ? 'text-primary' : 'opacity-50')}
            />
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {m.fromAuthor}
            </span>
            {m.status === 'unread' && (
              <span className="rounded-full bg-primary/10 px-1.5 text-[10px] text-primary">
                unread
              </span>
            )}
            {m.status === 'claimed' && m.claimedBy && (
              <span
                className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground"
                title={`Claimed by ${m.claimedBy}`}
              >
                claimed · {m.claimedBy}
              </span>
            )}
            <span
              className="ml-auto flex-none text-[11px] text-muted-foreground/70"
              title={m.createdAt}
            >
              {relativeTime(m.createdAt, now)}
            </span>
          </div>
          <p className="whitespace-pre-wrap break-words pl-5 text-[13px] text-foreground/85">
            {m.body}
          </p>
        </div>
      ))}
    </section>
  )
}

/** Glyph per event-line kind (the pure formatter returns a stable `icon` key so
 *  it stays JSX-free and unit-testable; the mapping to a real icon lives here). */
const EVENT_ICONS: Record<IssueEventIcon, LucideIcon> = {
  created: CircleDot,
  moved: ArrowRight,
  closed: CheckCircle2,
  started: Play,
  attached: Link2,
  cleaned: Trash2,
  flagged: Flag,
  cleared: FlagOff,
  ready: Unlock,
  integration: GitMerge,
  generic: Circle,
}

/** One compact, muted state-transition line in the activity feed. */
function ActivityEvent({
  icon,
  text,
  ts,
}: {
  icon: IssueEventIcon
  text: string
  ts: string
}): JSX.Element {
  const Icon = EVENT_ICONS[icon] ?? EVENT_ICONS.generic
  return (
    <div
      className="flex items-center gap-2 px-1 py-0.5 text-[12px] text-muted-foreground"
      data-testid="activity-event"
    >
      <Icon size={13} aria-hidden="true" className="shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 break-words">{text}</span>
      <span className="shrink-0 text-[11px] opacity-70">{ts}</span>
    </div>
  )
}

/**
 * The header `…` overflow menu: copy branch name, open in Linear, pin/unpin,
 * flag for human (via `window.prompt`), supersede/duplicate against a sibling
 * issue, and delete. Actions that don't apply to this issue (no branch, no
 * Linear url, no siblings) are omitted. `commands` is the page's named-command
 * set (toast-wrapping runner included); `onDeleted` returns to the board after
 * a confirmed delete.
 */
function IssueOverflowMenu({
  issue,
  busy,
  commands,
  onDeleted,
}: {
  issue: IssueWire
  busy: boolean
  commands: IssuePageCommands
  onDeleted: () => void
}): JSX.Element {
  const issues = useStoreSelector((s) => s.issues)
  // Sibling issues in the same repo — targets for supersede/duplicate.
  const targetIssues = repoMatesOf(issues, issue)

  const flagForHuman = (): void => {
    const q = window.prompt('Flag for human — question (optional):')
    if (q === null) return // cancelled
    const question = q.trim()
    commands.flagForHuman(question || undefined)
  }

  const handleDelete = (): void => {
    const sessionCount = issue.sessions.length
    const message = `Delete "#${issue.seq} ${issue.title}" and ${sessionCount} session${sessionCount === 1 ? '' : 's'}? The issue and sessions can be restored; running processes will be stopped.`
    if (!window.confirm(message)) return
    commands.deleteIssue(onDeleted)
  }
  const handleRestore = (): void => commands.restoreIssue(onDeleted)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type="button" variant="ghost" size="icon-sm" title="More actions" disabled={busy}>
            <MoreHorizontal size={16} aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-52">
        {issue.branch && (
          <DropdownMenuItem
            onClick={() => copyToClipboard(issue.branch ?? '', 'Copied branch name')}
          >
            <GitBranch size={14} aria-hidden="true" /> Copy branch name
          </DropdownMenuItem>
        )}
        {issue.linearUrl && (
          <DropdownMenuItem
            onClick={() => window.open(issue.linearUrl, '_blank', 'noopener,noreferrer')}
          >
            <ExternalLink size={14} aria-hidden="true" /> Open in Linear
            {issue.linearIdentifier ? ` (${issue.linearIdentifier})` : ''}
          </DropdownMenuItem>
        )}
        {!issue.deletedAt && (
          <DropdownMenuItem onClick={commands.togglePinned}>
            {issue.pinned ? (
              <>
                <PinOff size={14} aria-hidden="true" /> Unpin
              </>
            ) : (
              <>
                <Pin size={14} aria-hidden="true" /> Pin
              </>
            )}
          </DropdownMenuItem>
        )}
        {!issue.deletedAt && (
          <DropdownMenuItem onClick={flagForHuman}>
            <Flag size={14} aria-hidden="true" /> Flag for human…
          </DropdownMenuItem>
        )}
        {!issue.deletedAt && targetIssues.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Supersede with…</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                {targetIssues.map((t) => (
                  <DropdownMenuItem key={t.id} onClick={() => commands.supersedeWith(t.id)}>
                    #{t.seq} {t.title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Duplicate of…</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                {targetIssues.map((t) => (
                  <DropdownMenuItem key={t.id} onClick={() => commands.duplicateOf(t.id)}>
                    #{t.seq} {t.title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
        <DropdownMenuSeparator />
        {issue.deletedAt ? (
          <DropdownMenuItem onClick={handleRestore}>
            <ArchiveRestore size={14} aria-hidden="true" /> Restore issue
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onClick={handleDelete}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 size={14} aria-hidden="true" /> Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
