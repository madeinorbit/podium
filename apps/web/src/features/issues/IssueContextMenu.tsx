import { shallowEqual } from '@podium/client-core/store'
import type { IssueStage, IssueWire } from '@podium/protocol'
import { ISSUE_STAGES, issueDisplayRef } from '@podium/protocol'
import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  Bot,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Mail,
  MailOpen,
  Pencil,
  Pin,
  PinOff,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useStoreSelector } from '@/app/store'
import { DEFER_NEXT_MESSAGE, reposToViews, snoozeUntil1h } from '@/lib/derive'
import { issueAgentOptions } from '@/lib/issue-agents'
import type { ContextMenuAnchor } from '@/lib/SessionContextMenu'
import { STAGE_LABELS } from './issue-card'
import {
  deferDateFromNow,
  issueMenuEligibility,
  resolveIssueHandoffSession,
  toggleLabelAcross,
} from './issue-context-menu'
import { PriorityGlyph, StageGlyph } from './issue-glyphs'

/** Which flat second-level flyout is open (SessionContextMenu-style, no nesting). */
type SubKind = 'stage' | 'priority' | 'agent' | 'labels' | 'duplicate' | 'defer' | 'handoff'

/**
 * Right-click context menu for issue cards/rows — the same actions the issue
 * page and bulk action bar expose (open, stage, priority, assign agent, labels,
 * close, defer, duplicate, pin, delete), reachable in place. Cloned from
 * SessionContextMenu: cursor-anchored portal, viewport-clamped, dismissed on
 * outside click / Escape / scroll. `issues` is the right-click target set —
 * one issue, or the whole multi-selection (bulk-bar semantics); items are
 * gated by the pure `issueMenuEligibility`.
 */
export function IssueContextMenu({
  issues,
  allIssues,
  anchor,
  onClose,
  onOpen,
  onRename,
}: {
  /** The issues the menu acts on (the clicked issue, or the multi-selection). */
  issues: IssueWire[]
  /** Board scope — supplies the label pool and duplicate-target siblings. */
  allIssues: IssueWire[]
  anchor: ContextMenuAnchor
  onClose: () => void
  /** Open the issue page for a single target. */
  onOpen: (id: string) => void
  /** Start an inline rename for a single target (#170). When omitted (e.g. the
   *  board, which has no in-place editor) the item falls back to a prompt. */
  onRename?: (id: string) => void
}): JSX.Element | null {
  const { trpc, markIssueRead, markIssueUnread, sessions, repos, machines } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      markIssueRead: s.markIssueRead,
      markIssueUnread: s.markIssueUnread,
      sessions: s.sessions,
      repos: s.repos,
      machines: s.machines,
    }),
    shallowEqual,
  )
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<ContextMenuAnchor>(anchor)
  const [sub, setSub] = useState<{ kind: SubKind; top: number } | null>(null)

  // Clamp into the viewport once the menu has measured its real size, so a
  // right-click near the bottom/right edge doesn't open a clipped menu.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(anchor.x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(anchor.y, window.innerHeight - r.height - 8)),
    })
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const first = issues[0]
  if (!first) return null
  const elig = issueMenuEligibility(issues)
  const ids = issues.map((i) => i.id)
  // Single-issue only: offer Handoff when exactly one attached session is
  // handoff-eligible (same gate as SessionContextMenu via handoffTargets).
  const handoff =
    issues.length === 1
      ? resolveIssueHandoffSession(first, sessions, reposToViews(repos), machines)
      : null

  // Fire-and-close: failures toast (the issuesChanged broadcast reconciles the
  // board on success, so no success handling is needed).
  const run = (fn: () => Promise<unknown>): void => {
    fn().catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
    onClose()
  }

  const handoffTo = (machineId: string, machineName: string): void => {
    if (!handoff) return
    onClose()
    void trpc.sessions.handoff.mutate({ sessionId: handoff.session.sessionId, machineId }).then(
      () => toast.success('Handed off to ' + machineName),
      (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
    )
  }

  const setStage = (stage: IssueStage): void =>
    run(() => Promise.all(ids.map((id) => trpc.issues.update.mutate({ id, patch: { stage } }))))
  const setPriority = (priority: number): void =>
    run(() => Promise.all(ids.map((id) => trpc.issues.update.mutate({ id, patch: { priority } }))))
  const toggleLabel = (label: string): void =>
    run(() =>
      Promise.all(toggleLabelAcross(issues, label).map((p) => trpc.issues.setLabels.mutate(p))),
    )
  const assignAgent = (agentKind: string): void =>
    run(() =>
      first.worktreePath
        ? trpc.issues.addSession.mutate(agentKind ? { id: first.id, agentKind } : { id: first.id })
        : trpc.issues.start.mutate(agentKind ? { id: first.id, agentKind } : { id: first.id }),
    )
  const close = (reason: 'done' | 'wontfix'): void =>
    run(() => trpc.issues.close.mutate({ id: first.id, reason }))
  const defer = (until: string | null): void =>
    run(() => trpc.issues.defer.mutate({ id: first.id, until }))
  // Unsnooze via the dedicated route (issue #133): ends the snooze and floats the
  // issue back to the TOP of WORK with the "Unsnoozed" tag, unlike defer(null) which
  // clears it silently into the middle of the list.
  const undefer = (): void => run(() => trpc.issues.undefer.mutate({ id: first.id }))
  // Rename (#170): prefer the host's inline editor; fall back to a prompt where
  // there's no in-place editor (e.g. the board). Empty/whitespace is a no-op.
  const rename = (): void => {
    if (onRename) {
      onRename(first.id)
      onClose()
      return
    }
    const next = window.prompt('Rename task', first.title)?.trim()
    if (next && next !== first.title) {
      run(() => trpc.issues.update.mutate({ id: first.id, patch: { title: next } }))
    } else {
      onClose()
    }
  }
  const duplicateOf = (canonicalId: string): void =>
    run(() => trpc.issues.duplicate.mutate({ id: first.id, canonicalId }))
  const del = (): void => {
    const n = ids.length
    const sessions = new Set(
      issues.flatMap((issue) => issue.sessions.map((session) => session.sessionId)),
    )
    const sessionCount = sessions.size
    const message = `Delete ${n} task${n > 1 ? 's' : ''} and ${sessionCount} session${sessionCount === 1 ? '' : 's'}? Tasks and sessions can be restored; running processes will be stopped.`
    if (!window.confirm(message)) return
    run(() => Promise.all(ids.map((id) => trpc.issues.delete.mutate({ id }))))
  }
  const restore = (): void =>
    run(() => Promise.all(ids.map((id) => trpc.issues.restore.mutate({ id }))))

  // Label pool / duplicate targets come from the whole board scope.
  const labelPool = [
    ...new Set([...allIssues.flatMap((i) => i.labels), ...issues.flatMap((i) => i.labels)]),
  ].sort()
  const targetSet = new Set(ids)
  const dupMates = allIssues
    .filter((i) => !i.deletedAt && i.repoPath === first.repoPath && !targetSet.has(i.id))
    .sort((a, b) => a.seq - b.seq)

  const itemCls =
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent hover:text-accent-foreground'

  /** A first-level item that opens a flat second-level flyout on hover/click. */
  const subTrigger = (kind: SubKind, icon: ReactNode, label: string): JSX.Element => (
    <button
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={sub?.kind === kind}
      className={itemCls}
      onMouseEnter={(e) => setSub({ kind, top: e.currentTarget.offsetTop })}
      onClick={(e) => setSub({ kind, top: e.currentTarget.offsetTop })}
    >
      {icon} {label}
      <ChevronRight size={13} aria-hidden="true" className="ml-auto text-muted-foreground" />
    </button>
  )
  /** Plain (leaf) items retract any open flyout when hovered. */
  const leafHover = { onMouseEnter: () => setSub(null) }

  const subItems: Record<SubKind, JSX.Element[]> = {
    stage: ISSUE_STAGES.map((s) => (
      <button key={s} type="button" role="menuitem" className={itemCls} onClick={() => setStage(s)}>
        <StageGlyph stage={s} />
        {STAGE_LABELS[s]}
      </button>
    )),
    priority: [0, 1, 2, 3, 4].map((p) => (
      <button
        key={p}
        type="button"
        role="menuitem"
        className={itemCls}
        onClick={() => setPriority(p)}
      >
        <PriorityGlyph priority={p} />P{p}
      </button>
    )),
    agent: issueAgentOptions(first.defaultAgent).map((o) => (
      <button
        key={o.value || '__default__'}
        type="button"
        role="menuitem"
        className={itemCls}
        onClick={() => assignAgent(o.value)}
      >
        {o.icon}
        {o.label}
      </button>
    )),
    labels:
      labelPool.length === 0
        ? [
            <span key="none" className="px-2 py-1.5 text-[13px] text-muted-foreground">
              No labels
            </span>,
          ]
        : labelPool.map((l) => {
            const allHave = issues.every((i) => i.labels.includes(l))
            return (
              <button
                key={l}
                type="button"
                role="menuitem"
                className={itemCls}
                onClick={() => toggleLabel(l)}
              >
                <Check size={13} aria-hidden="true" className={allHave ? undefined : 'invisible'} />
                {l}
              </button>
            )
          }),
    duplicate:
      dupMates.length === 0
        ? [
            <span key="none" className="px-2 py-1.5 text-[13px] text-muted-foreground">
              No sibling issues
            </span>,
          ]
        : dupMates.map((i) => (
            <button
              key={i.id}
              type="button"
              role="menuitem"
              className={itemCls}
              onClick={() => duplicateOf(i.id)}
            >
              <span className="text-muted-foreground tabular-nums">{issueDisplayRef(i)}</span>
              <span className="min-w-0 flex-1 truncate">{i.title}</span>
            </button>
          )),
    defer: [
      <button
        key="hour"
        type="button"
        role="menuitem"
        className={itemCls}
        onClick={() => defer(snoozeUntil1h(Date.now()))}
      >
        <AlarmClock size={14} aria-hidden="true" /> For 1 hour
      </button>,
      <button
        key="tomorrow"
        type="button"
        role="menuitem"
        className={itemCls}
        onClick={() => defer(deferDateFromNow(Date.now(), 1))}
      >
        <AlarmClock size={14} aria-hidden="true" /> Until tomorrow
      </button>,
      <button
        key="week"
        type="button"
        role="menuitem"
        className={itemCls}
        onClick={() => defer(deferDateFromNow(Date.now(), 7))}
      >
        <AlarmClock size={14} aria-hidden="true" /> For a week
      </button>,
      <button
        key="next-message"
        type="button"
        role="menuitem"
        className={itemCls}
        onClick={() => defer(DEFER_NEXT_MESSAGE)}
      >
        <AlarmClock size={14} aria-hidden="true" /> Until next message
      </button>,
      ...(elig.canUndefer
        ? [
            <button
              key="undefer"
              type="button"
              role="menuitem"
              className={itemCls}
              onClick={() => undefer()}
            >
              <AlarmClockOff size={14} aria-hidden="true" /> Unsnooze
            </button>,
          ]
        : []),
    ],
    // [spec:SP-3f7a] same machine list as SessionContextMenu; empty when gated off.
    handoff: (handoff?.targets ?? []).map((machine) => (
      <button
        key={machine.id}
        type="button"
        role="menuitem"
        className={itemCls}
        onClick={() => handoffTo(machine.id, machine.name)}
      >
        <span className="size-2 rounded-full bg-live" aria-hidden="true" />
        {machine.name}
      </button>
    )),
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Task actions"
      className="fixed z-[60] min-w-[200px] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
      style={{ left: pos.x, top: pos.y }}
      // The host opens this on contextmenu; suppress a nested browser menu.
      onContextMenu={(e) => e.preventDefault()}
    >
      {issues.length > 1 && (
        <div className="px-2 py-1 text-[11px] text-muted-foreground tabular-nums">
          {issues.length} issues selected
        </div>
      )}
      {elig.canOpen && (
        <button
          type="button"
          role="menuitem"
          className={itemCls}
          {...leafHover}
          onClick={() => {
            onOpen(first.id)
            onClose()
          }}
        >
          <ExternalLink size={14} aria-hidden="true" /> Open
        </button>
      )}
      {elig.canRename && (
        <button type="button" role="menuitem" className={itemCls} {...leafHover} onClick={rename}>
          <Pencil size={14} aria-hidden="true" /> Rename
        </button>
      )}
      {/* Email-style read toggle (#138): mark a read row unread (or an unread one
          read) — mutually exclusive, single-target. Store actions are optimistic. */}
      {elig.canMarkUnread && (
        <button
          type="button"
          role="menuitem"
          className={itemCls}
          {...leafHover}
          onClick={() => run(() => markIssueUnread(first.id))}
        >
          <Mail size={14} aria-hidden="true" /> Mark as unread
        </button>
      )}
      {elig.canMarkRead && (
        <button
          type="button"
          role="menuitem"
          className={itemCls}
          {...leafHover}
          onClick={() => run(() => markIssueRead(first.id))}
        >
          <MailOpen size={14} aria-hidden="true" /> Mark as read
        </button>
      )}
      {elig.canSetStage && subTrigger('stage', <StageGlyph stage={first.stage} />, 'Set stage')}
      {elig.canSetPriority &&
        subTrigger('priority', <PriorityGlyph priority={first.priority} />, 'Set priority')}
      {elig.canAssignAgent &&
        subTrigger('agent', <Bot size={14} aria-hidden="true" />, 'Assign agent')}
      {elig.canSetLabels && subTrigger('labels', <Tag size={14} aria-hidden="true" />, 'Labels')}
      {/* [spec:SP-3f7a] issue-row handoff when exactly one session is eligible */}
      {handoff && subTrigger('handoff', <ArrowRightLeft size={14} aria-hidden="true" />, 'Handoff')}

      {(elig.canClose || elig.canDefer || elig.canUndefer) && (
        <hr className="my-1 h-px border-0 bg-border" />
      )}
      {elig.canClose && (
        <button
          type="button"
          role="menuitem"
          className={itemCls}
          {...leafHover}
          onClick={() => close('done')}
        >
          <Check size={14} aria-hidden="true" /> Close (done)
        </button>
      )}
      {elig.canClose && (
        <button
          type="button"
          role="menuitem"
          className={itemCls}
          {...leafHover}
          onClick={() => close('wontfix')}
        >
          <X size={14} aria-hidden="true" /> Close (wontfix)
        </button>
      )}
      {(elig.canDefer || elig.canUndefer) &&
        subTrigger('defer', <AlarmClock size={14} aria-hidden="true" />, 'Snooze / defer')}

      {(elig.canPin ||
        elig.canArchive ||
        elig.canUnarchive ||
        elig.canDuplicate ||
        elig.canRestore ||
        elig.canDelete) && <hr className="my-1 h-px border-0 bg-border" />}
      {elig.canPin && (
        <button
          type="button"
          role="menuitem"
          className={itemCls}
          {...leafHover}
          onClick={() =>
            run(() => trpc.issues.update.mutate({ id: first.id, patch: { pinned: !first.pinned } }))
          }
        >
          {first.pinned ? (
            <PinOff size={14} aria-hidden="true" />
          ) : (
            <Pin size={14} aria-hidden="true" />
          )}
          {first.pinned ? 'Unpin' : 'Pin'}
        </button>
      )}
      {(elig.canArchive || elig.canUnarchive) && (
        <button
          type="button"
          role="menuitem"
          className={itemCls}
          {...leafHover}
          onClick={() =>
            run(() =>
              trpc.issues.update.mutate({
                id: first.id,
                patch: { archived: !first.archived },
              }),
            )
          }
        >
          {first.archived ? (
            <ArchiveRestore size={14} aria-hidden="true" />
          ) : (
            <Archive size={14} aria-hidden="true" />
          )}
          {first.archived ? 'Unarchive' : 'Archive'}
        </button>
      )}
      {elig.canDuplicate &&
        subTrigger('duplicate', <Copy size={14} aria-hidden="true" />, 'Duplicate of')}
      {elig.canRestore && (
        <button type="button" role="menuitem" className={itemCls} {...leafHover} onClick={restore}>
          <ArchiveRestore size={14} aria-hidden="true" /> Restore
        </button>
      )}
      {elig.canDelete && (
        <button
          type="button"
          role="menuitem"
          className={`${itemCls} text-destructive hover:bg-destructive/10 hover:text-destructive`}
          {...leafHover}
          onClick={del}
        >
          <Trash2 size={14} aria-hidden="true" /> Delete
        </button>
      )}

      {sub && (
        <div
          role="menu"
          aria-label={sub.kind === 'handoff' ? 'Handoff targets' : `${sub.kind} options`}
          className="absolute left-full z-[61] max-h-[60vh] min-w-[180px] overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
          style={{
            // Flip to the left edge when the flyout would leave the viewport.
            ...(pos.x + 400 > window.innerWidth ? { left: 'auto', right: '100%' } : {}),
            top: Math.max(-pos.y + 8, Math.min(sub.top - 4, window.innerHeight - pos.y - 60)),
          }}
        >
          {subItems[sub.kind]}
        </div>
      )}
    </div>,
    document.body,
  )
}
