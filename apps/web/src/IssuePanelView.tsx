import { shallowEqual } from '@podium/client-core/store'
import type { IssueComment, IssueStage, IssueWire } from '@podium/protocol'
import { CircleAlert, CircleCheck, FileText, User } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { DockSection } from './DockSection'
import { subIssuesOf } from './derive'
import {
  artifactKind,
  basename,
  issueForPanel,
  panelNonEmpty,
  worktreeAssetUrl,
} from './dock-panel'
import { relativeTime } from './home'
import { STAGE_LABELS } from './issue-card'
import { useStoreSelector } from './store'

/** Stage → dot + tinted chip classes (token-tinted, works across the 4 themes). */
const STAGE_ACCENT: Record<IssueStage, { dot: string; chip: string }> = {
  backlog: { dot: 'bg-muted-foreground/50', chip: 'bg-muted text-muted-foreground' },
  planning: { dot: 'bg-sky-400', chip: 'bg-sky-400/15 text-sky-300' },
  in_progress: { dot: 'bg-amber-400', chip: 'bg-amber-400/15 text-amber-300' },
  review: { dot: 'bg-violet-400', chip: 'bg-violet-400/15 text-violet-300' },
  done: { dot: 'bg-emerald-400', chip: 'bg-emerald-400/15 text-emerald-300' },
}

function StageChip({ stage }: { stage: IssueStage }): JSX.Element {
  const a = STAGE_ACCENT[stage]
  return (
    <span
      className={cn(
        'inline-flex flex-none items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
        a.chip,
      )}
    >
      <span className={cn('size-1.5 rounded-full', a.dot)} />
      {STAGE_LABELS[stage]}
    </span>
  )
}

function Hint({ children }: { children: string }): JSX.Element {
  return <div className="py-0.5 text-xs text-muted-foreground/60 italic">{children}</div>
}

/** Latest checkpoint comment, expandable to the full history. Comment bodies no
 *  longer ride IssueWire (#175): the thread is fetched lazily via the
 *  issues.comments proc, re-fetched whenever the wire's commentCount moves.
 *  Legacy fallback: a pre-#175 payload may still embed `comments` (and a viaHub
 *  issue's thread lives on the hub, where the proc returns []) — use the
 *  embedded thread when the fetch comes back empty. */
function CommentsBlock({ issue }: { issue: IssueWire }): JSX.Element | null {
  const trpc = useStoreSelector((s) => s.trpc)
  const [showAll, setShowAll] = useState(false)
  const [comments, setComments] = useState<IssueComment[]>(issue.comments ?? [])
  const count = issue.commentCount ?? issue.comments?.length ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on issue switch / count change only; trpc is a stable store singleton
  useEffect(() => {
    let cancelled = false
    if (count === 0) {
      setComments([])
      return
    }
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
  }, [issue.id, count])
  if (count === 0 || comments.length === 0) return null
  const shown = showAll ? [...comments].reverse() : [comments[comments.length - 1]!]
  return (
    <div className="mt-2">
      <div className="flex flex-col gap-1.5">
        {shown.map((c) => (
          <div
            key={c.id}
            className="rounded-md border border-border/50 bg-background/40 px-2.5 py-1.5"
          >
            <div className="flex items-baseline gap-2 text-[10px] text-muted-foreground/70">
              <span className="font-mono">{c.author}</span>
              <span>{relativeTime(c.createdAt, Date.now())}</span>
            </div>
            <div className="mt-0.5 text-[12px] leading-relaxed whitespace-pre-wrap text-foreground/80">
              {c.body}
            </div>
          </div>
        ))}
      </div>
      {comments.length > 1 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {showAll ? 'Show latest only' : `Show all ${comments.length} comments`}
        </button>
      )}
    </div>
  )
}

/** Header card: identity, stage, meta, and the agent-maintained current state
 *  (activityNotes — posted via `podium issue state` or the assistant digest). */
function SummaryHeader({ issue }: { issue: IssueWire }): JSX.Element {
  const state = issue.activityNotes
    ? { text: issue.activityNotes, updatedAt: issue.notesUpdatedAt }
    : null
  const accent = STAGE_ACCENT[issue.stage]
  return (
    <header className="border-b border-border/60 px-3 pt-3 pb-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[11px] text-muted-foreground/70">#{issue.seq}</div>
          <h2 className="text-[14px] leading-snug font-semibold text-foreground">{issue.title}</h2>
        </div>
        <StageChip stage={issue.stage} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-mono">P{issue.priority}</span>
        {issue.assignee && (
          <span className="inline-flex items-center gap-1">
            <User size={11} aria-hidden="true" /> {issue.assignee}
          </span>
        )}
        {issue.blocked ? (
          <span className="inline-flex items-center gap-1 text-red-400">
            <CircleAlert size={11} aria-hidden="true" /> blocked
          </span>
        ) : issue.ready ? (
          <span className="inline-flex items-center gap-1 text-emerald-400">
            <CircleCheck size={11} aria-hidden="true" /> ready
          </span>
        ) : null}
        {issue.childCount > 0 && (
          <span className="font-mono tabular-nums">
            {issue.childDoneCount}/{issue.childCount} subissues done
          </span>
        )}
      </div>
      {/* Current state — the paragraph agents keep updated for the human. */}
      <div
        className={cn(
          'relative mt-2.5 rounded-md bg-muted/40 py-2 pr-2.5 pl-3.5 text-[13px] leading-relaxed',
          state ? 'text-foreground/90' : 'text-muted-foreground/60 italic',
        )}
      >
        <span
          className={cn('absolute inset-y-1.5 left-1.5 w-[3px] rounded-full', accent.dot)}
          aria-hidden="true"
        />
        {state ? state.text : 'No status posted yet.'}
        {state?.updatedAt && (
          <div className="mt-1 text-[10px] tracking-wide text-muted-foreground/60 uppercase">
            updated {relativeTime(state.updatedAt, Date.now())}
          </div>
        )}
      </div>
      <CommentsBlock issue={issue} />
    </header>
  )
}

function SubissueRow({ sub }: { sub: IssueWire }): JSX.Element {
  const a = STAGE_ACCENT[sub.stage]
  const closed = sub.stage === 'done' || Boolean(sub.closedReason)
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md px-1 py-1 text-[13px] hover:bg-accent/40',
        sub.archived && 'opacity-60',
      )}
    >
      <span className={cn('size-2 flex-none rounded-full', a.dot)} aria-hidden="true" />
      <span className="font-mono text-[11px] text-muted-foreground/70">#{sub.seq}</span>
      <span
        className={cn(
          'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap',
          closed && 'text-muted-foreground line-through decoration-muted-foreground/40',
        )}
      >
        {sub.title}
      </span>
      {sub.archived && (
        <span className="flex-none rounded border px-1 text-[10px] text-muted-foreground uppercase">
          archived
        </span>
      )}
      {sub.blocked && <span className="flex-none text-[10px] text-red-400 uppercase">blocked</span>}
    </div>
  )
}

/** Todo / Artifacts / Deferred for one issue, each in a collapsible section.
 *  `slug` namespaces persisted open-state and distinguishes subissue panels. */
function PanelSections({
  issue,
  machineId,
  slug,
}: {
  issue: IssueWire
  machineId?: string
  slug: string
}): JSX.Element {
  const { trpc, httpOrigin, openFileInWorktree } = useStoreSelector(
    (s) => ({ trpc: s.trpc, httpOrigin: s.httpOrigin, openFileInWorktree: s.openFileInWorktree }),
    shallowEqual,
  )
  const panel = issue.panel
  const todos = panel?.todos ?? []
  const artifacts = panel?.artifacts ?? []
  const deferred = panel?.deferred ?? []
  const doneCount = todos.filter((t) => t.done).length
  const root = issue.worktreePath

  const toggleTodo = (index1: number, done: boolean) => {
    void trpc.issues.panelApply
      .mutate({ id: issue.id, op: done ? 'todo-done' : 'todo-undone', index: index1 })
      .catch(() => {})
  }

  return (
    <>
      <DockSection storageKey={`${slug}.todo`} title="Todo" count={todos.length}>
        {todos.length === 0 ? (
          <Hint>No todos published.</Hint>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-emerald-400/80 transition-[width] duration-300"
                  style={{ width: `${todos.length ? (doneCount / todos.length) * 100 : 0}%` }}
                />
              </div>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {doneCount}/{todos.length}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              {todos.map((t, i) => (
                <label
                  // biome-ignore lint/suspicious/noArrayIndexKey: todos are positional (1-based index API)
                  key={i}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 text-[13px] hover:bg-accent/50"
                >
                  <Checkbox
                    checked={t.done}
                    onCheckedChange={(checked) => toggleTodo(i + 1, checked === true)}
                    className="mt-0.5"
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
                </label>
              ))}
            </div>
          </>
        )}
      </DockSection>

      <DockSection storageKey={`${slug}.artifacts`} title="Artifacts" count={artifacts.length}>
        {artifacts.length === 0 ? (
          <Hint>No artifacts published.</Hint>
        ) : (
          <div className="flex flex-col gap-2.5">
            {artifacts.map((a) => {
              const kind = artifactKind(a.path)
              const label = a.title ?? basename(a.path)
              if (root && kind === 'image') {
                return (
                  <figure key={a.path}>
                    <img
                      src={worktreeAssetUrl({ httpOrigin, root, path: a.path, machineId })}
                      alt={label}
                      className="max-w-full rounded-md border border-border shadow-sm"
                    />
                    <figcaption className="mt-1 text-[11px] text-muted-foreground">
                      {label}
                    </figcaption>
                  </figure>
                )
              }
              if (root && kind === 'video') {
                return (
                  <figure key={a.path}>
                    {/* biome-ignore lint/a11y/useMediaCaption: agent-published artifact videos have no captions */}
                    <video
                      src={worktreeAssetUrl({ httpOrigin, root, path: a.path, machineId })}
                      controls
                      className="max-w-full rounded-md border border-border shadow-sm"
                    />
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
                  className="h-auto w-full justify-start gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-left font-normal hover:bg-accent/60"
                  disabled={!root}
                  onClick={() => {
                    // Artifact paths may be worktree-relative; file tabs need absolute.
                    if (root)
                      openFileInWorktree({
                        machineId,
                        root,
                        path: a.path.startsWith('/') ? a.path : `${root}/${a.path}`,
                      })
                  }}
                >
                  <FileText size={14} className="flex-none text-blue-300" />
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
        )}
      </DockSection>

      <DockSection storageKey={`${slug}.deferred`} title="Deferred" count={deferred.length}>
        {deferred.length === 0 ? (
          <Hint>Nothing deferred.</Hint>
        ) : (
          <div className="flex flex-col gap-1">
            {deferred.map((d) => (
              <div
                key={`${d.addedAt}:${d.text}`}
                className="flex items-baseline gap-2 rounded-md px-1 py-0.5 text-[13px] text-foreground/80"
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
      </DockSection>
    </>
  )
}

/** Issue tab of the right dock: summary header (identity, stage, agent-posted
 *  current state), subissue overview, then the collapsible panel sections —
 *  for the issue owning the active worktree plus subissues with panels. */
export function IssuePanelView({
  cwd,
  machineId,
  sessionId,
}: {
  cwd: string
  machineId?: string
  sessionId?: string
}): JSX.Element {
  const { issues, sessions } = useStoreSelector(
    (s) => ({ issues: s.issues, sessions: s.sessions }),
    shallowEqual,
  )
  const issue = useMemo(
    () => issueForPanel({ issues, sessions, cwd, sessionId }),
    [issues, sessions, cwd, sessionId],
  )
  // Subissue list keeps archived children visible (marked); the per-child panel
  // sections below deliberately skip archived children so they don't clutter the
  // parent view (issue #133).
  const children = useMemo(() => (issue ? subIssuesOf(issues, issue.id) : []), [issues, issue])
  const subPanels = useMemo(
    () => children.filter((c) => !c.archived).filter(panelNonEmpty),
    [children],
  )

  if (!issue) {
    return (
      <div className="p-3 text-xs text-muted-foreground/70">
        No issue is attached to this session or worktree.
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <SummaryHeader issue={issue} />
      {children.length > 0 && (
        <DockSection storageKey="subissues" title="Subissues" count={children.length}>
          <div className="flex flex-col gap-0.5">
            {children.map((sub) => (
              <SubissueRow key={sub.id} sub={sub} />
            ))}
          </div>
        </DockSection>
      )}
      <PanelSections issue={issue} machineId={machineId} slug="main" />
      {subPanels.map((sub) => (
        <DockSection
          key={sub.id}
          storageKey={`sub.${sub.seq}`}
          title={`#${sub.seq} ${sub.title}`}
          accent={STAGE_ACCENT[sub.stage].dot}
          defaultOpen={false}
        >
          <PanelSections issue={sub} machineId={machineId} slug={`sub.${sub.seq}`} />
        </DockSection>
      ))}
    </div>
  )
}
