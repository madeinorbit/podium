import { ISSUE_STAGES, type IssueStage, IssueType, type IssueWire } from '@podium/protocol'
import { ExternalLink, RefreshCw, X } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { STAGE_LABELS } from './issue-card'
import { issueDetailFields } from './issue-detail-fields'
import { useStore } from './store'
import { sessionDisplayName } from './WorkerLabel'

type MergeStyle = 'ff-only' | 'pr' | 'ask'

// bd priorities are P0 (highest) … P4; the `update` procedure clamps to 0–4.
const PRIORITY_OPTIONS = [0, 1, 2, 3, 4] as const

/**
 * The Issue detail drawer — a fixed right-side panel over the board. Shows the
 * description, AI activity notes, dependencies, member sessions (open each, or
 * add a session/shell), a stage selector, and the git quick-actions whose
 * primary is chosen by the configured merge style. The `issue` prop is the live
 * row from the store, so it re-renders as `issuesChanged` broadcasts land.
 */
export function IssueDetail({
  issue,
  onClose,
}: {
  issue: IssueWire
  onClose: () => void
}): JSX.Element {
  const { trpc, setSelectedWorktree, setPane, setView } = useStore()
  // The merge style lives in the settings blob, which the store doesn't expose —
  // fetch it once so the primary action matches the user's git workflow.
  const [mergeStyle, setMergeStyle] = useState<MergeStyle>('ff-only')
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    trpc.settings.get
      .query()
      .then((s) => {
        if (!cancelled) setMergeStyle(s.gitWorkflow.mergeStyle)
      })
      .catch(() => {
        // best-effort — the ff-only default is a safe primary
      })
    return () => {
      cancelled = true
    }
  }, [trpc])

  // Run a mutation, surfacing any thrown error verbatim as an inline toast.
  const run = async (fn: () => Promise<unknown>) => {
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

  // Git actions report success/failure in their result — surface `output`
  // verbatim on failure so the user sees the real git/gh message.
  const action = (kind: 'rebase' | 'pr' | 'merge') =>
    run(async () => {
      const r = await trpc.issues.action.mutate({ id: issue.id, kind })
      setToast(r.ok ? `${kind} ok` : `${kind} failed:\n${r.output}`)
    })

  // Open a member session the same way the sidebar does: select its worktree AND
  // bind the specific session into pane A, then switch to the workspace. Setting
  // only the worktree (the old behavior) left the workspace on the worktree with
  // no panel attached — the session looked unopenable even though it exists.
  const openSession = (session: { sessionId: string; cwd: string }) => {
    setSelectedWorktree(session.cwd)
    setPane('A', session.sessionId)
    setView('workspace')
  }

  const mergeLabel = 'FF-only merge'
  const primaryIsPr = mergeStyle === 'pr'
  // View-model for the rich bd fields. P4b makes priority/type/assignee/labels
  // editable inline (read straight from `issue` below); deps, hierarchy,
  // lifecycle and comments stay read-only here (Task 6 makes those interactive).
  const fields = issueDetailFields(issue)

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-border border-l bg-background shadow-xl">
      <header className="flex items-start justify-between gap-2 border-border border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="break-words font-medium text-base text-foreground">
            #{issue.seq} {issue.title}
          </h2>
          <p className="text-[12px] text-muted-foreground">{STAGE_LABELS[issue.stage]}</p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" title="Close" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
        {issue.suggestedStage && (
          <div className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-[13px]">
            <p className="text-foreground">
              Move to <b>{STAGE_LABELS[issue.suggestedStage]}</b>?
              {issue.suggestedReason ? ` ${issue.suggestedReason}` : ''}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void run(() => trpc.issues.applySuggestion.mutate({ id: issue.id }))}
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

        <section className="flex flex-col gap-3">
          <h3 className="font-medium text-[13px] text-foreground">Details</h3>

          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">Priority</span>
              <Select
                value={String(issue.priority)}
                onValueChange={(value) => {
                  if (!value) return
                  void run(() =>
                    trpc.issues.update.mutate({
                      id: issue.id,
                      patch: { priority: Number(value) },
                    }),
                  )
                }}
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_OPTIONS.map((p) => (
                    <SelectItem key={p} value={String(p)}>
                      P{p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">Type</span>
              <Select
                value={issue.type}
                onValueChange={(value) => {
                  if (!value) return
                  void run(() =>
                    trpc.issues.update.mutate({
                      id: issue.id,
                      patch: { type: value as IssueType },
                    }),
                  )
                }}
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IssueType.options.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Assignee</span>
            {/* Uncontrolled input keyed by issue id so it re-seeds on switch;
                commit on blur or Enter, only when the value actually changed. */}
            <Input
              key={`assignee-${issue.id}`}
              defaultValue={issue.assignee ?? ''}
              placeholder="unassigned"
              aria-label="Assignee"
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
              }}
              onBlur={(e) => {
                const next = e.currentTarget.value.trim()
                if (next === (issue.assignee ?? '')) return
                void run(() =>
                  trpc.issues.update.mutate({ id: issue.id, patch: { assignee: next } }),
                )
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-muted-foreground">Labels</span>
            {issue.labels.length > 0 && (
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
              </div>
            )}
            {/* Uncontrolled + keyed so it clears on issue switch; on Enter we
                clear the box and append the trimmed label (de-duped). */}
            <Input
              key={`add-label-${issue.id}`}
              defaultValue=""
              placeholder="Add label…"
              aria-label="Add label"
              disabled={busy}
              className="max-w-[200px]"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                const input = e.currentTarget
                const label = input.value.trim()
                input.value = ''
                if (!label || issue.labels.includes(label)) return
                void run(() =>
                  trpc.issues.setLabels.mutate({
                    id: issue.id,
                    labels: [...issue.labels, label],
                  }),
                )
              }}
            />
          </div>
        </section>

        {fields.lifecycle && (
          <section className="rounded-lg border border-warning/40 bg-warning/5 p-3">
            <p className="break-words text-[13px] text-foreground">{fields.lifecycle}</p>
          </section>
        )}

        {(fields.deps.length > 0 || fields.dependents.length > 0) && (
          <section className="flex flex-col gap-1">
            <h3 className="font-medium text-[13px] text-foreground">Dependencies</h3>
            {fields.deps.map((d) => (
              <p key={`dep-${d.type}-${d.id}`} className="text-[13px] text-muted-foreground">
                {d.type} {d.id}
              </p>
            ))}
            {fields.dependents.map((d) => (
              <p key={`rdep-${d.type}-${d.id}`} className="text-[13px] text-muted-foreground">
                {d.id} {d.type} this
              </p>
            ))}
          </section>
        )}

        {(fields.parentId || fields.childSummary) && (
          <section className="flex flex-col gap-1">
            <h3 className="font-medium text-[13px] text-foreground">Hierarchy</h3>
            {fields.parentId && (
              <p className="text-[13px] text-muted-foreground">Parent: {fields.parentId}</p>
            )}
            {fields.childSummary && (
              <p className="text-[13px] text-muted-foreground">Children: {fields.childSummary}</p>
            )}
          </section>
        )}

        {fields.comments.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="font-medium text-[13px] text-foreground">
              Comments ({fields.comments.length})
            </h3>
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
          </section>
        )}

        <section className="flex flex-col gap-1">
          <h3 className="font-medium text-[13px] text-foreground">Description</h3>
          <p className="whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
            {issue.description || '—'}
          </p>
        </section>

        <section className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-[13px] text-foreground">Activity notes</h3>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title="Refresh AI notes"
              disabled={busy}
              onClick={() => void run(() => trpc.issues.refreshAssistant.mutate({ id: issue.id }))}
            >
              <RefreshCw size={14} aria-hidden="true" />
            </Button>
          </div>
          <p className="whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
            {issue.activityNotes || '—'}
          </p>
        </section>

        {issue.dependencyNote && (
          <section className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/5 p-3">
            <h3 className="font-medium text-[13px] text-foreground">Dependencies</h3>
            <p className="whitespace-pre-wrap break-words text-[13px] text-muted-foreground">
              {issue.dependencyNote}
            </p>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h3 className="font-medium text-[13px] text-foreground">
            Sessions ({issue.sessionSummary.total})
          </h3>
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
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void run(() => trpc.issues.addSession.mutate({ id: issue.id }))}
              >
                + Session
              </Button>
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
            <Button
              type="button"
              size="sm"
              className="w-fit"
              disabled={busy}
              onClick={() => void run(() => trpc.issues.start.mutate({ id: issue.id }))}
            >
              Start work
            </Button>
          )}
        </section>

        {issue.worktreePath && (
          <section className="flex flex-col gap-2">
            <h3 className="font-medium text-[13px] text-foreground">Actions</h3>
            <div className="flex flex-wrap gap-2">
              {primaryIsPr ? (
                <Button type="button" size="sm" disabled={busy} onClick={() => void action('pr')}>
                  Open PR
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void action('merge')}
                >
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
              {/* The non-primary action stays available as a secondary. */}
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
