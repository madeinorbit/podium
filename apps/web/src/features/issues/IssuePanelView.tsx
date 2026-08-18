import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import {
  artifactKind,
  artifactUrl,
  basename,
  buildActivityFeed,
  deckDestinationFor,
  groupRelations,
  type IssueEvent,
  issueForPanel,
  operationalState,
  type PresenceKind,
  type PresenceNote,
  presenceNote,
  sessionNeedsHuman,
  subIssuesOf,
} from '@podium/client-core/viewmodels'
import {
  type IssueComment,
  type IssueId,
  issueStatusOf,
  type MachineId,
  type SessionId,
} from '@podium/model/browser'
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
  Truck,
} from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useOperatorFocus } from '@/app/operator-focus'
import { type IssueViewModel, useReplicaIssues, useStoreSelector } from '@/app/store'
import { MediaLightbox } from '@/components/MediaLightbox'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { copyToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { IssueExplorerList } from './explorer/IssueExplorerList'
import {
  DOCK_BODY,
  DOCK_ROW,
  DOCK_STAMP,
  IssueCompactControls,
  IssueDecisionBand,
  IssueGitScope,
  IssueSessionRow,
  isOpenSession,
  issueSessions,
} from './IssueCompactControls'
import { issueIdTitle } from './issue-card'
import { StatusGlyph } from './issue-glyphs'

// Where the task's identity lives, since POD-743: the HEAD of this panel. The
// dock title bar carried it between POD-516 and here, on the reasoning that the
// bar is every panel's one header; the bar now carries the issue explorer's
// trail — a position, not a name — so the name sits with the task again. The
// stage still survives exactly twice: the trail's glyph-free ref, and the stage
// dropdown's own label.

function Hint({ children }: { children: string }): JSX.Element {
  return <div className={cn(DOCK_BODY, 'py-0.5 text-text-faint italic')}>{children}</div>
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
  shipping: Truck,
}

/** Why nobody is on this task. A blank where an agent row would be is the one
 *  thing this section must never render — "no session" is several different
 *  situations and only one of them is a problem. */
function PresenceLine({ note }: { note: PresenceNote }): JSX.Element {
  const Icon = PRESENCE_ICON[note.kind]
  return (
    <div
      className={cn(
        'flex items-center gap-[7px] px-1 py-1.5',
        // `text-attention` is the ink; `-foreground` is what sits ON the amber
        // fill and is near-black, i.e. invisible on this panel. An attention
        // line is its own object in this design — set tighter and bolder than
        // the prose around it, because it is a statement rather than a reading.
        note.attention
          ? 'text-[11.5px] leading-none font-semibold text-attention'
          : cn(DOCK_BODY, 'text-muted-foreground'),
      )}
      data-testid="dock-presence-note"
      data-presence={note.kind}
    >
      <Icon size={note.attention ? 14 : 12} className="flex-none" aria-hidden="true" />
      {note.text}
    </div>
  )
}

/** A section of the single scroll. The approved inspector is one continuous
 *  read, so a section is a heading and a hairline — no chevron, no per-section
 *  collapse, no nested tier. */
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
    // 14px between sections, the design's own rhythm — close enough that the
    // scroll reads as one column of work rather than a stack of cards.
    <section className="mb-3.5" data-testid={testId} data-part={title}>
      {/* ONE row, always: label (+ its count, riding the label rather than
          standing apart from it) · the rule that reaches the far edge · the
          optional fact parked past it. The rule is --border, not
          --hairline-soft: it is a section seam, not a row rule, and the two
          tiers exist so a heading never reads at the same weight as the rows
          under it. */}
      <div className="mb-1.5 flex items-center gap-2">
        <span className="shell-type-micro flex-none font-semibold text-muted-foreground">
          {title}
          {count !== undefined && count > 0 && (
            <span className="ml-1 font-medium text-text-faint tabular-nums">{count}</span>
          )}
        </span>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
        {meta && (
          <span className={cn(DOCK_STAMP, 'flex-none tabular-nums text-text-faint')}>{meta}</span>
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
      // Wholly mono: a fold summary counts things, and half a mono line was the
      // one place this scroll changed voice mid-sentence.
      className="w-full px-1 py-1.5 text-left font-mono text-[11px] leading-none text-text-dim hover:text-foreground"
    >
      <span className="mr-1">{open ? '⌄' : '›'}</span>
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
        DOCK_ROW,
        'grid min-h-[30px] w-full grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2 border-b border-hairline-soft px-1 py-1 text-left text-foreground hover:bg-accent/40',
        sub.archived && 'opacity-60',
      )}
    >
      <StatusGlyph status={issueStatusOf(sub)} size={12} />
      <span className="min-w-0 truncate">
        {/* The ref is an address, not part of the sentence — mono, and the
            faintest ink on the row, so the title is what the eye lands on. */}
        <span className="mr-1.5 font-mono text-[10px] text-text-faint" title={issueIdTitle(sub)}>
          {issueDisplayRef(sub)}
        </span>
        <span
          className={cn(
            closed && 'text-muted-foreground line-through decoration-muted-foreground/40',
          )}
        >
          {sub.title}
        </span>
        {sub.archived && (
          <span className="ml-1.5 font-mono text-[10px] text-text-faint uppercase tracking-[0.04em]">
            archived
          </span>
        )}
      </span>
      <span
        className={cn(
          DOCK_STAMP,
          'flex-none',
          needs ? 'font-semibold text-attention' : 'text-text-faint',
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
 * Segment vocabulary is the Flight Deck's mission bar, down to the doses: done
 * in `--success`, running in the working blue `--live`. A live count is never
 * amber — amber on this branch means "this is asking something of you" and
 * nothing else. Renders nothing at all when there is nothing to count, so an
 * empty list never grows a rule.
 *
 * THE TRACK IS A WELL, NOT A PILL (POD-725), and a segment is an EXTENT rather
 * than a filled bar: `--background` ground one tier below the column, a 26%
 * tint you would struggle to name the hue of, and the exact figure carried by a
 * solid 2px datum rule along that extent's floor. Same two devices, same
 * percentages, as `.gauge-band` — a saturated slab here and a well in the deck
 * would be two kinds of object saying one kind of thing. At 6px there is no
 * room for the gauge's inner padding or its reading, so the extents meet edge
 * to edge and the reading stays outside the track.
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
      <span className="flex h-1.5 flex-1 overflow-hidden rounded-[3px] bg-background shadow-[inset_0_1px_2px_var(--carve-drop)]">
        <span
          className="h-full bg-success/26 shadow-[inset_0_-2px_0_var(--success)] transition-[width] duration-300"
          style={{ width: pct(done) }}
        />
        <span
          className="h-full bg-live/26 shadow-[inset_0_-2px_0_var(--live)] transition-[width] duration-300"
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
 * under the old "Evidence & checks" heading is what made that section read as a
 * junk drawer. Reference information: compact, mono, and late in the scroll.
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
        <div className="flex items-center gap-1.5 px-1 py-1 font-mono text-[10.5px] leading-[1.6] text-muted-foreground">
          <Folder size={12} className="flex-none" aria-hidden="true" />
          <span className="min-w-0 truncate" title={root}>
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
 *  moves. Legacy fallback: a pre-#175 payload may still embed `comments` — use
 *  the embedded thread when the fetch comes back empty. */
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
      <div className="flex flex-col gap-1.5" data-testid="dock-recent-activity">
        {shown.length === 0 ? (
          <Hint>Nothing has happened here yet.</Hint>
        ) : (
          shown.map((item) => (
            <div
              key={item.id}
              className={cn(DOCK_ROW, 'flex items-start gap-2 px-1 py-1 text-muted-foreground')}
            >
              {item.kind === 'comment' ? (
                <MessageSquare size={11} className="mt-1 flex-none text-text-faint" />
              ) : (
                <History size={11} className="mt-1 flex-none text-text-faint" />
              )}
              <span className="min-w-0 flex-1 whitespace-pre-wrap">
                {item.kind === 'comment' ? item.body : item.line.text}
              </span>
              <span className={cn(DOCK_STAMP, 'mt-0.5 flex-none text-text-faint')}>
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
 * This box is laid out before the single scroll and never shrinks, so its
 * height is the scroll's budget — and every clamp that used to defend that
 * budget was itself a complaint. The description still lives DOWN in the
 * scroll, where length is free; the TITLE is bounded here at two lines.
 *
 * The title came BACK here in POD-743. It moved to the dock title bar under
 * POD-516 because the bar was the panel's one header and had nothing else to
 * say; the bar now carries the explorer's trail, which is a position rather
 * than a name, so the name returns to the surface it names. It takes the dock's
 * own step up (`shell-type-reading`), not the task page's 18px subject step —
 * this is a column you live in, not a sheet you visit.
 */
function InspectHead({
  issue,
  onWorkOnThis,
}: {
  issue: IssueViewModel
  /** Point the rest of the shell at this task. The ONE control on this surface
   *  that moves the app: the explorer syncs INWARD, so browsing a stranger's
   *  task must never drag the deck along with it, and the operator who does
   *  want to go there needs one obvious way to say so. It is a BUTTON in the
   *  control strip since POD-1269, not a text link on the ref line. */
  onWorkOnThis?: () => void
}): JSX.Element {
  return (
    <header className="flex-none px-3.5 pt-2.5 pb-3" data-testid="dock-inspect-head">
      <div className="flex items-center gap-2 font-mono text-[11px] leading-none text-text-dim">
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
      <h2
        className="shell-type-reading mt-1.5 line-clamp-2 font-semibold text-secondary-foreground"
        title={issue.title}
        data-testid="dock-title"
      >
        {issue.title}
      </h2>
      <IssueCompactControls issue={issue} onWorkOnThis={onWorkOnThis} />
    </header>
  )
}

/**
 * Post an update without leaving the panel (POD-743).
 *
 * Pinned to the foot rather than placed in the scroll, for the same reason the
 * task page pins its own: commenting is something you decide to do, not
 * something you scroll to find. Pinning it is also what freed the sections
 * above to be ordered by how fast their facts move, instead of by how badly the
 * composer needed to be near the top.
 *
 * RECEDES UNTIL USED (POD-635), like the page's composer: at rest a flat
 * one-line well with no edge of its own; the enclosure arrives on focus.
 */
function DockCommentComposer({ issue }: { issue: IssueViewModel }): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [focused, setFocused] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => {
    setBody('')
    setFocused(false)
  }, [issue.id])
  const active = focused || body.trim().length > 0
  const post = (): void => {
    const text = body.trim()
    if (!text || busy) return
    setBusy(true)
    void trpc.issues.addComment
      .mutate({ id: issue.id, author: 'me', body: text })
      .then(() => setBody(''))
      .catch(() => {
        // Keep what they typed: a dropped mutation must not eat the words.
      })
      .finally(() => setBusy(false))
  }
  return (
    <div className="flex-none border-border/35 border-t bg-card/15 px-3 py-2">
      <Textarea
        value={body}
        disabled={busy}
        placeholder={`Comment on ${issueDisplayRef(issue)}…`}
        aria-label={`Comment on ${issueDisplayRef(issue)}`}
        data-testid="dock-comment"
        className={cn(
          'resize-none rounded-[9px] text-[12px]',
          'transition-[min-height,border-color,background-color] duration-150',
          active
            ? 'min-h-[58px]'
            : 'min-h-[30px] border-transparent bg-input/20 hover:border-border/60 dark:bg-input/20',
        )}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            post()
          }
        }}
      />
      {active && (
        <div className="mt-1.5 flex items-center justify-end gap-2">
          <span className="font-mono shell-type-micro text-text-faint">⌘↵</span>
          <Button type="button" size="sm" disabled={busy || !body.trim()} onClick={post}>
            {busy ? 'Posting…' : 'Post'}
          </Button>
        </div>
      )}
    </div>
  )
}

/** What the work produced, and what it parked — artifacts, then deferred notes,
 *  each under its own plain heading.
 *
 *  This used to be one "Evidence & checks" heading over three lists. Two of
 *  them have since left: the branch and worktree are an address rather than a
 *  verification result and moved to {@link CheckoutPart}, and the todo
 *  checklist is gone from the dock entirely (POD-1071) — the operator read the
 *  section as a junk drawer, and an agent's private plan is not something the
 *  human is meant to tick off here. The full issue page still lists todos for
 *  anyone who wants them. What is left is named for what it is. */
function ProducedAndDeferred({
  issue,
  machineId,
}: {
  issue: IssueViewModel
  machineId?: MachineId
}): JSX.Element | null {
  const { httpOrigin, openFileInWorktree, openArtifact } = useStoreSelector(
    (s) => ({
      httpOrigin: s.httpOrigin,
      openFileInWorktree: s.openFileInWorktree,
      openArtifact: s.openArtifact,
    }),
    shallowEqual,
  )
  const panel = issue.panel
  const artifacts = panel?.artifacts ?? []
  const deferred = panel?.deferred ?? []
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

  // "Only when the issue actually has them" — an empty heading is chrome, and
  // the artifact does not render one.
  if (artifacts.length === 0 && deferred.length === 0) return null

  return (
    <>
      {artifacts.length > 0 && (
        <DockPart title="Artifacts" count={artifacts.length} testId="dock-artifacts">
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
                  <span
                    className={cn(
                      DOCK_ROW,
                      'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap',
                    )}
                  >
                    {label}
                  </span>
                  <span className={cn(DOCK_STAMP, 'flex-none text-text-faint')}>
                    {basename(a.path)}
                  </span>
                </Button>
              )
            })}
          </div>
        </DockPart>
      )}

      {deferred.length > 0 && (
        <DockPart title="Deferred" count={deferred.length} testId="dock-deferred">
          <div className="mb-2 flex flex-col gap-1">
            {deferred.map((d) => (
              <div
                key={`${d.addedAt}:${d.text}`}
                className={cn(
                  DOCK_BODY,
                  'flex items-baseline gap-2 px-1 py-0.5 text-foreground/80',
                )}
              >
                {/* A deferred note is a parked idea, not an obligation — amber
                  would claim it needs the operator now. */}
                <span className="size-1 flex-none translate-y-[-2px] rounded-full bg-text-faint" />
                <span className="min-w-0 flex-1">{d.text}</span>
                <span className={cn(DOCK_STAMP, 'flex-none text-text-faint')}>
                  {new Date(d.addedAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        </DockPart>
      )}

      {lightbox && <MediaLightbox {...lightbox} onClose={() => setLightbox(null)} />}
    </>
  )
}

/**
 * Issue tab of the right dock: the approved task inspector. A two-row fixed
 * head (ref, controls), the decision band when the issue needs you, and then
 * ONE scroll — the description, then current update, subtasks, agents &
 * sessions, relations, artifacts, branch & worktree, activity. No collapsible
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
  onNavigate,
}: {
  cwd: string
  machineId?: MachineId
  sessionId?: SessionId
  /** Explicit issue (artifact file tabs, [spec:SP-0fc9] #441) — wins over the
   *  session attachment and cwd containment. */
  issueId?: IssueId
  /**
   * Where a linked task goes when it is clicked (POD-743).
   *
   * Inside the explorer this PUSHES a level — the operator is browsing, and a
   * relation row that silently re-pointed the workspace at another task would
   * be a navigation the trail cannot show or undo. Without it a linked row
   * moves the shell instead, because there is no trail to walk back along.
   */
  onNavigate?: (issueId: IssueId) => void
}): JSX.Element {
  const {
    sessions,
    setPane,
    setView,
    setOpenIssueId,
    setSelectedIssueId,
    markIssueRead,
    markSessionRead,
  } = useStoreSelector(
    (s) => ({
      sessions: s.sessions,
      setPane: s.setPane,
      setView: s.setView,
      setOpenIssueId: s.setOpenIssueId,
      setSelectedIssueId: s.setSelectedIssueId,
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

  /**
   * Move the SHELL to a task (POD-1151).
   *
   * Setting focus alone — all this used to do — arrives nowhere: the sidebar
   * highlights `selectedIssueId`, a mission ROOT, and `resolveFocus` discards a
   * focus naming a task that mission does not contain. Both halves now, as a
   * sidebar row click and the deck's `openDeparture` do: SELECT the top-level
   * issue the task hangs from (itself when it already is one), then FOCUS the
   * task within it.
   */
  const showInDeck = (target: IssueViewModel): void => {
    const root = deckDestinationFor(issues, sessions, target.id)
    if (!root) return
    setSelectedIssueId(root.id)
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

  /** What a linked task row does: browse deeper in the explorer, or — with no
   *  trail to browse in — move the shell as it always did. */
  const openLinked = (target: IssueViewModel): void => {
    if (onNavigate) {
      void markIssueRead(target.id)
      onNavigate(target.id)
      return
    }
    showInDeck(target)
  }

  // NO ISSUE, NO PANEL OF ITS OWN. An id that resolves to nothing is not a
  // state worth describing — the explorer's own level 0 is what "no task" looks
  // like, and it is a place you can act from. This used to render an intake
  // canvas written for a chat that had not become work yet, which on a level
  // pointed at a real-but-unshowable task read as a panel about nothing
  // (POD-1277). The trail collapses to match, in the explorer's own effect.
  if (!issue) {
    return <IssueExplorerList />
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
  // The whole slice as the fourth argument, not just this issue's sessions: a
  // hop's destination holds none of THESE, and reading where the work went is
  // what tells a vacated origin from one whose agent simply retired.
  const presence = presenceNote(issue, all, issueById, sessions)

  const notesAt = issue.notesUpdatedAt ?? issue.updatedAt
  const parent = issue.parentId ? issueById.get(issue.parentId) : undefined

  const openFullIssue = (): void => {
    setOpenIssueId(issue.id)
    setView('issues')
  }

  // WORKABLE: the same predicate the control strip closes on — a closure with a
  // reason, or an archive, is the end of the work. `deckDestinationFor` already
  // refuses an archived or deleted target; this adds the outcome half, which it
  // has no reason to know about.
  const workable = !issue.closedReason && !issue.archived

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* TWO BOXES, and only two. Everything above the scroll lives in this
          `flex-none` region and is bounded by construction (a ref line, one
          control row, a one-line decision band — no free text at all); the
          scroll below it is `flex-1 min-h-0` and gets all the rest. The dock
          became unscrollable the moment something data-sized (a stack of offer
          cards) was allowed into the fixed region — see the scroll test. */}
      <div className="flex-none border-b border-border/60" data-testid="dock-fixed">
        {/* Offered only where it can arrive: inside the explorer, which has a
            trail to leave, and only for a task the deck can put on screen. A
            control that lands nowhere is worse than no control (POD-1151) — and
            since POD-1269, only for a task there is still work to do on. A
            finished or archived task has a history to read, not a seat to take. */}
        <InspectHead
          issue={issue}
          onWorkOnThis={
            onNavigate && workable && deckDestinationFor(issues, sessions, issue.id)
              ? () => showInDeck(issue)
              : undefined
          }
        />
        <IssueDecisionBand issue={issue} />
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-3.5 pt-3 pb-6"
        data-testid="dock-scroll"
        data-dock-scroll=""
      >
        {/* The task in the author's own words, UNCAPPED (POD-516 r3 #2). It sits
            in the scroll rather than the fixed head precisely so it can be: the
            three-line clamp existed to protect the scroll's height budget, and
            down here there is no budget to protect. One step up from the dock's
            12px body, at prose leading — it is the one paragraph on this surface
            anybody reads, and `shell-type-primary` would have collapsed that
            step to half a pixel under compact density. */}
        {issue.description.trim() && (
          <p
            className="mb-3.5 text-[13px] leading-[1.6] whitespace-pre-wrap text-muted-foreground"
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
              DOCK_BODY,
              'px-1 whitespace-pre-wrap',
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

        {/* WHAT THE WORK PRODUCED, high (POD-743). The scroll used to be
            ordered by how fast each fact moves, which put the artifacts below
            two sections of roster. That order was right when this panel was the only
            place a task's shape was visible; the Flight Deck shows the shape now,
            and what is left for the dock to be good at is judging a task and
            acting on it. So the things you came to look at — the artifacts, then
            what happened — come first, and the structure the deck already draws
            (subtasks, relations, the roster) sits underneath.

            Both parts render nothing at all when the task has none, so a task
            that produced no artifacts opens on its timeline rather than on an
            empty heading. */}
        <ProducedAndDeferred issue={issue} machineId={machineId} />

        {/* History, immediately under the output it explains — the two
            questions "what came out of this" and "what has been happening" are
            asked together, and they were three sections apart. */}
        <RecentActivity issue={issue} />

        {/* ── Below here is STRUCTURE, not action ──────────────────────
            The deck draws this tree in the column to the left. It stays in the
            panel because the explorer can reach tasks the deck is not showing,
            and because relations are how you walk between them — but it is
            reference, and reference goes under. Archive is a live-list hide,
            not an identity hide: a parent or child that has been archived
            still belongs in this column, marked so the operator can see the
            edge that would otherwise look deleted. */}
        {issue.parentId && (
          <DockPart title="Parent" testId="dock-parent">
            {parent ? (
              <UnifiedRow
                sub={parent}
                meta={parent.archived ? 'Archived' : 'Parent'}
                onOpen={() => openLinked(parent)}
              />
            ) : (
              <Hint>{issue.parentId}</Hint>
            )}
          </DockPart>
        )}
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
                  onOpen={() => openLinked(sub)}
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
                    <UnifiedRow key={sub.id} sub={sub} meta="Done" onOpen={() => openLinked(sub)} />
                  ))}
              </>
            )}
          </DockPart>
        )}

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
                      onOpen={() => openLinked(target)}
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

        {/* Where the work happens — an address, not a check. */}
        <CheckoutPart issue={issue} />
      </div>
      <DockCommentComposer issue={issue} />
    </div>
  )
}
