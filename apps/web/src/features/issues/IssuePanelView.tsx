import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import {
  artifactKind,
  artifactUrl,
  basename,
  groupRelations,
  issueForPanel,
  operationalState,
  type PresenceKind,
  type PresenceNote,
  presenceNote,
  sessionNeedsHuman,
  subIssuesOf,
} from '@podium/client-core/viewmodels'
import type { IssueComment, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import {
  ArrowDown,
  ArrowRight,
  Ban,
  Check,
  CircleAlert,
  ExternalLink,
  FileText,
  Folder,
  History,
  type LucideIcon,
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
import { cn } from '@/lib/utils'
import { KindIcon, sessionDisplayName } from '@/lib/WorkerLabel'
import {
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

// Where the task's identity lives, since POD-516 r3: the DOCK TITLE BAR carries
// the stage glyph and the title (RightDock.tsx), because the title bar is every
// panel's one header. So the head below it keeps only what the bar cannot say —
// the ref, and the one control strip — and the stage survives exactly twice, in
// the bar and as the stage dropdown's own label.

function Hint({ children }: { children: string }): JSX.Element {
  return <div className="shell-type-secondary py-0.5 text-text-faint italic">{children}</div>
}

/** Presence-note kind → its mark. The words come from `mission.ts` so the deck
 *  and the dock say the same thing about the same task; only the glyph is local
 *  to this surface. */
const PRESENCE_ICON: Record<PresenceKind, LucideIcon> = {
  moved: ArrowRight,
  blocked: Ban,
  waiting: ArrowDown,
  done: Check,
  review: Check,
  ready: Play,
  attention: CircleAlert,
}

/** Why nobody is on this task. A blank where an agent row would be is the one
 *  thing this section must never render — "no session" is several different
 *  situations and only one of them is a problem. */
function PresenceLine({ note }: { note: PresenceNote }): JSX.Element {
  const Icon = PRESENCE_ICON[note.kind]
  return (
    <div
      className={cn(
        'shell-type-secondary flex items-center gap-2 px-1 py-1.5',
        // `text-attention` is the ink; `-foreground` is what sits ON the amber
        // fill and is near-black, i.e. invisible on this panel.
        note.attention ? 'text-attention' : 'text-muted-foreground',
      )}
      data-testid="dock-presence-note"
      data-presence={note.kind}
    >
      <Icon size={11} aria-hidden="true" />
      {note.text}
    </div>
  )
}

/** A section of the single scroll. Deliberately NOT a DockSection: the approved
 *  inspector is one continuous read, so a section is a heading and a hairline —
 *  no chevron, no per-section collapse, no nested tier. */
function DockPart({
  title,
  count,
  meta,
  testId,
  children,
}: {
  title: string
  count?: number
  /** One machine-voice fact ABOUT the section, parked past the hairline — an
   *  age, a size. It goes here rather than inside the body so the body stays
   *  the thing the section is actually for. */
  meta?: string
  testId?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="mb-[18px]" data-testid={testId} data-part={title}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="shell-type-micro font-semibold text-muted-foreground">{title}</span>
        {count !== undefined && count > 0 && (
          <span className="shell-type-micro font-mono tabular-nums text-text-dim">{count}</span>
        )}
        <span className="h-px flex-1 bg-hairline-soft" aria-hidden="true" />
        {meta && (
          <span className="shell-type-micro flex-none font-mono tabular-nums text-text-faint">
            {meta}
          </span>
        )}
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
      className="shell-type-micro w-full px-1 py-1.5 text-left text-muted-foreground hover:text-foreground"
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
  needs = false,
  onOpen,
}: {
  sub: IssueViewModel
  meta: string
  /** This row's work is stopped on the operator. The mark is the state word in
   *  attention ink — the SAME mark the sidebar's row (UnifiedIssueRow) and the
   *  Flight Deck's task line use, so one task never reads three ways in three
   *  columns. No box, no rule, no icon: one amber voice per row. */
  needs?: boolean
  onOpen: () => void
}): JSX.Element {
  const closed = sub.stage === 'done' || Boolean(sub.closedReason)
  return (
    <button
      data-pressable
      type="button"
      onClick={onOpen}
      data-needs-you={needs || undefined}
      title={`${issueDisplayRef(sub)} ${sub.title}`}
      className={cn(
        'grid min-h-[30px] w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 border-b border-hairline-soft px-1 py-1 text-left shell-type-secondary hover:bg-accent/40',
        sub.archived && 'opacity-60',
      )}
    >
      <StageGlyph stage={sub.stage} size={13} />
      <span className="min-w-0 truncate">
        <span
          className="shell-type-micro mr-1.5 font-mono text-muted-foreground"
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
      <span
        className={cn(
          'shell-type-micro flex-none font-mono',
          needs ? 'font-semibold text-attention' : 'text-text-dim',
        )}
      >
        {meta}
      </span>
    </button>
  )
}

/**
 * ONE meter primitive, and it always sits with the list it counts (POD-516 r3
 * #4). It used to float under the current update measuring a subtree nobody had
 * on screen, which is how it came to say "0 of 1 done" about an issue with no
 * children — a number describing nothing visible.
 *
 * Segment vocabulary is the Flight Deck's mission bar: done in success, running
 * in the calm info blue. A live count is never amber — amber on this branch
 * means "this is asking something of you" and nothing else. Renders nothing at
 * all when there is nothing to count, so an empty list never grows a rule.
 */
function ProgressMeter({
  done,
  run = 0,
  total,
  testId,
}: {
  done: number
  run?: number
  total: number
  testId: string
}): JSX.Element | null {
  if (total === 0) return null
  const pct = (n: number): string => `${(n / total) * 100}%`
  return (
    <div className="mb-2 flex items-center gap-2" data-testid={testId}>
      <span className="flex h-1 flex-1 overflow-hidden rounded-full bg-secondary">
        <span
          className="h-full bg-success transition-[width] duration-300"
          style={{ width: pct(done) }}
        />
        <span
          className="h-full bg-info transition-[width] duration-300"
          style={{ width: pct(run) }}
        />
      </span>
      <span className="shell-type-micro flex-none font-mono tabular-nums text-text-dim">
        {done} of {total} done
      </span>
    </div>
  )
}

/**
 * Where this task lives (POD-516 r3 #6). A branch and a worktree path are not
 * evidence and not a check — they are the address of the work, and filing them
 * under "Evidence & checks" is what made that section read as a junk drawer.
 * Reference information: compact, mono, and late in the scroll.
 */
function CheckoutPart({ issue }: { issue: IssueViewModel }): JSX.Element | null {
  // An issue with no dedicated worktree is worked in the repo's own checkout —
  // that is still an address, and saying nothing there is what sent the
  // operator hunting for the branch in the git panel.
  const root = issue.worktreePath ?? issue.repoPath
  if (!issue.gitState && !root) return null
  return (
    <DockPart title="Branch & worktree" testId="dock-checkout">
      <IssueGitScope issue={issue} />
      {root && (
        <div className="shell-type-micro flex items-center gap-1.5 px-1 py-1 text-muted-foreground">
          <Folder size={12} className="flex-none" aria-hidden="true" />
          <span className="min-w-0 truncate font-mono" title={root}>
            {root}
          </span>
        </div>
      )}
    </DockPart>
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
function RecentActivity({ issue }: { issue: IssueViewModel }): JSX.Element {
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: `issue.updatedAt` is the refetch key, not a read — it is the whole point of POD-532
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
              className="shell-type-secondary flex items-start gap-2 px-1 py-1 text-foreground/80"
            >
              {item.kind === 'comment' ? (
                <MessageSquare size={11} className="mt-1 flex-none text-muted-foreground" />
              ) : (
                <History size={11} className="mt-1 flex-none text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 whitespace-pre-wrap">
                {item.kind === 'comment' ? item.body : item.line.text}
              </span>
              <span className="shell-type-micro flex-none font-mono text-text-faint">
                {relativeTime(item.ts, Date.now())}
              </span>
            </div>
          ))
        )}
      </div>
      {/* No "open full activity" button here any more: the one exit to the full
          issue is the timeline link under the current update, where the operator
          asked for it. Two links to the same destination in one scroll is the
          same fact said twice. */}
    </DockPart>
  )
}

/**
 * The task head: the ref and the one control strip. Fixed above the scroll —
 * the artifact's `inspect-head`.
 *
 * **Nothing in here is text that varies in LENGTH any more** (POD-516 r3 #1/#2/
 * #7). This box is laid out before the single scroll and never shrinks, so its
 * height is the scroll's budget — and every clamp that used to defend that
 * budget was itself a complaint: a two-line title cut, a three-line description
 * cut. So the title moved up into the dock title bar (one header per panel) and
 * the description moved DOWN into the scroll, where length is free. What is
 * left is two fixed rows, ~62px, and it cannot grow at all.
 *
 * The word "Task" is gone from the ref line for the same reason: the title bar
 * above already says which panel this is.
 */
function InspectHead({ issue }: { issue: IssueViewModel }): JSX.Element {
  return (
    <header className="flex-none px-3 pt-2.5 pb-3" data-testid="dock-inspect-head">
      <div className="shell-type-micro flex items-center gap-2 font-mono text-text-dim">
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
      </div>
      <IssueCompactControls issue={issue} />
    </header>
  )
}

/** Todos / Artifacts / Deferred — what the work actually produced and what it
 *  still owes, inline under one heading rather than three collapsibles. The
 *  branch and worktree used to ride along at the bottom of this section; they
 *  are an address, not a verification result, and they now have their own
 *  ({@link CheckoutPart}). */
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
  if (todos.length === 0 && artifacts.length === 0 && deferred.length === 0) return null

  return (
    <DockPart title="Evidence & checks" testId="dock-evidence">
      {todos.length > 0 && (
        <>
          {/* The same meter as Subtasks, reading the same way, sitting with the
              list it counts — two progress surfaces that disagreed about their
              own grammar was half of why the other one read as random. */}
          <ProgressMeter done={doneCount} total={todos.length} testId="dock-todos-meter" />
          <div className="mb-2 flex flex-col gap-0.5">
            {todos.map((t, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: todos are positional (1-based index API)
                key={i}
                className="shell-type-secondary flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-accent/50"
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
                  <figcaption className="shell-type-micro mt-1 text-muted-foreground">
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
                  <figcaption className="shell-type-micro mt-1 text-muted-foreground">
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
                <span className="shell-type-secondary min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {label}
                </span>
                <span className="shell-type-micro flex-none font-mono text-text-faint">
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
              className="shell-type-secondary flex items-baseline gap-2 px-1 py-0.5 text-foreground/80"
            >
              {/* A deferred note is a parked idea, not an obligation — amber
                  would claim it needs the operator now. */}
              <span className="size-1 flex-none translate-y-[-2px] rounded-full bg-text-faint" />
              <span className="min-w-0 flex-1">{d.text}</span>
              <span className="shell-type-micro flex-none font-mono text-text-faint">
                {new Date(d.addedAt).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      )}

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
    <div className="shell-type-secondary grid grid-cols-[52px_minmax(0,1fr)] items-center gap-2 border-t border-border/50 py-2.5">
      <span className="shell-type-micro font-mono text-muted-foreground/80">{label}</span>
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
      <header
        className="flex-none border-b border-border/60 px-3 pt-3 pb-3"
        data-testid="dock-fixed"
      >
        <div className="shell-type-micro flex items-center gap-2 font-mono text-text-dim">
          {session ? (
            <KindIcon kind={session.agentKind} chip />
          ) : (
            <span className="size-1.5 rounded-full bg-muted-foreground/50" aria-hidden="true" />
          )}
          <span className="label-mono">Live session</span>
          <span className="label-mono ml-auto">Ready</span>
        </div>
        <h2 className="shell-type-reading mt-1.5 font-semibold text-foreground">
          Conversation workspace
        </h2>
        <p className="shell-type-secondary mt-1.5 text-muted-foreground">
          Start in chat. Task details, plan and team will appear here when the agent structures the
          work.
        </p>
      </header>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-6"
        data-testid="dock-scroll"
        data-dock-scroll=""
      >
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
        <p className="shell-type-micro text-text-faint">
          If the conversation stays exploratory, this view stays light. Podium does not force a
          task.
        </p>
      </div>
    </div>
  )
}

/**
 * Issue tab of the right dock: the approved task inspector. A two-row fixed
 * head (ref, controls), the decision band when the issue needs you, and then
 * ONE scroll — the description, then current update, subtasks, agents &
 * sessions, relations, evidence, branch & worktree, activity. No collapsible
 * section chrome and no nested per-subissue tier: the whole task reads top to
 * bottom.
 *
 * The scroll is ordered by how fast the fact moves. What the task IS (its
 * description) never changes; what it is DOING right now changes by the minute;
 * where it lives changes once; what happened is already over. Reading down the
 * panel is therefore reading forward in time, which is why the history sits
 * last and the address sits just above it.
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
  // DIRECT children only — the artifact's Subtasks section is one tier deep
  // with a completed fold, not a flattened recursive subtree. The meter counts
  // exactly this list and nothing else (POD-516 r3 #4): it used to walk the
  // whole subtree AND count the issue itself, which is how a childless task
  // came to wear a progress bar reading "0 of 1 done".
  const children = useMemo(() => (issue ? subIssuesOf(issues, issue.id) : []), [issues, issue])
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

  const openChildren = children.filter((c) => c.stage !== 'done' && !c.closedReason)
  const doneChildren = children.filter((c) => c.stage === 'done' || Boolean(c.closedReason))
  const runningChildren = openChildren.filter(
    (c) => c.stage === 'in_progress' || c.stage === 'review',
  ).length

  const all = issueSessions(issue, sessions)
  // Needs-you first — the answer affordance now lives on the session row, and
  // the roster folds at five, so a waiting agent must never be the one behind
  // the fold. Then the coordinator, then most-recently-active.
  const activeSessions = all.filter(isOpenSession).sort((a, b) => {
    const aNeeds = sessionNeedsHuman(a)
    const bNeeds = sessionNeedsHuman(b)
    if (aNeeds !== bNeeds) return aNeeds ? -1 : 1
    if (a.sessionId === issue.coordinatorSessionId) return -1
    if (b.sessionId === issue.coordinatorSessionId) return 1
    return b.lastActiveAt.localeCompare(a.lastActiveAt)
  })
  const retiredSessions = all.filter((s) => !isOpenSession(s))
  const shownSessions = showAllActive ? activeSessions : activeSessions.slice(0, 5)
  // Total over the stage vocabulary since POD-516/9a05afd59: the only null is
  // "this issue has live sessions", which is the branch that renders agent rows
  // instead. No local fallback — a second set of words here is what drifts.
  const presence = presenceNote(issue, all, issueById)

  const notesAt = issue.notesUpdatedAt ?? issue.updatedAt

  const openFullIssue = (): void => {
    setOpenIssueId(issue.id)
    setView('issues')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* TWO BOXES, and only two. Everything above the scroll lives in this
          `flex-none` region and is bounded by construction (a ref line, one
          control row, a one-line decision band — no free text at all); the
          scroll below it is `flex-1 min-h-0` and gets all the rest. The dock
          became unscrollable the moment something data-sized (a stack of offer
          cards) was allowed into the fixed region — see the scroll test. */}
      <div className="flex-none border-b border-border/60" data-testid="dock-fixed">
        <InspectHead issue={issue} />
        <IssueDecisionBand issue={issue} />
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-6"
        data-testid="dock-scroll"
        data-dock-scroll=""
      >
        {/* The task in the author's own words, UNCAPPED (POD-516 r3 #2). It sits
            in the scroll rather than the fixed head precisely so it can be: the
            three-line clamp existed to protect the scroll's height budget, and
            down here there is no budget to protect. One step up from the shell's
            12px body — it is the one paragraph on this surface anybody reads. */}
        {issue.description.trim() && (
          <p
            className="shell-type-primary mb-[18px] whitespace-pre-wrap text-muted-foreground"
            data-testid="dock-description"
          >
            {issue.description}
          </p>
        )}

        {/* The agent's name is NOT here (POD-516 r3 #3): the roster two sections
            down is where agents are listed, and the update was repeating it. The
            age moved onto the heading rule, so the body is only the words. */}
        <DockPart
          title="Current update"
          testId="dock-current-update"
          meta={notesAt ? relativeTime(notesAt, Date.now()) : undefined}
        >
          <p
            className={cn(
              'shell-type-secondary px-1 whitespace-pre-wrap',
              issue.activityNotes ? 'text-foreground/85' : 'text-text-faint italic',
            )}
          >
            {issue.activityNotes || 'No status posted yet.'}
          </p>
          <button
            data-pressable
            type="button"
            onClick={openFullIssue}
            data-testid="dock-open-full-activity"
            className="shell-type-micro mt-1 w-full px-1 py-1.5 text-left text-muted-foreground hover:text-foreground"
          >
            Full update timeline <ExternalLink size={10} className="inline align-[-1px]" />
          </button>
        </DockPart>

        {children.length > 0 && (
          <DockPart title="Subtasks" count={children.length} testId="dock-subissues">
            <ProgressMeter
              done={doneChildren.length}
              run={runningChildren}
              total={children.length}
              testId="dock-subtasks-meter"
            />
            {openChildren.map((sub) => {
              const state = operationalState(sub, issueSessions(sub, sessions), issueById)
              return (
                <UnifiedRow
                  key={sub.id}
                  sub={sub}
                  meta={state.label}
                  needs={state.state === 'needs-you'}
                  onOpen={() => focusIssue(sub)}
                />
              )
            })}
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
          {activeSessions.length > 0
            ? shownSessions.map((session) => (
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
            : // A task with no agent is not an error — say why there is nobody on
              // it, in the FLIGHT DECK'S OWN WORDS (mission.ts owns the vocabulary),
              // so one task never reads two ways in two columns.
              presence && <PresenceLine note={presence} />}
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
                <div className="label-mono mb-0.5">{group.section}</div>
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
                      className="shell-type-micro px-1 py-1 font-mono text-text-faint"
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

        {/* Where the work happens — an address, not a check. */}
        <CheckoutPart issue={issue} />

        {/* Activity sits LAST, as it does on the issue page and in the approved
            reference: it is history. Above it belongs the live work — update,
            subtasks, sessions, relations, evidence — and then the address.
            The footnote that used to close this scroll ("the current update is
            this task's live state…") is gone: it explained two section headings
            to an operator who reads them every day. */}
        <RecentActivity issue={issue} />
      </div>
    </div>
  )
}
