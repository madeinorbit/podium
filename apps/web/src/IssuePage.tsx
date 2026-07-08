import { shallowEqual } from '@podium/client-core'
import {
  ISSUE_DEP_TYPES,
  ISSUE_STAGES,
  type IssueStage,
  IssueType,
  type IssueWire,
} from '@podium/protocol'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDot,
  Copy,
  ExternalLink,
  Flag,
  FlagOff,
  GitBranch,
  GitMerge,
  Link2,
  type LucideIcon,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Unlock,
  X,
} from 'lucide-react'
import type { ComponentProps, JSX, ReactNode } from 'react'
import { forwardRef, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
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
import { cn } from '@/lib/utils'
import { subIssuesOf } from './derive'
import {
  ISSUE_AGENT_KINDS,
  type IssueAgentKind,
  issueAgentDefaultLabel,
  issueAgentIcon,
  issueAgentLabel,
  issueDefaultAgentKind,
} from './issue-agents'
import { STAGE_LABELS } from './issue-card'
import {
  type ActivityComment,
  buildActivityFeed,
  type IssueEvent,
  type IssueEventIcon,
} from './issue-events'
import { AssigneeAvatar, PriorityGlyph, StageGlyph } from './issue-glyphs'
import { issueNeighbors } from './issue-page'
import { groupRelations } from './issue-relations'
import { EffortPicker, ModelPicker } from './ModelEffortPicker'
import { PropertyMenu, type PropertyOption } from './PropertyMenu'
import { useStoreSelector } from './store'
import { sessionDisplayName } from './WorkerLabel'

type MergeStyle = 'ff-only' | 'pr' | 'ask'

/**
 * The full issue page — an in-view (not overlay) replacement for the detail
 * drawer. A header with breadcrumb + prev/next + overflow menu, a scrolling main
 * column (banners → inline-editable title → inline-editable description →
 * activity feed), and a desktop-only properties aside (interim Stage select
 * until Task 9 lands the sidebar). The `issue` prop is the live store row, so it
 * re-renders as `issuesChanged` broadcasts land. Navigation re-points
 * `openIssueId` via `onNavigate`; `onBack` clears it.
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
  const { trpc, issues, hub } = useStoreSelector(
    (s) => ({ trpc: s.trpc, issues: s.issues, hub: s.hub }),
    shallowEqual,
  )
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)
  const [commentBody, setCommentBody] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [addingChild, setAddingChild] = useState(false)
  const [childTitle, setChildTitle] = useState('')
  const [events, setEvents] = useState<IssueEvent[]>([])
  const [comments, setComments] = useState<ActivityComment[]>([])

  // Reset transient compose/edit state on issue switch so a half-typed comment or
  // an open editor never carries across to the next issue.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => {
    setCommentBody('')
    setEditingTitle(false)
    setEditingDesc(false)
    setAddingChild(false)
    setChildTitle('')
    setToast('')
    // Seed from the (legacy, pre-#175) embedded thread if the wire still carries
    // one; the lazy fetch below replaces it with server truth.
    setComments(issue.comments ?? [])
  }, [issue.id])

  // Lazy comment fetch (#175): comment bodies no longer ride IssueWire — fetch
  // the thread on open via issues.comments, and re-fetch whenever the live wire
  // row's commentCount moves (every addComment broadcasts the updated issue, so
  // a new comment — ours or an agent's — pulls the fresh thread). Best-effort:
  // a fetch error keeps whatever is shown. The wrapping Promise.resolve() also
  // absorbs a missing proc on the client seam instead of crashing the render.
  // Legacy fallback: a pre-#175 hub-mirrored wire may still EMBED comments and
  // lack the proc's data locally (the node returns [] for viaHub issues) — use
  // the embedded thread when the fetch comes back empty.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on issue switch / count change only; trpc is a stable store singleton
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => trpc.issues.comments.query({ id: issue.id }))
      .then((rows) => {
        if (cancelled) return
        setComments(rows.length === 0 ? (issue.comments ?? []) : rows)
      })
      .catch(() => {
        // best-effort — keep whatever we already have
      })
    return () => {
      cancelled = true
    }
  }, [issue.id, issue.commentCount])

  // Load this issue's state-transition events for the activity feed (interleaved
  // with comments below). The events route is repo-scoped and cursor-paged
  // (ascending from `since`), so on open we drain to the end, then advance the
  // cursor and let each `issuesChanged` broadcast pull only the new tail. This is
  // best-effort: a fetch error just leaves the comment-only feed intact.
  // Deps are the issue identity only — `trpc`/`hub` are stable store singletons,
  // so keying on them would just risk a refetch loop if their identity churned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only on issue switch; trpc/hub are stable
  useEffect(() => {
    let cancelled = false
    let since = 0
    const absorb = (rows: IssueEvent[]): void => {
      if (cancelled || rows.length === 0) return
      since = rows.reduce((m, r) => Math.max(m, r.id), since)
      const mine = rows.filter((r) => r.subject === issue.id)
      if (mine.length > 0)
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id))
          const added = mine.filter((e) => !seen.has(e.id))
          return added.length > 0 ? [...prev, ...added] : prev
        })
    }
    const drain = (): void => {
      trpc.issues.events
        .query({ since, repoPath: issue.repoPath, limit: 1000 })
        .then((rows) => {
          if (cancelled) return
          absorb(rows as IssueEvent[])
          if (rows.length === 1000) drain() // a full page means more remain
        })
        .catch(() => {
          // best-effort — keep whatever we already have
        })
    }
    setEvents([])
    drain()
    const off = hub.onIssues(() => drain())
    return () => {
      cancelled = true
      off()
    }
  }, [issue.id, issue.repoPath])

  // Run a mutation, surfacing any thrown error verbatim as an inline toast.
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setToast('')
    try {
      await fn()
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const { prev, next } = issueNeighbors(orderedIds, issue.id)
  const repo = issue.repoPath.split('/').filter(Boolean).pop() ?? issue.repoPath
  const feed = buildActivityFeed(comments, events)

  // Post the composed comment, appending it optimistically so it shows without
  // waiting for the broadcast round-trip (the commentCount-keyed refetch then
  // replaces the local copy with server truth).
  const postComment = (): void => {
    const body = commentBody.trim()
    if (!body) return
    void run(async () => {
      await trpc.issues.addComment.mutate({ id: issue.id, author: 'me', body })
      setComments((cur) => [...cur, { author: 'me', body, createdAt: new Date().toISOString() }])
      setCommentBody('')
    })
  }
  // Archived children stay visible (marked), so archiving a child doesn't vanish it
  // from its parent's subissue list (issue #133).
  const children = subIssuesOf(issues, issue.id)

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
    const title = value.trim()
    setEditingTitle(false)
    if (!title || title === issue.title) return
    void run(() => trpc.issues.update.mutate({ id: issue.id, patch: { title } }))
  }

  const commitDescription = (value: string): void => {
    setEditingDesc(false)
    if (value === issue.description) return
    void run(() => trpc.issues.update.mutate({ id: issue.id, patch: { description: value } }))
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="issue-page">
      <header className="flex items-center gap-2 border-border border-b px-4 py-2.5">
        <Button type="button" variant="ghost" size="icon-sm" title="Back" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden="true" />
        </Button>
        <span className="text-[13px] text-muted-foreground">{repo}</span>
        <span className="text-[13px] text-muted-foreground">›</span>
        <span className="font-medium text-[13px]">#{issue.seq}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Copy issue id"
          onClick={() => void navigator.clipboard?.writeText(`#${issue.seq}`)}
        >
          <Copy size={13} aria-hidden="true" />
        </Button>
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
          <IssueOverflowMenu issue={issue} busy={busy} run={run} onDeleted={onBack} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-4">
          {/* ---- Banners ---- */}
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
                  onClick={() =>
                    void run(() => trpc.issues.applySuggestion.mutate({ id: issue.id }))
                  }
                >
                  Approve
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() => trpc.issues.dismissSuggestion.mutate({ id: issue.id }))
                  }
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
                onClick={() => void run(() => trpc.issues.clearNeedsHuman.mutate({ id: issue.id }))}
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
              className="mb-3 h-auto font-semibold text-xl"
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
              className="mb-3 block w-full break-words text-left font-semibold text-xl text-foreground hover:opacity-80"
              onClick={() => setEditingTitle(true)}
              title="Click to edit title"
            >
              {issue.title}
            </button>
          )}

          {/* ---- Description (inline edit) ---- */}
          <section className="mb-6">
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
                className="block w-full whitespace-pre-wrap break-words text-left text-[13px] text-muted-foreground hover:text-foreground"
                onClick={() => setEditingDesc(true)}
                title="Click to edit description"
              >
                {issue.description || 'Add a description…'}
              </button>
            )}
          </section>

          {/* ---- Sub-issues ---- */}
          <section className="mb-6 flex flex-col gap-1" data-testid="sub-issues">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-[13px] text-foreground">Sub-issues</h3>
              {issue.childCount > 0 && (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {issue.childDoneCount}/{issue.childCount}
                </span>
              )}
            </div>
            {children.map((c) => (
              <button
                key={c.id}
                type="button"
                className={cn(
                  'flex items-center gap-2 rounded px-1.5 py-1 text-left text-[13px] hover:bg-muted/50',
                  c.archived && 'opacity-60',
                )}
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
                    void run(() =>
                      trpc.issues.create.mutate({
                        repoPath: issue.repoPath,
                        title: childTitle.trim(),
                        parentId: issue.id,
                        startNow: false,
                      }),
                    )
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
              <IssueProperties issue={issue} busy={busy} run={run} onNavigate={onNavigate} />
            </div>
          </details>

          {/* ---- Activity ---- */}
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-[13px] text-foreground">Activity</h3>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Refresh AI notes"
                disabled={busy}
                onClick={() =>
                  void run(() => trpc.issues.refreshAssistant.mutate({ id: issue.id }))
                }
              >
                <RefreshCw size={14} aria-hidden="true" />
              </Button>
            </div>

            {issue.activityNotes && (
              <div className="flex flex-col gap-0.5 rounded-lg border border-border border-dashed bg-muted/30 p-2.5">
                <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                  Assistant
                </span>
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

        <aside
          data-testid="issue-aside"
          className="hidden w-[280px] shrink-0 overflow-y-auto border-border border-l px-4 py-4 md:block"
        >
          <IssueProperties issue={issue} busy={busy} run={run} onNavigate={onNavigate} />
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
 * The header `…` overflow menu: copy branch name, open in Linear, flag for human
 * (via `window.prompt`), supersede/duplicate against a sibling issue, and delete.
 * Actions that don't apply to this issue (no branch, no Linear url, no siblings)
 * are omitted. `run` is the page's toast-wrapping mutation runner.
 */
function IssueOverflowMenu({
  issue,
  busy,
  run,
  onDeleted,
}: {
  issue: IssueWire
  busy: boolean
  run: (fn: () => Promise<unknown>) => Promise<void>
  onDeleted: () => void
}): JSX.Element {
  const { trpc, issues } = useStoreSelector(
    (s) => ({ trpc: s.trpc, issues: s.issues }),
    shallowEqual,
  )
  // Sibling issues in the same repo — targets for supersede/duplicate.
  const targetIssues = issues
    .filter((i) => i.repoPath === issue.repoPath && i.id !== issue.id)
    .sort((a, b) => a.seq - b.seq)

  const flagForHuman = (): void => {
    const q = window.prompt('Flag for human — question (optional):')
    if (q === null) return // cancelled
    const question = q.trim()
    void run(() =>
      trpc.issues.setNeedsHuman.mutate({ id: issue.id, question: question || undefined }),
    )
  }

  const handleDelete = (): void => {
    if (!window.confirm(`Delete "#${issue.seq} ${issue.title}"? This can't be undone.`)) return
    void run(async () => {
      await trpc.issues.delete.mutate({ id: issue.id })
      onDeleted()
    })
  }

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
          <DropdownMenuItem onClick={() => void navigator.clipboard?.writeText(issue.branch ?? '')}>
            <GitBranch size={14} aria-hidden="true" /> Copy branch name
          </DropdownMenuItem>
        )}
        {issue.linearUrl && (
          <DropdownMenuItem
            onClick={() => window.open(issue.linearUrl, '_blank', 'noopener,noreferrer')}
          >
            <ExternalLink size={14} aria-hidden="true" /> Open in Linear
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={flagForHuman}>
          <Flag size={14} aria-hidden="true" /> Flag for human…
        </DropdownMenuItem>
        {targetIssues.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Supersede with…</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                {targetIssues.map((t) => (
                  <DropdownMenuItem
                    key={t.id}
                    onClick={() =>
                      void run(() => trpc.issues.supersede.mutate({ oldId: issue.id, newId: t.id }))
                    }
                  >
                    #{t.seq} {t.title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Duplicate of…</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                {targetIssues.map((t) => (
                  <DropdownMenuItem
                    key={t.id}
                    onClick={() =>
                      void run(() =>
                        trpc.issues.duplicate.mutate({ id: issue.id, canonicalId: t.id }),
                      )
                    }
                  >
                    #{t.seq} {t.title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 size={14} aria-hidden="true" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** One labeled row in the properties sidebar: a fixed-width label + a value cell. */
function PropertyRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="w-20 shrink-0 pt-1 text-[12px] text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** The full-width ghost button used as a PropertyMenu trigger (shows the current
 *  value; the whole cell is clickable). Forwards ref + injected props so Base UI's
 *  `DropdownMenuTrigger render={…}` can wire the open handler onto the button. */
const TriggerButton = forwardRef<
  HTMLButtonElement,
  ComponentProps<typeof Button> & { testId?: string }
>(({ children, testId, ...props }, ref) => (
  <Button
    ref={ref}
    type="button"
    variant="ghost"
    size="sm"
    data-testid={testId}
    className="h-7 w-full justify-start gap-1.5 px-2 font-normal text-[13px]"
    {...props}
  >
    {children}
  </Button>
))
TriggerButton.displayName = 'TriggerButton'

function IssueAgentAction({
  mode,
  defaultAgent,
  busy,
  onDefault,
  onAgent,
}: {
  mode: 'start' | 'session'
  defaultAgent: string
  busy: boolean
  onDefault: () => void
  onAgent: (agentKind: IssueAgentKind) => void
}): JSX.Element {
  const primaryLabel = mode === 'start' ? 'Start work' : '+ Session'
  const chooseTitle = mode === 'start' ? 'Choose start agent' : 'Choose session agent'
  const variant = mode === 'start' ? undefined : 'secondary'
  const defaultKind = issueDefaultAgentKind(defaultAgent)
  const defaultLabel = issueAgentDefaultLabel(defaultAgent)
  return (
    <div className="inline-flex">
      <Button
        type="button"
        variant={variant}
        size="sm"
        className="rounded-r-none"
        disabled={busy}
        onClick={onDefault}
      >
        {primaryLabel}
      </Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant={variant}
              size="sm"
              className="rounded-l-none border-l-0 px-2"
              disabled={busy}
              title={chooseTitle}
              aria-label={chooseTitle}
            >
              <ChevronDown size={13} aria-hidden="true" />
            </Button>
          }
        />
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onDefault}>
            {issueAgentIcon(defaultAgent)}
            {mode === 'start' ? `Start with ${defaultLabel}` : `New ${defaultLabel} session`}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {ISSUE_AGENT_KINDS.filter((kind) => kind !== defaultKind).map((kind) => (
            <DropdownMenuItem key={kind} onClick={() => onAgent(kind)}>
              {issueAgentIcon(kind)}
              {mode === 'start'
                ? `Start with ${issueAgentLabel(kind)}`
                : `New ${issueAgentLabel(kind)} session`}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * The Linear-style properties sidebar for the issue page — a stack of labeled
 * `PropertyMenu`/inline rows driving the same mutations the detail drawer used,
 * plus the ported Sessions and Git action blocks. Rendered in the desktop `<aside>`
 * and (mirrored) inside the mobile `Details` disclosure. `run` is the page's
 * toast-wrapping mutation runner; `onNavigate` re-points the open issue (parent /
 * relation click-through).
 */
function IssueProperties({
  issue,
  busy,
  run,
  onNavigate,
}: {
  issue: IssueWire
  busy: boolean
  run: (fn: () => Promise<unknown>) => Promise<void>
  onNavigate: (id: string) => void
}): JSX.Element {
  const { trpc, issues, machines, setSelectedWorktree, setPane, setView } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      issues: s.issues,
      machines: s.machines,
      setSelectedWorktree: s.setSelectedWorktree,
      setPane: s.setPane,
      setView: s.setView,
    }),
    shallowEqual,
  )
  const [mergeStyle, setMergeStyle] = useState<MergeStyle>('ff-only')
  const [deferDate, setDeferDate] = useState('')
  // Relation add is two steps: pick a dep type, then a target issue.
  const [addRelType, setAddRelType] = useState('blocks')

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => {
    setDeferDate('')
    setAddRelType('blocks')
  }, [issue.id])

  useEffect(() => {
    let cancelled = false
    trpc.settings.get
      .query()
      .then((s) => {
        if (!cancelled) setMergeStyle(s.gitWorkflow.mergeStyle)
      })
      .catch(() => {
        // best-effort — ff-only is a safe default primary
      })
    return () => {
      cancelled = true
    }
  }, [trpc])

  const update = (patch: Record<string, unknown>): void => {
    void run(() => trpc.issues.update.mutate({ id: issue.id, patch }))
  }

  // Repo-mates: the pool for relations + parent, excluding self, seq-ordered.
  const repoMates = issues
    .filter((i) => i.repoPath === issue.repoPath && i.id !== issue.id)
    .sort((a, b) => a.seq - b.seq)
  const byId = new Map(issues.map((i) => [i.id, i]))
  const issueLabel = (id: string): string => {
    const m = byId.get(id)
    return m ? `#${m.seq} ${m.title}` : id
  }
  const mateOptions: PropertyOption[] = repoMates.map((i) => ({
    value: i.id,
    label: `#${i.seq} ${i.title}`,
  }))

  // Distinct assignees / labels across all issues — the suggestion pool.
  const assigneeOptions: PropertyOption[] = [
    { value: '__unassigned__', label: 'Unassigned' },
    ...[...new Set(issues.map((i) => i.assignee).filter((a): a is string => !!a))]
      .sort()
      .map((a) => ({ value: a, label: a })),
  ]
  const labelPool = [...new Set(issues.flatMap((i) => i.labels))]
    .filter((l) => !issue.labels.includes(l))
    .sort()

  const openSession = (session: { sessionId: string; cwd: string }): void => {
    setSelectedWorktree(session.cwd)
    setPane('A', session.sessionId)
    setView('workspace')
  }
  const action = (kind: 'rebase' | 'pr' | 'merge'): Promise<void> =>
    run(async () => {
      await trpc.issues.action.mutate({ id: issue.id, kind })
    })
  const primaryIsPr = mergeStyle === 'pr'
  const mergeLabel = 'FF-only merge'

  const relations = groupRelations(issue)
  const parent = issue.parentId ? byId.get(issue.parentId) : undefined

  // ---- Status: 6 stages + Close done/wontfix. Reopen is intentionally omitted:
  // the `update` router can't clear `closedReason` (string, no null), and an empty
  // string still reads as closed server-side (isClosed: closedReason != null). ----
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
            onSelect={(v) => {
              if (v.startsWith('stage:')) update({ stage: v.slice('stage:'.length) as IssueStage })
              else if (v === 'close:done')
                void run(() => trpc.issues.close.mutate({ id: issue.id, reason: 'done' }))
              else if (v === 'close:wontfix')
                void run(() => trpc.issues.close.mutate({ id: issue.id, reason: 'wontfix' }))
            }}
            trigger={
              <TriggerButton disabled={busy} testId="status-trigger">
                <StageGlyph stage={issue.stage} />
                {STAGE_LABELS[issue.stage]}
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
            onSelect={(v) => update({ priority: Number(v) })}
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
            selectedValue={issue.assignee ?? '__unassigned__'}
            options={assigneeOptions}
            placeholder="Assign to…"
            onSelect={(v) => update({ assignee: v === '__unassigned__' ? '' : v })}
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
            onSelect={(v) => update({ type: v as IssueType })}
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
                  type="button"
                  aria-label={`Remove label ${label}`}
                  title={`Remove ${label}`}
                  disabled={busy}
                  className="rounded-sm text-primary/70 hover:text-primary disabled:opacity-50"
                  onClick={() =>
                    void run(() =>
                      trpc.issues.setLabels.mutate({
                        id: issue.id,
                        labels: issue.labels.filter((l) => l !== label),
                      }),
                    )
                  }
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </span>
            ))}
            <PropertyMenu
              allowFreeText
              options={labelPool.map((l) => ({ value: l, label: l }))}
              placeholder="Add label…"
              onSelect={(v) => {
                const label = v.trim()
                if (!label || issue.labels.includes(label)) return
                void run(() =>
                  trpc.issues.setLabels.mutate({ id: issue.id, labels: [...issue.labels, label] }),
                )
              }}
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
              update({ estimateMin: n })
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
              onChange={(e) => {
                const v = e.currentTarget.value
                update({ dueAt: v ? new Date(`${v}T00:00:00`).toISOString() : '' })
              }}
            />
            {issue.dueAt && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Clear due date"
                aria-label="Clear due date"
                disabled={busy}
                onClick={() => update({ dueAt: '' })}
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
              onClick={() =>
                void run(async () => {
                  await trpc.issues.defer.mutate({ id: issue.id, until: deferDate })
                  setDeferDate('')
                })
              }
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
                onClick={() => void run(() => trpc.issues.undefer.mutate({ id: issue.id }))}
              >
                Unsnooze
              </Button>
            )}
          </div>
        </PropertyRow>

        {/* Parent */}
        <PropertyRow label="Parent">
          <div className="flex items-center gap-1">
            {parent && (
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-[13px] text-primary hover:underline"
                onClick={() => onNavigate(parent.id)}
                title={`#${parent.seq} ${parent.title}`}
              >
                #{parent.seq} {parent.title}
              </button>
            )}
            <PropertyMenu
              selectedValue={issue.parentId ?? '__none__'}
              options={[{ value: '__none__', label: 'No parent' }, ...mateOptions]}
              placeholder="Set parent…"
              onSelect={(v) =>
                void run(() =>
                  trpc.issues.reparent.mutate({
                    id: issue.id,
                    parentId: v === '__none__' ? null : v,
                  }),
                )
              }
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className={cn('h-7 gap-1 px-2 text-[13px]', parent ? '' : 'w-full justify-start')}
                >
                  {parent ? 'Change' : <span className="text-muted-foreground">No parent</span>}
                </Button>
              }
            />
          </div>
        </PropertyRow>
      </div>

      {/* Relations */}
      <section className="flex flex-col gap-1.5">
        <h3 className="font-medium text-[12px] text-muted-foreground">Relations</h3>
        {relations.map((group) => (
          <div key={group.section} className="flex flex-col gap-0.5">
            <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
              {group.section}
            </span>
            {group.entries.map((entry) => (
              <div
                key={`${group.section}-${entry.direction}-${entry.id}`}
                className="group flex items-center justify-between gap-2"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-[13px] text-foreground hover:text-primary hover:underline"
                  onClick={() => byId.has(entry.id) && onNavigate(entry.id)}
                  title={issueLabel(entry.id)}
                >
                  {issueLabel(entry.id)}
                </button>
                <button
                  type="button"
                  aria-label={`Remove relation ${entry.type} ${entry.id}`}
                  title="Remove relation"
                  disabled={busy}
                  className="shrink-0 rounded-sm text-muted-foreground/60 opacity-0 hover:text-foreground disabled:opacity-50 group-hover:opacity-100"
                  onClick={() =>
                    void run(() =>
                      trpc.issues.depRemove.mutate(
                        entry.direction === 'dep'
                          ? { fromId: issue.id, toId: entry.id, type: entry.type }
                          : { fromId: entry.id, toId: issue.id, type: entry.type },
                      ),
                    )
                  }
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ))}
        {repoMates.length > 0 && (
          <div className="flex items-center gap-1.5">
            <PropertyMenu
              selectedValue={addRelType}
              options={ISSUE_DEP_TYPES.filter(
                (t) => t !== 'parent-child' && t !== 'supersedes',
              ).map((t) => ({ value: t, label: t }))}
              onSelect={(v) => setAddRelType(v)}
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
              onSelect={(v) =>
                void run(() =>
                  trpc.issues.depAdd.mutate({ fromId: issue.id, toId: v, type: addRelType }),
                )
              }
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

      {/* Sessions — ported from the detail drawer. */}
      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-[12px] text-muted-foreground">
          Sessions ({issue.sessionSummary.total})
        </h3>
        {/* Model + effort the issue's sessions launch with (scoped to its agent). */}
        <div className="flex flex-wrap items-center gap-1.5">
          <ModelPicker
            agentKind={issueDefaultAgentKind(issue.defaultAgent)}
            value={issue.defaultModel}
            onChange={(defaultModel) =>
              // Effort is per-model — changing the model resets effort to auto.
              void run(() =>
                trpc.issues.update.mutate({
                  id: issue.id,
                  patch: { defaultModel, defaultEffort: 'auto' },
                }),
              )
            }
          />
          <EffortPicker
            agentKind={issueDefaultAgentKind(issue.defaultAgent)}
            model={issue.defaultModel}
            value={issue.defaultEffort}
            onChange={(defaultEffort) =>
              void run(() => trpc.issues.update.mutate({ id: issue.id, patch: { defaultEffort } }))
            }
          />
          {/* Machine pin — which daemon runs this issue's agents ('auto' = repo affinity). */}
          {machines.length > 1 && (
            <PropertyMenu
              selectedValue={issue.machineId ?? 'auto'}
              options={[
                { value: 'auto', label: 'auto machine' },
                ...machines.map((m) => ({
                  value: m.id,
                  label: m.online ? m.name : `${m.name} (offline)`,
                })),
              ]}
              onSelect={(v) =>
                void run(() =>
                  trpc.issues.update.mutate({
                    id: issue.id,
                    patch: { machineId: v === 'auto' ? null : v },
                  }),
                )
              }
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="h-7 gap-1 px-2 text-[12px]"
                >
                  {issue.machineId
                    ? (machines.find((m) => m.id === issue.machineId)?.name ?? issue.machineId)
                    : 'auto machine'}
                </Button>
              }
            />
          )}
        </div>
        {issue.sessions.length > 0 && (
          <div className="flex flex-col gap-1">
            {issue.sessions.map((s) => (
              <Button
                key={s.sessionId}
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto w-full justify-start whitespace-normal px-2 py-1.5 text-left font-normal"
                onClick={() => openSession(s)}
              >
                {sessionDisplayName(s)}
              </Button>
            ))}
          </div>
        )}
        {issue.worktreePath ? (
          <div className="flex gap-2">
            <IssueAgentAction
              mode="session"
              defaultAgent={issue.defaultAgent}
              busy={busy}
              onDefault={() => void run(() => trpc.issues.addSession.mutate({ id: issue.id }))}
              onAgent={(agentKind) =>
                void run(() => trpc.issues.addSession.mutate({ id: issue.id, agentKind }))
              }
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => trpc.issues.addShell.mutate({ id: issue.id }))}
            >
              + Shell
            </Button>
          </div>
        ) : (
          <IssueAgentAction
            mode="start"
            defaultAgent={issue.defaultAgent}
            busy={busy}
            onDefault={() => void run(() => trpc.issues.start.mutate({ id: issue.id }))}
            onAgent={(agentKind) =>
              void run(() => trpc.issues.start.mutate({ id: issue.id, agentKind }))
            }
          />
        )}
      </section>

      {/* Git — ported from the detail drawer. */}
      {issue.worktreePath && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium text-[12px] text-muted-foreground">Git</h3>
          <div className="flex flex-wrap gap-2">
            {primaryIsPr ? (
              <Button type="button" size="sm" disabled={busy} onClick={() => void action('pr')}>
                Open PR
              </Button>
            ) : (
              <Button type="button" size="sm" disabled={busy} onClick={() => void action('merge')}>
                {mergeLabel}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void action('rebase')}
            >
              Rebase on {issue.parentBranch}
            </Button>
            {primaryIsPr ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void action('merge')}
              >
                {mergeLabel}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void action('pr')}
              >
                Open PR
              </Button>
            )}
          </div>
          {issue.prUrl && (
            <a
              href={issue.prUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[13px] text-primary hover:underline"
            >
              View PR <ExternalLink size={13} aria-hidden="true" />
            </a>
          )}
        </section>
      )}
    </div>
  )
}
