import { ISSUE_STAGES, type IssueStage, type IssueWire } from '@podium/protocol'
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Flag,
  GitBranch,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { STAGE_LABELS } from './issue-card'
import { issueDetailFields } from './issue-detail-fields'
import { issueNeighbors } from './issue-page'
import { useStore } from './store'

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
  const { trpc } = useStore()
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)
  const [commentBody, setCommentBody] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)

  // Reset transient compose/edit state on issue switch so a half-typed comment or
  // an open editor never carries across to the next issue.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => {
    setCommentBody('')
    setEditingTitle(false)
    setEditingDesc(false)
    setToast('')
  }, [issue.id])

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
  const fields = issueDetailFields(issue)

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

            {fields.comments.length > 0 && (
              <div className="flex flex-col gap-2">
                {fields.comments.map((c) => (
                  <div
                    key={`${c.author}|${c.createdAt}|${c.body}`}
                    className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/40 p-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-[12px] text-foreground">{c.author}</span>
                      <span className="text-[11px] text-muted-foreground">{c.createdAt}</span>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
                      {c.body}
                    </p>
                  </div>
                ))}
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
                    void run(async () => {
                      await trpc.issues.addComment.mutate({
                        id: issue.id,
                        author: 'me',
                        body: commentBody.trim(),
                      })
                      setCommentBody('')
                    })
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                className="w-fit"
                disabled={busy || commentBody.trim().length === 0}
                onClick={() =>
                  void run(async () => {
                    await trpc.issues.addComment.mutate({
                      id: issue.id,
                      author: 'me',
                      body: commentBody.trim(),
                    })
                    setCommentBody('')
                  })
                }
              >
                Post
              </Button>
            </div>
          </section>
        </div>

        <aside className="hidden w-[280px] shrink-0 overflow-y-auto border-border border-l px-4 py-4 md:block">
          {/* Properties sidebar — Task 9; until then keep the interim Stage select. */}
          <div className="flex flex-col gap-1.5">
            <h3 className="font-medium text-[13px] text-foreground">Stage</h3>
            <Select
              value={issue.stage}
              onValueChange={(value) => {
                if (!value) return
                void run(() =>
                  trpc.issues.update.mutate({
                    id: issue.id,
                    patch: { stage: value as IssueStage },
                  }),
                )
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ISSUE_STAGES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STAGE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
  const { trpc, issues } = useStore()
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
