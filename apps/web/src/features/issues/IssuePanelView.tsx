import { shallowEqual } from '@podium/client-core/shallow-equal'
import { artifactKind, artifactUrl, basename, operationalState } from '@podium/client-core/values'
import type { issuePages, PageIssue } from '@podium/client-graph/issue-page'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { resolveMachinePath } from '@podium/model'
import type { IssueId, IssuePanelArtifact, MachineId, SessionId } from '@podium/model/browser'
import { isFinished } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import {
  ArrowRight,
  Bot,
  CircleDot,
  ExternalLink,
  FileText,
  Film,
  Image as ImageIcon,
  Play,
} from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { DockHeaderActions } from '@/app/DockHeaderSlot'
import { useOperatorFocus } from '@/app/operator-focus'
import { type IssueViewModel, useRuntimeSelector } from '@/app/store'
import { ArtifactLightbox, artifactLightboxKey } from '@/components/ArtifactLightbox'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useOpenArtifactsTab } from '@/features/files/artifacts-tab'
import { modChord } from '@/lib/mod-chord'
import { cn } from '@/lib/utils'
import { SessionNameEditor } from '@/lib/WorkerLabel'
import { currentWorkspaceSlug } from '@/lib/workspace-request'
import { inlineRenameEditor, useInlineRename } from '../worklist/use-inline-rename'
import { useFirstArtifactAnchor } from './first-artifact-tip'
import { IssueCompactControls } from './IssueCompactControls'
import { IssueStatusPicker } from './IssueStatusPicker'
import { issueIdTitle } from './issue-card'
import { IssueAge } from './issue-page/IssueAge'
import { useIssueHistory } from './issue-page/IssueHistory'
import { edgeIssue, useIssueEdgeResolver } from './issue-page/issue-edges'
import { issueObserver as observer } from './issue-page/issue-observer'
import { useIssuePageContext } from './issue-page/issue-page-data'
import { useIssueStatusApply } from './use-issue-status-apply'

// THE CALM COLUMN (POD-2077). One scroll, read top to bottom: the name and its
// status, what the task is, then what it produced, what it is linked to, and what
// people said about it. Every section heading is the same
// quiet label + count; nothing in the column is boxed, and nothing is amber —
// the offer card in chat is where a task asks for the operator now, so the
// panel's old "Needs you" band, its roster, its activity log and its branch
// address all left it. The Flight Deck, the chat header and the footer each
// already say those things.

/** A section of the single scroll: one quiet heading line — label, count, and
 *  an optional action parked at the right — over its rows. */
const PanelSection = observer(function PanelSection({
  title,
  count,
  action,
  testId,
  className,
  children,
}: {
  title: string
  count?: number
  action?: ReactNode
  testId?: string
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section
      className={cn('flex flex-col gap-2', className)}
      data-testid={testId}
      data-part={title}
    >
      <div className="flex items-baseline gap-2 text-[11.5px]">
        <span className="font-semibold text-muted-foreground">{title}</span>
        {count !== undefined && count > 0 && (
          <span className="text-text-faint tabular-nums">{count}</span>
        )}
        <span className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  )
})

/** A section's right-hand text action ("View all"): text, not a button shape. */
function SectionAction({
  children,
  onClick,
  testId,
}: {
  children: string
  onClick: () => void
  testId?: string
}): JSX.Element {
  return (
    <button
      data-pressable
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="text-text-dim transition-colors hover:text-foreground"
    >
      {children}
    </button>
  )
}

/** `#2042` — the short address a row wears at its right edge. The full ref
 *  rides the row's tooltip. */
function shortRef(issue: IssueViewModel): string {
  const ref = issueDisplayRef(issue)
  const n = /-(\d+)$/.exec(ref)?.[1]
  return n ? `#${n}` : ref
}

function issueTitle(issue: IssueViewModel): string {
  return 'authoredTitle' in issue ? (issue as PageIssue).authoredTitle : issue.title
}

/**
 * One linked task: an optional type label in the left column (printed once
 * per group), the status ring — which is also the row's status picker
 * (POD-1271) — the title, and the short ref. A finished task reads one ink step
 * down rather than struck through.
 */
const LinkRow = observer(function LinkRow({
  issue,
  label,
  trailing,
  trailingTone,
  onOpen,
  onStatusPick,
}: {
  issue: IssueViewModel
  /** The group label column. `undefined` drops the column (subtask rows);
   *  `''` keeps it empty, for every row of a group after its first. */
  label?: string
  /** Overrides the short ref, for a subtask that is waiting on someone. */
  trailing?: string
  trailingTone?: 'attention' | 'error'
  onOpen: (issue: IssueViewModel) => void
  onStatusPick: (issue: IssueViewModel, value: string) => void
}): JSX.Element {
  const closed = isFinished(issue) || issue.archived
  const title = issueTitle(issue)
  return (
    <button
      data-pressable
      type="button"
      onClick={() => onOpen(issue)}
      title={`${issueDisplayRef(issue)} ${title}${issue.archived ? ' · archived' : ''}`}
      data-testid="dock-link-row"
      className="flex h-[26px] w-full min-w-0 items-center gap-2 rounded-[5px] text-left text-[12.5px] hover:bg-accent/40"
    >
      {label !== undefined && (
        <span className="w-[78px] flex-none truncate text-[11px] text-text-faint">{label}</span>
      )}
      <IssueStatusPicker
        issue={issue}
        size={10}
        calm
        onPick={(value) => onStatusPick(issue, value)}
      />
      <span className={cn('min-w-0 flex-1 truncate', closed ? 'text-text-dim' : 'text-foreground')}>
        {title}
        {issue.archived && (
          <span className="ml-1.5 font-mono text-[10px] tracking-[0.04em] text-text-faint uppercase">
            archived
          </span>
        )}
      </span>
      <span
        className={cn(
          'flex-none font-mono text-[10.5px]',
          trailingTone === 'error'
            ? 'font-semibold text-destructive'
            : trailingTone === 'attention'
              ? 'font-semibold text-attention'
              : 'text-text-faint',
        )}
        title={trailing ? undefined : issueIdTitle(issue)}
      >
        {trailing ?? shortRef(issue)}
      </span>
    </button>
  )
})

/**
 * The task head: the name (renameable in place, POD-1618), then the status
 * pill with the subtask count beside it. "Open in Work" is the external-link
 * mark in the dock's title bar, beside the dock's own close, so the head holds
 * only what this task IS.
 */
const InspectHead = observer(function InspectHead({
  issue,
  title,
  onRename,
  onOpenInWork,
  subtasks,
}: {
  issue: IssueViewModel
  /** What this task is CALLED — `issueDisplayTitle`, derived once by the panel
   *  body. Never `issue.title` (POD-1618): a draft carries the composer's
   *  placeholder there. */
  title: string
  onRename: (next: string) => void
  /** Point the rest of the shell at this task. The panel syncs INWARD, so
   *  looking at a task must never drag the deck along; this is the one way to. */
  onOpenInWork?: () => void
  subtasks?: ReactNode
}): JSX.Element {
  const rename = useInlineRename(title, onRename)
  const renameEditor = inlineRenameEditor(rename, ({ value, onCommit, onCancel }) => (
    <SessionNameEditor
      value={value}
      onCommit={onCommit}
      onCancel={onCancel}
      className="w-full min-w-0 rounded-sm border border-primary/60 bg-background px-1 py-0 text-[17px] leading-[22px] font-semibold tracking-[-0.015em] text-text-strong outline-none"
    />
  ))
  return (
    <header className="flex flex-col gap-2.5" data-testid="dock-inspect-head">
      {onOpenInWork && (
        <DockHeaderActions>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 flex-none text-text-dim"
            data-testid="task-open-in-work"
            title="Open this task in the Work view"
            aria-label="Open in Work"
            onClick={onOpenInWork}
          >
            <ExternalLink size={14} aria-hidden="true" />
          </Button>
        </DockHeaderActions>
      )}
      {renameEditor ?? (
        <h2
          className="line-clamp-3 cursor-text text-[17px] leading-[22px] font-semibold tracking-[-0.015em] text-text-strong"
          title={title}
          data-testid="dock-title"
          onDoubleClick={() => rename.begin()}
        >
          {title}
        </h2>
      )}
      <IssueCompactControls issue={issue} onRename={rename.begin} meta={subtasks} />
    </header>
  )
})

/** Comment authors that are the system talking rather than a person. */
function machineAuthor(author: string): boolean {
  return (
    author === 'steward' ||
    author === 'agent' ||
    author === 'coordinator' ||
    /^(system|issue|session|agent):/.test(author)
  )
}

function authorName(author: string): string {
  if (author === 'me') return 'You'
  if (author.startsWith('system:')) return 'System'
  if (author.startsWith('issue:')) return `Task ${author.slice('issue:'.length)}`
  if (author.startsWith('agent:') || author.startsWith('session:')) return 'Agent'
  return author.charAt(0).toUpperCase() + author.slice(1)
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const [first = '', second = ''] = words
  const letters = second ? `${first.charAt(0)}${second.charAt(0)}` : first.charAt(0)
  return letters.toUpperCase()
}

/** How many comments the column shows before folding the older ones. */
const COMMENTS_SHOWN = 3

/**
 * The thread, oldest first, then the field to add to it. Comment bodies are
 * read through the shared issue history (window 0: comments and mail only, no
 * event pages), the same fetch the old activity list made.
 *
 * The field recedes until used (POD-635): a one-line well at rest; Post and the
 * chord arrive on focus.
 */
const CommentsPart = observer(function CommentsPart({
  issue,
}: {
  issue: IssueViewModel
}): JSX.Element {
  const trpc = useRuntimeSelector((s) => s.trpc)
  const history = useIssueHistory(issue, 0)
  const activity = history?.activity
  void activity?.revision
  const comments = (activity?.history.items ?? []).flatMap((item) =>
    item.kind === 'comment' ? [item] : [],
  )
  const [showAll, setShowAll] = useState(false)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [focused, setFocused] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => {
    setBody('')
    setFocused(false)
    setShowAll(false)
  }, [issue.id])
  const active = focused || body.trim().length > 0
  const shown = showAll ? comments : comments.slice(-COMMENTS_SHOWN)
  const hidden = comments.length - shown.length
  const post = (): void => {
    const text = body.trim()
    if (!text || busy) return
    setBusy(true)
    void trpc.issues.addComment
      .mutate({ id: issue.id, body: text })
      .then(() => setBody(''))
      .catch(() => {
        // Keep what they typed: a dropped mutation must not eat the words.
      })
      .finally(() => setBusy(false))
  }
  return (
    <PanelSection
      title="Comments"
      count={comments.length}
      testId="dock-comments"
      className="gap-2.5"
      action={
        hidden > 0 ? (
          <SectionAction onClick={() => setShowAll(true)}>{`Show ${hidden} earlier`}</SectionAction>
        ) : undefined
      }
    >
      {shown.map((comment) => {
        const machine = machineAuthor(comment.author)
        const name = authorName(comment.author)
        return (
          <div key={comment.id} className="flex gap-[9px]" data-testid="dock-comment-row">
            <span
              className={cn(
                'flex size-[22px] flex-none items-center justify-center rounded-full text-[10px] font-semibold',
                machine ? 'bg-live/15 text-live' : 'bg-muted text-muted-foreground',
              )}
              aria-hidden="true"
            >
              {machine ? <Bot size={11} /> : initials(name)}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex gap-1.5 text-[11.5px]">
                <span className="font-semibold text-foreground">{name}</span>
                <span className="text-text-faint">
                  <IssueAge stamp={comment.ts} />
                </span>
              </div>
              <ClampedText
                text={comment.body}
                className="text-foreground"
                testId="dock-comment-body"
              />
            </div>
          </div>
        )
      })}
      <div>
        <Textarea
          value={body}
          disabled={busy}
          placeholder="Add a comment…"
          aria-label={`Comment on ${issueDisplayRef(issue)}`}
          data-testid="dock-comment"
          className={cn(
            'resize-none rounded-[8px] border-border bg-card px-3 py-2 text-[12.5px] dark:bg-card',
            'transition-[min-height] duration-150 ease-out',
            active ? 'min-h-[64px]' : 'min-h-9',
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
            <span className="font-mono text-[10.5px] text-text-faint">{modChord('↵')}</span>
            <Button type="button" size="sm" disabled={busy || !body.trim()} onClick={post}>
              {busy ? 'Posting…' : 'Post'}
            </Button>
          </div>
        )}
      </div>
    </PanelSection>
  )
})

/** "Work continued in SYN-24": a quiet line that opens the task it names. */
function ContinuationLine({
  text,
  target,
  onOpen,
}: {
  text: string
  target: IssueViewModel | null
  onOpen: (issue: IssueViewModel) => void
}): JSX.Element {
  const body = (
    <>
      <ArrowRight size={12} className="flex-none text-text-faint" aria-hidden="true" />
      {text}
    </>
  )
  return target ? (
    <button
      data-pressable
      type="button"
      data-testid="dock-continuation"
      onClick={() => onOpen(target)}
      className="-mt-2 flex w-fit items-center gap-1.5 text-left text-[12px] text-text-dim transition-colors hover:text-foreground"
    >
      {body}
    </button>
  ) : (
    <p
      data-testid="dock-continuation"
      className="-mt-2 flex items-center gap-1.5 text-[12px] text-text-dim"
    >
      {body}
    </p>
  )
}

/**
 * Text clamped to four lines with an ellipsis (fidelity review P2-4). The full
 * text rides the tooltip, and a click unfolds it in place. `pre-line` keeps
 * the author's line breaks. Comments and the latest update both use it.
 */
function ClampedText({
  text,
  className,
  testId,
}: {
  text: string
  className: string
  testId: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a reading convenience; the full text is in the title
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: same
    <p
      className={cn(
        'text-[12.5px] leading-[18px] whitespace-pre-line break-words',
        className,
        !open && 'line-clamp-4 cursor-pointer',
      )}
      title={open ? undefined : text}
      data-testid={testId}
      onClick={() => setOpen(true)}
    >
      {text}
    </p>
  )
}

/** `10-11` — the artifact list's date column, month and day. */
function shortDate(stamp: string): string {
  const d = new Date(stamp)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** How many non-preview artifacts the column lists before "View all". */
const ARTIFACT_ROWS = 3

/**
 * What the work produced: two previews side by side, then a short list of the
 * rest, newest first. "View all" opens the Artifacts stage tab when the host
 * supplies `onViewAll`; without it the list unfolds in place, so no artifact is
 * ever out of reach from this column.
 *
 * Deferred notes follow under their own heading — the operator decides on
 * those, so they stay in the panel, but only when there are any.
 */
const ArtifactsPart = observer(function ArtifactsPart({
  issue,
  machineId,
  onViewAll,
}: {
  issue: IssueViewModel
  machineId?: MachineId
  onViewAll?: () => void
}): JSX.Element | null {
  const { httpOrigin, openFileInWorktree, openArtifact } = useRuntimeSelector(
    (s) => ({
      httpOrigin: s.httpOrigin,
      openFileInWorktree: s.openFileInWorktree,
      openArtifact: s.openArtifact,
    }),
    shallowEqual,
  )
  const panel = issue.panel
  const all = panel?.artifacts ?? []
  // Files people attached in the issue's chats (POD-2148) are kept for the
  // chat's thumbnails, not published: they sit under their own folded heading
  // so they never crowd out what the agent put up for review.
  const artifacts = all.filter((a) => a.chatUploadId === undefined)
  const chatUploads = all.filter((a) => a.chatUploadId !== undefined)
  const deferred = panel?.deferred ?? []
  // An issue with no dedicated worktree is worked in the repo's primary
  // checkout — serve its artifacts from there.
  const root = issue.worktreePath ?? issue.repoPath
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [uploadsOpen, setUploadsOpen] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => {
    setExpanded(false)
    setUploadsOpen(false)
  }, [issue.id])

  const tipAnchor = useFirstArtifactAnchor('panel', artifacts.length > 0 ? issue.id : undefined)

  if (all.length === 0 && deferred.length === 0) return null

  const srcOf = (a: IssuePanelArtifact): string | null =>
    // Snapshotted artifacts ([spec:SP-0fc9]) serve from the permanent store;
    // legacy path-only entries need the live worktree root.
    artifactUrl({
      httpOrigin,
      workspace: currentWorkspaceSlug(),
      issueId: issue.id,
      artifact: a,
      root,
      machineId,
    }) ?? null
  const kindOf = (a: IssuePanelArtifact) => artifactKind(a.entry ?? a.path)
  const newest = [...artifacts].reverse()
  const media = newest.filter((a) => {
    const kind = kindOf(a)
    return (kind === 'image' || kind === 'video') && srcOf(a)
  })
  const previews = media.slice(0, 2)
  const rest = newest.filter((a) => !previews.includes(a))
  const listed = expanded ? rest : rest.filter((a) => !media.includes(a)).slice(0, ARTIFACT_ROWS)
  const more = artifacts.length > previews.length + listed.length

  const open = (a: IssuePanelArtifact): void => {
    const kind = kindOf(a)
    if ((kind === 'image' || kind === 'video') && srcOf(a)) {
      setLightbox(artifactLightboxKey(a))
      return
    }
    // Snapshotted artifacts open their stored bytes as an artifact-scoped file
    // tab; only legacy path-only entries open as live worktree file tabs.
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
        path: resolveMachinePath(root, a.path),
        issueId: issue.id,
      })
    }
  }

  const artifactRow = (a: IssuePanelArtifact, testId: string, anchor?: string): JSX.Element => {
    const kind = kindOf(a)
    const Icon = kind === 'image' ? ImageIcon : kind === 'video' ? Film : FileText
    return (
      <button
        key={a.path}
        data-pressable
        type="button"
        data-testid={testId}
        data-tip-anchor={anchor}
        disabled={!root && !a.artifactId}
        onClick={() => open(a)}
        title={a.path}
        className="flex h-[30px] w-full min-w-0 items-center gap-2 rounded-[5px] text-left text-[12.5px] text-foreground hover:bg-accent/40 disabled:opacity-50"
      >
        <Icon size={13} className="flex-none text-text-faint" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{a.title ?? basename(a.path)}</span>
        <span className="flex-none font-mono text-[10.5px] text-text-faint">
          {shortDate(a.addedAt)}
        </span>
      </button>
    )
  }

  return (
    <>
      {artifacts.length > 0 && (
        <PanelSection
          title="Artifacts"
          count={artifacts.length}
          testId="dock-artifacts"
          action={
            onViewAll ? (
              <SectionAction onClick={onViewAll} testId="dock-artifacts-view-all">
                View all
              </SectionAction>
            ) : more || expanded ? (
              <SectionAction
                onClick={() => setExpanded((v) => !v)}
                testId="dock-artifacts-view-all"
              >
                {expanded ? 'Show fewer' : 'View all'}
              </SectionAction>
            ) : undefined
          }
        >
          {previews.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {previews.map((a, i) => {
                const label = a.title ?? basename(a.path)
                const src = srcOf(a) ?? undefined
                const video = kindOf(a) === 'video'
                return (
                  <figure key={a.path} className="flex min-w-0 flex-col gap-1.5">
                    <button
                      data-pressable
                      type="button"
                      data-tip-anchor={i === 0 ? tipAnchor : undefined}
                      className="group relative block aspect-[4/3] w-full cursor-zoom-in overflow-hidden rounded-[7px] border border-border bg-muted"
                      title={video ? `Play ${label}` : `View ${label} full size`}
                      onClick={() => open(a)}
                    >
                      {video ? (
                        <>
                          <video
                            src={src}
                            preload="metadata"
                            muted
                            className="pointer-events-none size-full object-cover object-top"
                          />
                          <span className="absolute inset-0 flex items-center justify-center">
                            <span className="flex size-8 items-center justify-center rounded-full bg-black/55 text-white transition-colors group-hover:bg-black/75">
                              <Play size={14} aria-hidden="true" className="translate-x-px" />
                            </span>
                          </span>
                        </>
                      ) : (
                        <img
                          src={src}
                          alt={label}
                          loading="lazy"
                          decoding="async"
                          className="size-full object-cover object-top"
                        />
                      )}
                    </button>
                    <figcaption className="truncate text-[11.5px] text-muted-foreground">
                      {label}
                    </figcaption>
                  </figure>
                )
              })}
            </div>
          )}
          {listed.length > 0 && (
            <div className="flex flex-col">
              {listed.map((a, i) =>
                artifactRow(
                  a,
                  'dock-artifact-row',
                  i === 0 && previews.length === 0 ? tipAnchor : undefined,
                ),
              )}
            </div>
          )}
        </PanelSection>
      )}

      {chatUploads.length > 0 && (
        <PanelSection
          title="Chat uploads"
          count={chatUploads.length}
          testId="dock-chat-uploads"
          action={
            <SectionAction
              onClick={() => setUploadsOpen((v) => !v)}
              testId="dock-chat-uploads-toggle"
            >
              {uploadsOpen ? 'Hide' : 'Show'}
            </SectionAction>
          }
        >
          {uploadsOpen && (
            <div className="flex flex-col">
              {[...chatUploads].reverse().map((a) => artifactRow(a, 'dock-chat-upload-row'))}
            </div>
          )}
        </PanelSection>
      )}

      {deferred.length > 0 && (
        <PanelSection title="Deferred" count={deferred.length} testId="dock-deferred">
          <div className="flex flex-col gap-1">
            {deferred.map((d) => (
              <div
                key={`${d.addedAt}:${d.text}`}
                className="flex items-baseline gap-2 text-[12.5px] leading-[18px] text-foreground"
              >
                {/* A deferred note is a parked idea, not an obligation — amber
                    would claim it needs the operator now. */}
                <span className="size-1 flex-none translate-y-[-2px] rounded-full bg-text-faint" />
                <span className="min-w-0 flex-1">{d.text}</span>
                <span className="flex-none font-mono text-[10.5px] text-text-faint">
                  {shortDate(d.addedAt)}
                </span>
              </div>
            ))}
          </div>
        </PanelSection>
      )}

      {lightbox && (
        <ArtifactLightbox
          // Browse within the group the opened file belongs to.
          artifacts={
            chatUploads.some((a) => artifactLightboxKey(a) === lightbox) ? chatUploads : artifacts
          }
          selected={lightbox}
          onSelect={setLightbox}
          onClose={() => setLightbox(null)}
          httpOrigin={httpOrigin}
          issueId={issue.id}
          root={root}
          machineId={machineId}
        />
      )}
    </>
  )
})

/** What the task panel says when it has no task to show. */
export function IssuePanelEmpty(): JSX.Element {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-8 pb-16 text-center"
      data-testid="dock-issue-empty"
    >
      <CircleDot size={20} strokeWidth={1.6} className="mb-1 text-text-faint" aria-hidden="true" />
      <p className="text-[13px] font-medium text-text-strong">No task selected</p>
      <p className="text-[12px] leading-[1.5] text-pretty text-muted-foreground">
        Pick a task in the sidebar or the Flight Deck and its details show up here.
      </p>
    </div>
  )
}

/**
 * Issue tab of the right dock: the task panel. One scroll — head, description,
 * the latest update (clamped), artifacts, relations, comments.
 */
import { PoolIssuePanelView } from './pool-issue-page'

export const IssuePanelView = observer(function IssuePanelView(
  props: Parameters<typeof IssuePanelBody>[0],
): JSX.Element {
  return <PoolIssuePanelView {...props} />
})

export const IssuePanelBody = observer(function IssuePanelBody({
  cwd: _cwd,
  machineId,
  sessionId: _sessionId,
  issueId: _issueId,
  onNavigate,
  onViewAllArtifacts,
}: {
  cwd: string
  machineId?: MachineId
  sessionId?: SessionId
  /** Explicit issue (artifact file tabs, [spec:SP-0fc9] #441) — wins over the
   *  session attachment and cwd containment. */
  issueId?: IssueId
  /**
   * Where a linked task goes when it is clicked. In the dock this points the
   * panel at it and leaves the shell alone; without it a linked row moves the
   * shell instead.
   */
  onNavigate?: (issueId: IssueId) => void
  /** Open the Artifacts stage tab for an issue (POD-2078). Absent, "View all"
   *  opens it through the shared opener. */
  onViewAllArtifacts?: (issueId: IssueId) => void
}): JSX.Element {
  const page = useIssuePageContext()!
  const detail = page.views.row(page.issue.id)
  const { updateIssue, setPane, setView, setSelectedIssueId, markIssueRead, markSessionRead } =
    useRuntimeSelector(
      (s) => ({
        updateIssue: s.updateIssue,
        setPane: s.setPane,
        setView: s.setView,
        setSelectedIssueId: s.setSelectedIssueId,
        markIssueRead: s.markIssueRead,
        markSessionRead: s.markSessionRead,
      }),
      shallowEqual,
    )
  const resolve = useIssueEdgeResolver()
  const openArtifactsTab = useOpenArtifactsTab()
  // Every task row in this column carries its own status door (POD-1271); the
  // apply and its close guard are shared by all of them, once, here.
  const rowStatus = useIssueStatusApply()
  const { setFocusedIssueId } = useOperatorFocus()
  const issue = page.issue
  const [showSubtasks, setShowSubtasks] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => setShowSubtasks(false), [issue?.id])

  /**
   * Move the SHELL to a task (POD-1151): SELECT the top-level issue the task
   * hangs from, then FOCUS the task within it, and put its agent on screen.
   */
  const showInDeck = useCallback(
    (target: IssueViewModel): void => {
      const root = page.views.destination(target.id)
      if (!root || typeof root === 'symbol') return
      const resolved = page.views.row(target.id).dockActiveSessions
      if (!resolved || typeof resolved === 'symbol') return
      setSelectedIssueId(root.id)
      setFocusedIssueId(target.id)
      void markIssueRead(target.id)
      const targetSession =
        resolved.find((session) => session.sessionId === target.coordinatorSessionId) ??
        resolved.reduce<(typeof resolved)[number] | undefined>(
          (latest, session) =>
            !latest || session.lastActiveAt > latest.lastActiveAt ? session : latest,
          undefined,
        )
      if (targetSession) {
        setPane('A', targetSession.sessionId)
        void markSessionRead(targetSession.sessionId)
      }
      setView('workspace')
    },
    [
      page.views,
      setSelectedIssueId,
      setFocusedIssueId,
      markIssueRead,
      setPane,
      markSessionRead,
      setView,
    ],
  )

  /** What a linked task row does: show it in this panel, or — outside the
   *  dock — move the shell. */
  const openLinked = useCallback(
    (target: IssueViewModel): void => {
      if (onNavigate) {
        void markIssueRead(target.id)
        onNavigate(target.id)
        return
      }
      showInDeck(target)
    },
    [onNavigate, markIssueRead, showInDeck],
  )

  const children = detail.children
  if (children === LOADING) throw LOADING
  const continuation = issue ? detail.continuation : null
  const relations = issue.relationGroups

  if (!issue) return <IssuePanelEmpty />

  const openChildren = children.filter((c) => !isFinished(c))
  const doneChildren = children.filter((c) => isFinished(c))
  const notesAt = issue.notesUpdatedAt ?? issue.updatedAt
  const workable = !isFinished(issue) && !issue.archived
  const title = detail.title
  // UNCAUGHT, like every other outboxed curation write: the queue keeps a
  // rejected write and surfaces it in the recovery surface with its own toast.
  const renameIssue = (next: string): void => {
    void updateIssue(issue.id, { title: next })
  }

  // Relations, one group per kind, the parent first. Unresolvable targets keep
  // a row with their bare id rather than vanishing.
  const linkGroups: Array<{ label: string; ids: IssueId[] }> = [
    ...(issue.parentId ? [{ label: 'Parent', ids: [issue.parentId as IssueId] }] : []),
    ...relations.map((g) => ({ label: g.section, ids: g.entries.map((e) => e.id) })),
  ]
  const linkCount = linkGroups.reduce((n, g) => n + g.ids.length, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-[18px] pt-3 pb-5"
        data-testid="dock-scroll"
        data-dock-scroll=""
      >
        {/* Offered only where it can arrive: in the dock, for a task the deck
            can put on screen and there is still work to do on (POD-1151,
            POD-1269). */}
        <InspectHead
          issue={issue}
          title={title}
          onRename={renameIssue}
          onOpenInWork={
            onNavigate && workable && typeof page.views.destination(issue.id) === 'object'
              ? () => showInDeck(issue)
              : undefined
          }
          subtasks={
            children.length > 0 ? (
              <button
                data-pressable
                type="button"
                data-testid="dock-subtasks-toggle"
                aria-expanded={showSubtasks}
                onClick={() => setShowSubtasks((v) => !v)}
                className="text-[12px] text-text-dim transition-colors hover:text-foreground"
              >
                {doneChildren.length} of {children.length} subtasks done
              </button>
            ) : undefined
          }
        />

        {/* Where the work went on, when it left this task (a spin-off hop,
            a superseding task): one quiet line under the status row, and the
            way there. */}
        {continuation && (
          <ContinuationLine
            text={continuation.full}
            target={
              continuation.target ? (edgeIssue(resolve(continuation.target.id)) ?? null) : null
            }
            onOpen={openLinked}
          />
        )}

        {showSubtasks && children.length > 0 && (
          <div className="-mt-2 flex flex-col" data-testid="dock-subissues" data-part="Subtasks">
            {openChildren.map((sub) => (
              <DockChildRow
                key={sub.id}
                sub={sub}
                views={page.views}
                onOpen={openLinked}
                onStatusPick={rowStatus.pick}
              />
            ))}
            {doneChildren.map((sub) => (
              <LinkRow key={sub.id} issue={sub} onOpen={openLinked} onStatusPick={rowStatus.pick} />
            ))}
          </div>
        )}

        {/* The task in the author's own words, uncapped (POD-516 r3 #2). */}
        {issue.description.trim() && (
          <p
            className="text-[13px] leading-5 whitespace-pre-wrap text-foreground [text-wrap:pretty]"
            data-testid="dock-description"
          >
            {issue.description}
          </p>
        )}

        {/* The agent's latest posted update: quiet and clamped to four lines,
            because the chat beside this column is where the work is narrated.
            A click unfolds the whole text. */}
        {issue.activityNotes?.trim() && (
          <div
            className="-mt-2 flex flex-col gap-1"
            data-testid="dock-current-update"
            data-part="Current update"
          >
            <span className="text-[11px] text-text-faint">
              Agent status
              {notesAt ? (
                <>
                  {' '}
                  · <IssueAge stamp={notesAt} />
                </>
              ) : null}
            </span>
            <ClampedText
              text={issue.activityNotes}
              className="text-muted-foreground"
              testId="dock-current-update-body"
            />
          </div>
        )}

        <ArtifactsPart
          issue={issue}
          machineId={machineId}
          onViewAll={() =>
            onViewAllArtifacts
              ? onViewAllArtifacts(issue.id)
              : openArtifactsTab(issue.id, issue.worktreePath ?? issue.repoPath)
          }
        />

        {linkCount > 0 && (
          <PanelSection
            title="Relations"
            count={linkCount}
            testId="dock-relations"
            className="gap-1"
          >
            <div className="flex flex-col">
              {linkGroups.map((group) => (
                <div
                  key={group.label}
                  className="flex flex-col border-t border-hairline-soft py-[3px]"
                  data-testid={group.label === 'Parent' ? 'dock-parent' : undefined}
                >
                  {group.ids.map((id, index) => {
                    const target = edgeIssue(resolve(id))
                    const label = index === 0 ? group.label : ''
                    return target ? (
                      <LinkRow
                        key={id}
                        issue={target}
                        label={label}
                        onOpen={openLinked}
                        onStatusPick={rowStatus.pick}
                      />
                    ) : (
                      <div key={id} className="flex h-[26px] items-center gap-2 text-[12.5px]">
                        <span className="w-[78px] flex-none truncate text-[11px] text-text-faint">
                          {label}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-text-faint">
                          {id}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </PanelSection>
        )}

        <CommentsPart issue={issue} />
      </div>
      {/* The close guard for a row picked from above — mounted at the column,
          not in the row, because a row can repaint or leave the list under it. */}
      {rowStatus.dialog}
    </div>
  )
})

/** An open subtask: its row says what the work is waiting on when that is the
 *  operator (or an error), in the sidebar's own words. */
const DockChildRow = observer(function DockChildRow({
  sub,
  views,
  onOpen,
  onStatusPick,
}: {
  sub: PageIssue
  views: ReturnType<typeof issuePages>
  onOpen: (issue: IssueViewModel) => void
  onStatusPick: (issue: IssueViewModel, value: string) => void
}) {
  const sessions = views.row(sub.id).dockActiveSessions
  if (sessions === LOADING) throw LOADING
  const state = operationalState(sub, sessions)
  const errored = state.state === 'error'
  const needs = state.state === 'needs-you' || errored
  return (
    <LinkRow
      issue={sub}
      onOpen={onOpen}
      onStatusPick={onStatusPick}
      {...(needs
        ? {
            trailing: state.label,
            trailingTone: errored ? ('error' as const) : ('attention' as const),
          }
        : {})}
    />
  )
})
