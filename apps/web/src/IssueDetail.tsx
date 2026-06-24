import { ISSUE_STAGES, type IssueStage, type IssueWire } from '@podium/protocol'
import { ExternalLink, RefreshCw, X } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useStore } from './store'
import { sessionDisplayName } from './WorkerLabel'

const STAGE_LABELS: Record<IssueStage, string> = {
  backlog: 'Backlog',
  planning: 'Planning',
  in_progress: 'In Progress',
  review: 'Review',
  verifying: 'Verifying',
  done: 'Done',
}

type MergeStyle = 'ff-only' | 'pr' | 'ask'

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
