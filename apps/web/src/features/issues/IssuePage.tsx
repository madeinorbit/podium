import { type IssueWire, issueDisplayRef } from '@podium/protocol'
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
} from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
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
import { copyToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { issueIdTitle, STAGE_LABELS } from './issue-card'
import type { IssueEventIcon } from './issue-events'
import { AssigneeAvatar, StageGlyph } from './issue-glyphs'
import { type IssuePageCommands, issuePageCommands } from './issue-page-commands'
import { repoMatesOf, useIssuePageModel } from './issue-page-model'
import { IssueProperties } from './issue-page-properties'

/**
 * The full issue page — an in-view (not overlay) replacement for the detail
 * drawer. A header with breadcrumb + prev/next + overflow menu, a scrolling main
 * column (banners → inline-editable title → inline-editable description →
 * activity feed), and a desktop-only properties aside. The `issue` prop is the
 * live store row, so it re-renders as `issuesChanged` broadcasts land.
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
  const { busy, toast, run, prev, next, repoName, feed, children } = model
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
          title={`${issue.id} — click to copy "${issueDisplayRef(issue)}"`}
          onClick={() =>
            copyToClipboard(issueDisplayRef(issue), `Copied ${issueDisplayRef(issue)}`)
          }
        >
          {issueDisplayRef(issue)}
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
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-4">
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
          {issue.suggestedStage && (
            <div className="mb-4 flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-[13px]">
              <p className="text-foreground">
                Move to <b>{STAGE_LABELS[issue.suggestedStage]}</b>?
                {issue.suggestedReason ? ` ${issue.suggestedReason}` : ''}
              </p>
              <div className="flex gap-2">
                <Button type="button" size="sm" disabled={busy} onClick={commands.applySuggestion}>
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
                title={issueIdTitle(c)}
                onClick={() => onNavigate(c.id)}
              >
                <StageGlyph stage={c.stage} />
                <span className="text-[11px] text-muted-foreground">{issueDisplayRef(c)}</span>
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
              <h3 className="font-medium text-[13px] text-foreground">Activity</h3>
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
 * are omitted. `commands` is the page's named-command set (toast-wrapping runner
 * included); `onDeleted` returns to the board after a confirmed delete.
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
    const message = `Delete "${issueDisplayRef(issue)} ${issue.title}" and ${sessionCount} session${sessionCount === 1 ? '' : 's'}? The issue and sessions can be restored; running processes will be stopped.`
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
                    {issueDisplayRef(t)} {t.title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Duplicate of…</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                {targetIssues.map((t) => (
                  <DropdownMenuItem key={t.id} onClick={() => commands.duplicateOf(t.id)}>
                    {issueDisplayRef(t)} {t.title}
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
