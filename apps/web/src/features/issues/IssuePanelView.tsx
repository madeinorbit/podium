import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import {
  artifactKind,
  artifactUrl,
  basename,
  issueForPanel,
  subIssuesOf,
} from '@podium/client-core/viewmodels'
import type { IssueComment, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import {
  ArrowRight,
  Check,
  ExternalLink,
  FileText,
  History,
  MessageSquare,
  Play,
} from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useOperatorFocus } from '@/app/operator-focus'
import { type IssueViewModel, useReplicaIssues, useStoreSelector } from '@/app/store'
import { MediaLightbox } from '@/components/MediaLightbox'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { copyToClipboard } from '@/lib/clipboard'
import { operationalState } from '@/lib/mission'
import { cn } from '@/lib/utils'
import { KindIcon, sessionDisplayName } from '@/lib/WorkerLabel'
import {
  coordinatorSession,
  IssueCompactControls,
  IssueDecisionBand,
  IssueGitScope,
  IssueSessionRow,
  isOpenSession,
  issueSessions,
} from './IssueCompactControls'
import { issueIdTitle } from './issue-card'
import { buildActivityFeed, type IssueEvent } from './issue-events'
import { StageGlyph } from './issue-glyphs'
import { groupRelations } from './issue-relations'

// The stage chip that used to lead this header is gone: the inspector head
// carries the stage as a glyph beside the ref and as the stage dropdown's own
// label, and a third copy of the same fact was the first thing the artifact cut.

function Hint({ children }: { children: string }): JSX.Element {
  return <div className="py-0.5 text-[11.5px] text-muted-foreground/60 italic">{children}</div>
}

/** A section of the single scroll. Deliberately NOT a DockSection: the approved
 *  inspector is one continuous read, so a section is a heading and a hairline —
 *  no chevron, no per-section collapse, no nested tier. */
function DockPart({
  title,
  count,
  testId,
  children,
}: {
  title: string
  count?: number
  testId?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="mb-4" data-testid={testId} data-part={title}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-semibold text-muted-foreground">{title}</span>
        {count !== undefined && count > 0 && (
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
            {count}
          </span>
        )}
        <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
      </div>
      {children}
    </section>
  )
}

/** The fold rows the inspector uses instead of collapsible sections: a single
 *  quiet line that says exactly what it is hiding. */
function FoldRow({
  open,
  label,
  onToggle,
}: {
  open: boolean
  label: string
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      data-pressable
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="w-full px-1 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
    >
      <span className="mr-1 font-mono">{open ? '⌄' : '›'}</span>
      {label}
    </button>
  )
}

/** One task row in Work / Relations — the unified row the rest of the shell uses:
 *  stage glyph, ref, title, state word. */
function UnifiedRow({
  sub,
  meta,
  onOpen,
}: {
  sub: IssueViewModel
  meta: string
  onOpen: () => void
}): JSX.Element {
  const closed = sub.stage === 'done' || Boolean(sub.closedReason)
  return (
    <button
      data-pressable
      type="button"
      onClick={onOpen}
      title={`${issueDisplayRef(sub)} ${sub.title}`}
      className={cn(
        'grid min-h-[30px] w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 border-b border-border/40 px-1 py-1 text-left text-[12.5px] hover:bg-accent/40',
        sub.archived && 'opacity-60',
      )}
    >
      <StageGlyph stage={sub.stage} size={13} />
      <span className="min-w-0 truncate">
        <span
          className="mr-1.5 font-mono text-[10px] text-muted-foreground"
          title={issueIdTitle(sub)}
        >
          {issueDisplayRef(sub)}
        </span>
        <span
          className={cn(
            closed && 'text-muted-foreground line-through decoration-muted-foreground/40',
          )}
        >
          {sub.title}
        </span>
      </span>
      <span className="flex-none font-mono text-[10px] text-muted-foreground/70">{meta}</span>
    </button>
  )
}

/** The subtree's done/running split as one segmented bar plus "N of M done" —
 *  the only progress surface in the inspector. */
function SubtreeMeter({
  done,
  run,
  total,
}: {
  done: number
  run: number
  total: number
}): JSX.Element {
  const pct = (n: number): string => `${total === 0 ? 0 : (n / total) * 100}%`
  return (
    <div className="mt-2.5 flex items-center gap-2" data-testid="dock-subtree-meter">
      <span className="flex h-1 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="h-full bg-success/80" style={{ width: pct(done) }} />
        <span className="h-full bg-amber-400/70" style={{ width: pct(run) }} />
      </span>
      <span className="flex-none font-mono text-[10px] tabular-nums text-muted-foreground">
        {done} of {total} done
      </span>
    </div>
  )
}

/** The five most recent things that happened to this task — comments and
 *  lifecycle events interleaved chronologically, newest first, using the same
 *  `buildActivityFeed` the full issue page's timeline is built from.
 *
 *  Comment bodies no longer ride IssueWire (#175): the thread is fetched lazily
 *  via the issues.comments proc, re-fetched whenever the issue's updatedAt
 *  moves. Legacy fallback: a pre-#175 payload may still embed `comments` (and a
 *  viaHub issue's thread lives on the hub, where the proc returns []) — use the
 *  embedded thread when the fetch comes back empty. */
function RecentActivity({
  issue,
  onOpenFull,
}: {
  issue: IssueViewModel
  onOpenFull: () => void
}): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const [comments, setComments] = useState<IssueComment[]>(issue.comments ?? [])
  const [events, setEvents] = useState<IssueEvent[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on issue switch / count change only; trpc is a stable store singleton
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => trpc.issues.comments.query({ id: issue.id }))
      .then((rows) => {
        if (!cancelled) setComments(rows.length === 0 ? (issue.comments ?? []) : rows)
      })
      .catch(() => {
        // best-effort — keep whatever we already have
      })
    return () => {
      cancelled = true
    }
  }, [issue.id, issue.updatedAt])
  // Narrowed to THIS issue on the server (POD-532: `subject` filters in SQL, on
  // `idx_podium_events_subject`), so the dock reads one issue's events instead of
  // paging the repo-wide log and filtering here. That is what makes keying on
  // `issue.updatedAt` affordable — the feed now tracks a supervised issue live
  // instead of going stale until the panel is reopened.
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() =>
        trpc.issues.events.query({
          since: 0,
          repoPath: issue.repoPath,
          subject: issue.id,
          limit: 200,
        }),
      )
      .then((rows) => {
        if (!cancelled) setEvents(rows.map((row) => ({ ...row, payload: row.payload ?? null })))
      })
      .catch(() => {
        if (!cancelled) setEvents([])
      })
    return () => {
      cancelled = true
    }
  }, [issue.id, issue.repoPath, issue.updatedAt, trpc])
  const shown = buildActivityFeed(comments, events).slice(-5).reverse()
  return (
    <DockPart title="Recent activity" count={shown.length}>
      <div className="flex flex-col gap-1" data-testid="dock-recent-activity">
        {shown.length === 0 ? (
          <Hint>Nothing has happened here yet.</Hint>
        ) : (
          shown.map((item) => (
            <div
              key={item.id}
              className="flex items-start gap-2 px-1 py-1 text-[12px] leading-relaxed text-foreground/80"
            >
              {item.kind === 'comment' ? (
                <MessageSquare size={11} className="mt-1 flex-none text-muted-foreground" />
              ) : (
                <History size={11} className="mt-1 flex-none text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 whitespace-pre-wrap">
                {item.kind === 'comment' ? item.body : item.line.text}
              </span>
              <span className="flex-none font-mono text-[10px] text-muted-foreground/65">
                {relativeTime(item.ts, Date.now())}
              </span>
            </div>
          ))
        )}
      </div>
      <button
        data-pressable
        type="button"
        onClick={onOpenFull}
        data-testid="dock-open-full-activity"
        className="mt-1 w-full px-1 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
      >
        Open full activity <ExternalLink size={10} className="inline align-[-1px]" />
      </button>
    </DockPart>
  )
}

/** The task head: identity, title, description and the one control strip. Fixed
 *  above the scroll — the artifact's `inspect-head`. */
function InspectHead({ issue }: { issue: IssueViewModel }): JSX.Element {
  return (
    <header className="flex-none border-b border-border/60 px-3 pt-3 pb-3">
      <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground/70">
        <StageGlyph stage={issue.stage} size={12} />
        <button
          data-pressable
          type="button"
          className="cursor-pointer hover:text-foreground"
          title={`${issue.id} — click to copy "${issueDisplayRef(issue)}"`}
          onClick={() =>
            copyToClipboard(issueDisplayRef(issue), `Copied ${issueDisplayRef(issue)}`)
          }
        >
          {issueDisplayRef(issue)}
        </button>
        <span className="ml-auto text-[10px] tracking-[0.08em] text-muted-foreground/60 uppercase">
          Task
        </span>
      </div>
      <h2 className="mt-1.5 text-[14px] leading-snug font-semibold text-foreground">
        {issue.title}
      </h2>
      {issue.description.trim() && (
        <p className="mt-1.5 line-clamp-3 text-[12px] leading-relaxed text-muted-foreground">
          {issue.description}
        </p>
      )}
      <IssueCompactControls issue={issue} />
    </header>
  )
}

/** Todo / Artifacts / Deferred / git — the issue's evidence, inline under one
 *  heading rather than three collapsibles. */
function EvidenceAndChecks({
  issue,
  machineId,
}: {
  issue: IssueViewModel
  machineId?: string
}): JSX.Element | null {
  const { trpc, httpOrigin, openFileInWorktree, openArtifact } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      httpOrigin: s.httpOrigin,
      openFileInWorktree: s.openFileInWorktree,
      openArtifact: s.openArtifact,
    }),
    shallowEqual,
  )
  const panel = issue.panel
  const todos = panel?.todos ?? []
  const artifacts = panel?.artifacts ?? []
  const deferred = panel?.deferred ?? []
  const doneCount = todos.filter((t) => t.done).length
  // An issue with no dedicated worktree is worked in the repo's primary
  // checkout — serve its artifacts from there instead of rendering every
  // artifact as a dead disabled button.
  const root = issue.worktreePath ?? issue.repoPath
  // Media artifact opened full-size (click a preview; Esc / click-out closes).
  const [lightbox, setLightbox] = useState<{
    kind: 'image' | 'video'
    src: string
    label: string
  } | null>(null)

  const toggleTodo = (index1: number, done: boolean): void => {
    void trpc.issues.panelApply
      .mutate({ id: issue.id, op: done ? 'todo-done' : 'todo-undone', index: index1 })
      .catch(() => {})
  }

  // "Only when the issue actually has them" — an empty evidence heading is
  // chrome, and the artifact does not render one.
  if (todos.length === 0 && artifacts.length === 0 && deferred.length === 0 && !issue.gitState)
    return null

  return (
    <DockPart title="Evidence & checks" testId="dock-evidence">
      {todos.length > 0 && (
        <>
          <div className="mb-1.5 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-success/80 transition-[width] duration-300"
                style={{ width: `${(doneCount / todos.length) * 100}%` }}
              />
            </div>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {doneCount}/{todos.length}
            </span>
          </div>
          <div className="mb-2 flex flex-col gap-0.5">
            {todos.map((t, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: todos are positional (1-based index API)
                key={i}
                className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 text-[12.5px] hover:bg-accent/50"
              >
                <Checkbox
                  checked={t.done}
                  onCheckedChange={(checked) => toggleTodo(i + 1, checked === true)}
                  className="mt-0.5"
                  aria-label={`${t.done ? 'Reopen' : 'Complete'} ${t.text}`}
                />
                <span
                  className={cn(
                    'transition-colors',
                    t.done
                      ? 'text-muted-foreground line-through decoration-muted-foreground/40'
                      : 'text-foreground',
                  )}
                >
                  {t.text}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {artifacts.length > 0 && (
        <div className="mb-2 flex flex-col gap-2.5">
          {artifacts.map((a) => {
            const kind = artifactKind(a.entry ?? a.path)
            const label = a.title ?? basename(a.path)
            // Snapshotted artifacts ([spec:SP-0fc9]) serve from the permanent
            // store; legacy path-only entries need the live worktree root.
            const src = artifactUrl({
              httpOrigin,
              issueId: issue.id,
              artifact: a,
              root,
              machineId,
            })
            if (src && kind === 'image') {
              return (
                <figure key={a.path}>
                  <button
                    data-pressable
                    type="button"
                    className="block w-full cursor-zoom-in"
                    title={`View ${label} full size`}
                    onClick={() => setLightbox({ kind: 'image', src, label })}
                  >
                    <img
                      src={src}
                      alt={label}
                      className="max-w-full rounded-md border border-border shadow-sm"
                    />
                  </button>
                  <figcaption className="mt-1 text-[11px] text-muted-foreground">
                    {label}
                  </figcaption>
                </figure>
              )
            }
            if (src && kind === 'video') {
              return (
                <figure key={a.path}>
                  {/* Inline preview only (first frame + play glyph); clicking
                      opens the lightbox, where the video plays with controls. */}
                  <button
                    data-pressable
                    type="button"
                    className="group relative block w-full cursor-zoom-in"
                    title={`Play ${label}`}
                    onClick={() => setLightbox({ kind: 'video', src, label })}
                  >
                    <video
                      src={src}
                      preload="metadata"
                      muted
                      className="pointer-events-none max-w-full rounded-md border border-border shadow-sm"
                    />
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="flex size-9 items-center justify-center rounded-full bg-black/55 text-white transition-colors group-hover:bg-black/75">
                        <Play size={16} aria-hidden="true" className="translate-x-px" />
                      </span>
                    </span>
                  </button>
                  <figcaption className="mt-1 text-[11px] text-muted-foreground">
                    {label}
                  </figcaption>
                </figure>
              )
            }
            return (
              <Button
                key={a.path}
                variant="ghost"
                size="sm"
                className="h-auto w-full justify-start gap-2 rounded-md px-1 py-1.5 text-left font-normal hover:bg-accent/60"
                disabled={!root && !a.artifactId}
                onClick={() => {
                  // Snapshotted artifacts ([spec:SP-0fc9]) open their stored bytes
                  // as an in-app artifact-scoped file tab — the source file may be
                  // gone, and openFileInWorktree re-homes the dock's Issue panel to
                  // root's containing workspace (#441). Only legacy path-only
                  // entries open as live worktree file tabs.
                  if (a.artifactId) {
                    openArtifact({
                      issueId: issue.id,
                      artifactId: a.artifactId,
                      path: a.entry ?? basename(a.path),
                      ...(root ? { worktreePath: root } : {}),
                    })
                  } else if (root) {
                    // Artifact paths may be worktree-relative; file tabs need absolute.
                    // Owned by this issue (POD-149) so the tab stays in its strip.
                    openFileInWorktree({
                      machineId,
                      root,
                      path: a.path.startsWith('/') ? a.path : `${root}/${a.path}`,
                      issueId: issue.id,
                    })
                  }
                }}
              >
                <FileText size={14} className="flex-none text-blue-300" />
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px]">
                  {label}
                </span>
                <span className="flex-none font-mono text-[10px] text-muted-foreground/60">
                  {basename(a.path)}
                </span>
              </Button>
            )
          })}
        </div>
      )}

      {deferred.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          {deferred.map((d) => (
            <div
              key={`${d.addedAt}:${d.text}`}
              className="flex items-baseline gap-2 px-1 py-0.5 text-[12.5px] text-foreground/80"
            >
              <span className="size-1 flex-none translate-y-[-2px] rounded-full bg-amber-400/70" />
              <span className="min-w-0 flex-1">{d.text}</span>
              <span className="flex-none font-mono text-[10px] text-muted-foreground/60">
                {new Date(d.addedAt).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      )}

      <IssueGitScope issue={issue} />
      {lightbox && <MediaLightbox {...lightbox} onClose={() => setLightbox(null)} />}
    </DockPart>
  )
}

/** One line of the intake canvas — the sessionless dock's only content shape. */
function IntakeField({
  label,
  value,
  loading = false,
}: {
  label: string
  value: string
  loading?: boolean
}): JSX.Element {
  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] items-center gap-2 border-t border-border/50 py-2.5 text-[12px]">
      <span className="font-mono text-[10px] text-muted-foreground/80">{label}</span>
      <span className={cn('min-w-0 truncate text-muted-foreground', loading && 'animate-pulse')}>
        {value}
      </span>
    </div>
  )
}

/** The dock with no inspected task. A conversation that has not become work yet
 *  is a normal state, not an error: this says what will appear and where, and
 *  never asks for a task to be created. */
function IntakeDock({ session }: { session?: SessionMeta }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="dock-intake">
      <header className="flex-none border-b border-border/60 px-3 pt-3 pb-3">
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground/70">
          {session ? (
            <KindIcon kind={session.agentKind} chip />
          ) : (
            <span className="size-1.5 rounded-full bg-muted-foreground/50" aria-hidden="true" />
          )}
          <span className="tracking-[0.06em] uppercase">Live session</span>
          <span className="ml-auto text-[10px] tracking-[0.08em] text-muted-foreground/60 uppercase">
            Ready
          </span>
        </div>
        <h2 className="mt-1.5 text-[14px] leading-snug font-semibold text-foreground">
          Conversation workspace
        </h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
          Start in chat. Task details, plan and team will appear here when the agent structures the
          work.
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-6">
        <DockPart title="Taking shape">
          <IntakeField label="Task" value="Waiting for your first message" loading />
          <IntakeField label="Plan" value="The agent will outline the work" />
          <IntakeField
            label="Team"
            value={
              session ? `${sessionDisplayName(session)} · ready` : 'Agents will appear as they join'
            }
          />
        </DockPart>
        <p className="text-[10.5px] leading-relaxed text-muted-foreground/60">
          If the conversation stays exploratory, this view stays light. Podium does not force a
          task.
        </p>
      </div>
    </div>
  )
}

/**
 * Issue tab of the right dock: the approved task inspector. A fixed head
 * (identity, title, description, controls), the decision band when the issue
 * needs you, and then ONE scroll — current update, work, agents & sessions,
 * relations, evidence, activity. No collapsible section chrome and no nested
 * per-subissue tier: the whole task reads top to bottom.
 */
export function IssuePanelView({
  cwd,
  machineId,
  sessionId,
  issueId,
}: {
  cwd: string
  machineId?: string
  sessionId?: string
  /** Explicit issue (artifact file tabs, [spec:SP-0fc9] #441) — wins over the
   *  session attachment and cwd containment. */
  issueId?: string
}): JSX.Element {
  const { sessions, setPane, setView, setOpenIssueId, markIssueRead, markSessionRead } =
    useStoreSelector(
      (s) => ({
        sessions: s.sessions,
        setPane: s.setPane,
        setView: s.setView,
        setOpenIssueId: s.setOpenIssueId,
        markIssueRead: s.markIssueRead,
        markSessionRead: s.markSessionRead,
      }),
      shallowEqual,
    )
  const issues = useReplicaIssues()
  const { setFocusedIssueId } = useOperatorFocus()
  const issue = useMemo(
    () =>
      cwd || sessionId || issueId
        ? issueForPanel({ issues, sessions, cwd, sessionId, issueId })
        : null,
    [issues, sessions, cwd, sessionId, issueId],
  )
  const issueById = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  // DIRECT children only — the artifact's Work section is one tier deep with a
  // completed fold, not a flattened recursive subtree.
  const children = useMemo(() => (issue ? subIssuesOf(issues, issue.id) : []), [issues, issue])
  // The whole subtree, for the meter only: "N of M done" describes the work the
  // task is answerable for, which is deeper than its direct children.
  const subtree = useMemo(() => {
    if (!issue) return []
    const out: IssueViewModel[] = []
    const seen = new Set<string>([issue.id])
    const walk = (parentId: string): void => {
      for (const child of subIssuesOf(issues, parentId)) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        out.push(child)
        walk(child.id)
      }
    }
    walk(issue.id)
    return out
  }, [issues, issue])
  // Typed relations (POD-85): the compact disclosure surface — the sidebar
  // whispers (⤷ tick), this panel names every edge.
  const relations = useMemo(() => (issue ? groupRelations(issue) : []), [issue])
  const [showCompleted, setShowCompleted] = useState(false)
  const [showAllActive, setShowAllActive] = useState(false)
  const [showRetired, setShowRetired] = useState(false)

  const focusIssue = (target: IssueViewModel): void => {
    setFocusedIssueId(target.id)
    void markIssueRead(target.id)
    const targetSessions = issueSessions(target, sessions)
      .filter(isOpenSession)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
    const targetSession =
      targetSessions.find((session) => session.sessionId === target.coordinatorSessionId) ??
      targetSessions[0]
    if (targetSession) {
      setPane('A', targetSession.sessionId)
      void markSessionRead(targetSession.sessionId)
    }
    setView('workspace')
  }

  if (!issue) {
    return <IntakeDock session={sessions.find((s) => s.sessionId === sessionId)} />
  }

  const scope = [issue, ...subtree]
  const done = scope.filter((i) => i.stage === 'done' || Boolean(i.closedReason)).length
  const run = scope.filter(
    (i) => !i.closedReason && (i.stage === 'in_progress' || i.stage === 'review'),
  ).length

  const openChildren = children.filter((c) => c.stage !== 'done' && !c.closedReason)
  const doneChildren = children.filter((c) => c.stage === 'done' || Boolean(c.closedReason))

  const all = issueSessions(issue, sessions)
  const activeSessions = all.filter(isOpenSession).sort((a, b) => {
    if (a.sessionId === issue.coordinatorSessionId) return -1
    if (b.sessionId === issue.coordinatorSessionId) return 1
    return b.lastActiveAt.localeCompare(a.lastActiveAt)
  })
  const retiredSessions = all.filter((s) => !isOpenSession(s))
  const shownSessions = showAllActive ? activeSessions : activeSessions.slice(0, 5)
  const moved = all.find((s) => s.handoffTarget)

  const author = coordinatorSession(issue, activeSessions)
  const notesAt = issue.notesUpdatedAt ?? issue.updatedAt

  const openFullIssue = (): void => {
    setOpenIssueId(issue.id)
    setView('issues')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <InspectHead issue={issue} />
      <IssueDecisionBand issue={issue} />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-6">
        <DockPart title="Current update" testId="dock-current-update">
          <div className="border-l-[3px] border-primary/60 pl-2.5">
            <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
              {author && <KindIcon kind={author.agentKind} chip />}
              <span className="min-w-0 truncate">
                Current{author ? ` · ${sessionDisplayName(author)}` : ''}
                {notesAt ? ` · ${relativeTime(notesAt, Date.now())}` : ''}
              </span>
            </div>
            <p
              className={cn(
                'mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed',
                issue.activityNotes ? 'text-foreground/85' : 'text-muted-foreground/60 italic',
              )}
            >
              {issue.activityNotes || 'No status posted yet.'}
            </p>
          </div>
          <SubtreeMeter done={done} run={run} total={scope.length} />
        </DockPart>

        {children.length > 0 && (
          <DockPart title="Work" count={children.length} testId="dock-subissues">
            {openChildren.map((sub) => (
              <UnifiedRow
                key={sub.id}
                sub={sub}
                meta={operationalState(sub, issueSessions(sub, sessions), issueById).label}
                onOpen={() => focusIssue(sub)}
              />
            ))}
            {doneChildren.length > 0 && (
              <>
                <FoldRow
                  open={showCompleted}
                  label={`Show ${doneChildren.length} completed`}
                  onToggle={() => setShowCompleted((v) => !v)}
                />
                {showCompleted &&
                  doneChildren.map((sub) => (
                    <UnifiedRow key={sub.id} sub={sub} meta="Done" onOpen={() => focusIssue(sub)} />
                  ))}
              </>
            )}
          </DockPart>
        )}

        <DockPart title="Agents & sessions" count={activeSessions.length} testId="dock-sessions">
          {activeSessions.length > 0 ? (
            shownSessions.map((session) => (
              <IssueSessionRow
                key={session.sessionId}
                session={session}
                onOpen={() => {
                  setPane('A', session.sessionId)
                  void markSessionRead(session.sessionId)
                  setView('workspace')
                }}
              />
            ))
          ) : (
            // A task with no agent is not an error — say why there is nobody on
            // it, in the same words the flight deck uses.
            <div
              className="flex items-center gap-2 px-1 py-1.5 text-[11.5px] text-muted-foreground"
              data-testid="dock-presence-note"
            >
              {moved ? (
                <>
                  <ArrowRight size={11} aria-hidden="true" />
                  Session moved to {moved.handoffTarget}
                </>
              ) : issue.stage === 'done' || issue.closedReason ? (
                <>
                  <Check size={11} aria-hidden="true" />
                  Completed · session retired
                </>
              ) : (
                <>
                  <Play size={11} aria-hidden="true" />
                  Ready to start
                </>
              )}
            </div>
          )}
          {activeSessions.length > 5 && (
            <FoldRow
              open={showAllActive}
              label={showAllActive ? 'Show fewer' : `${activeSessions.length - 5} more active`}
              onToggle={() => setShowAllActive((v) => !v)}
            />
          )}
          {retiredSessions.length > 0 && (
            <>
              <FoldRow
                open={showRetired}
                label={`Retired · ${retiredSessions.length}`}
                onToggle={() => setShowRetired((v) => !v)}
              />
              {showRetired &&
                retiredSessions.map((session) => (
                  <IssueSessionRow
                    key={session.sessionId}
                    session={session}
                    onOpen={() => {
                      setPane('A', session.sessionId)
                      setView('workspace')
                    }}
                  />
                ))}
            </>
          )}
        </DockPart>

        <DockPart
          title="Relations"
          count={relations.reduce((n, g) => n + g.entries.length, 0)}
          testId="dock-relations"
        >
          {relations.length === 0 ? (
            <Hint>No linked work.</Hint>
          ) : (
            relations.map((group) => (
              <div key={group.section} className="mb-1.5">
                <div className="mb-0.5 text-[9.5px] tracking-wide text-muted-foreground uppercase">
                  {group.section}
                </div>
                {group.entries.map((entry) => {
                  const target = issueById.get(entry.id)
                  return target ? (
                    <UnifiedRow
                      key={`${group.section}-${entry.direction}-${entry.id}`}
                      sub={target}
                      meta={entry.type}
                      onOpen={() => focusIssue(target)}
                    />
                  ) : (
                    <div
                      key={`${group.section}-${entry.direction}-${entry.id}`}
                      className="px-1 py-1 font-mono text-[11px] text-muted-foreground/60"
                    >
                      {entry.id}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </DockPart>

        <EvidenceAndChecks issue={issue} machineId={machineId} />

        {/* Activity sits LAST, as it does on the issue page and in the approved
            reference: it is history. Above the fold belongs to the live work —
            update, work, sessions, relations, evidence. */}
        <RecentActivity issue={issue} onOpenFull={openFullIssue} />

        <p className="text-[10.5px] leading-relaxed text-muted-foreground/60">
          The current update is this task's live state, kept by the agent working it; comments and
          lifecycle events form the activity feed.
        </p>
      </div>
    </div>
  )
}
