import { shallowEqual } from '@podium/client-core/store'
import {
  discoveredPlacement,
  type ProposalPlacement,
  reposToViews,
  spawnIssueAgent,
} from '@podium/client-core/viewmodels'
import {
  DEFER_NEXT_MESSAGE,
  ISSUE_COLOR_HEX,
  type IssueColorSlot,
  type IssueId,
  type IssueStage,
  isIssueColorSlot,
  isIssueStatus,
  issueStatusIntent,
  issueStatusOf,
  type MachineId,
  snoozeUntil1h,
} from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { Check, ChevronRight } from 'lucide-react'
import { Fragment, type JSX, type ReactNode, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import type { IssueViewModel } from '@/app/store'
import { useStoreSelector } from '@/app/store'
import { IssueColorSwatches } from '@/components/IssueColorSwatches'
import { useConfirm } from '@/lib/hooks/use-confirm'
import { issueAgentIcon } from '@/lib/issue-agents'
import {
  MENU_EMPTY,
  MENU_HEADER,
  MENU_HEADER_REF,
  MENU_HINT,
  MENU_ITEM,
  MENU_ITEM_DESTRUCTIVE,
  MENU_ITEM_DISABLED,
  MENU_PANEL,
  MENU_PICKER_PANEL,
  MENU_RULE,
  MENU_SECTION,
  MENU_SUBTEXT,
} from '@/lib/menu-surface'
import {
  type ContextMenuAnchor,
  handoffBlockerText,
  handoffRejectionText,
  issueHandoffBlockerText,
} from '@/lib/session-context-menu'
import { useCursorMenu } from '@/lib/use-cursor-menu'
import { useFeature } from '@/lib/use-feature'
import { sessionDisplayName } from '@/lib/WorkerLabel'
import {
  deferDateFromNow,
  describeCascade,
  type IssueMenuSurface,
  issueHandoffAvailability,
  issueMenuEligibility,
  toggleLabelAcross,
} from './issue-context-menu'
import { PriorityGlyph, StatusGlyph } from './issue-glyphs'
import { IssueCloseDialog, type IssueCloseReason, useIssueCloseGuard } from './issue-lifecycle'
import {
  createIssueMenuData,
  ISSUE_MENU_COLOR_NONE,
  type IssueMenuConfig,
  type IssueMenuIcon,
  type IssueMenuOption,
  type IssueMenuSection,
  type IssueMenuSubmenu,
  issueMenuEntries,
  issueMenuEntryLabel,
} from './issue-menu-config'
import { issueMenuIcon } from './issue-menu-icons'
import { isIssueStartable } from './issue-startable'

/** Regions get named in mono micro-caps, the way the colour picker names its
 *  own (POD-380) — the menu's separators used to be anonymous rules. `main`
 *  has no label: the panel header already sits above it. */
// A null label draws a bare rule instead of a heading. `danger` takes one
// deliberately: Delete is a single row, and a "DANGER" banner over one item
// shouts where the rule already separates (POD-1077). `placement` is headed
// because it is a category, not a leftover.
const SECTION_LABEL: Record<IssueMenuSection, string | null> = {
  main: null,
  placement: 'PLACEMENT',
  lifecycle: 'LIFECYCLE',
  destructive: 'MANAGE',
  danger: null,
}

/** A cursor-anchored menu whose tree is projected from issue-menu-config.ts. */
export function IssueContextMenu({
  issues,
  allIssues,
  anchor,
  onClose,
  onOpen,
  onRename,
  onRequestClose,
  surface = 'board',
  primaryStart = false,
}: {
  issues: IssueViewModel[]
  allIssues: IssueViewModel[]
  anchor: ContextMenuAnchor
  onClose: () => void
  /** Optional because a surface can rule the `Open` entry out entirely —
   *  `issueMenuEligibility` does exactly that for `dock`, whose only possible
   *  destination was the Tasks tool (POD-1457). Where `canOpen` is false the
   *  entry never renders, so there is nothing to call. */
  onOpen?: (id: IssueId) => void
  onRename?: (id: IssueId) => void
  /** Only for hosts that ALREADY own an `IssueCloseDialog` (the issue page, the
   *  panel's compact controls) — they keep their own busy state and their own
   *  close command. Everyone else gets the guard from the menu itself; it is a
   *  property of closing, not of the surface the close was asked from. */
  onRequestClose?: (reason: IssueCloseReason) => void
  surface?: IssueMenuSurface
  /** Flight Deck proposals use the sidebar's one-click start action instead of
   *  asking for an agent choice before the work has even been accepted. */
  primaryStart?: boolean
}): JSX.Element | null {
  const {
    trpc,
    markIssueRead,
    markIssueUnread,
    updateIssue,
    deleteIssue,
    closeIssue,
    deferIssue,
    undeferIssue,
    setIssueLabels,
    setIssuePlacement,
    restoreIssue,
    sessions,
    repos,
    machines,
  } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      markIssueRead: s.markIssueRead,
      markIssueUnread: s.markIssueUnread,
      updateIssue: s.updateIssue,
      deleteIssue: s.deleteIssue,
      closeIssue: s.closeIssue,
      deferIssue: s.deferIssue,
      undeferIssue: s.undeferIssue,
      setIssueLabels: s.setIssueLabels,
      setIssuePlacement: s.setIssuePlacement,
      restoreIssue: s.restoreIssue,
      sessions: s.sessions,
      repos: s.repos,
      machines: s.machines,
    }),
    shallowEqual,
  )
  const handoffEnabled = useFeature('session-handoff')
  // The app-wide dialog, replacing two raw `window.confirm` calls (POD-1077).
  // A native confirm cannot be styled, cannot be dismissed the way every other
  // surface is, and — the reason it actually mattered here — blocks the whole
  // renderer, so the menu it was launched from stayed painted underneath it.
  const confirm = useConfirm()
  const [sub, setSub] = useState<{ kind: IssueMenuSubmenu; top: number } | null>(null)
  // The close guard the menu mounts for itself when the host has no dialog of
  // its own. Non-null means the panel has handed over to the dialog.
  const [pendingClose, setPendingClose] = useState<IssueCloseReason | null>(null)
  const [closing, setClosing] = useState(false)
  const needsCloseGuard = useIssueCloseGuard()

  // Viewport clamp + outside-press/Escape/scroll dismissal, shared with the two
  // other cursor-anchored panels (`use-cursor-menu.ts`). Dismissal is suspended
  // while the close dialog stands in for this panel: a press inside the dialog
  // lands outside the ref and Escape is the dialog's own, so unmounting the menu
  // here would take the dialog with it.
  const { ref, pos } = useCursorMenu(anchor, onClose, { dismiss: !pendingClose })

  const first = issues[0]
  if (!first) return null

  // The guard, mounted in the panel's place: the menu is gone from the screen
  // but still mounted, so the dialog it owns survives until the decision is
  // made. Hosts that pass `onRequestClose` never reach here.
  if (pendingClose) {
    const dismiss = (): void => {
      setPendingClose(null)
      onClose()
    }
    return (
      <IssueCloseDialog
        issue={first}
        reason={pendingClose}
        busy={closing}
        onOpenChange={(open) => !open && dismiss()}
        onConfirm={(reason) => {
          setClosing(true)
          // Optimistic + outboxed (POD-781) like every other action here: the
          // row reaches the Closed fold on the press, so the dialog can go.
          closeIssue(first.id, reason)
            .then(dismiss)
            .catch((e: unknown) => {
              setClosing(false)
              toast.error(e instanceof Error ? e.message : String(e))
            })
        }}
      />
    )
  }

  const eligibility = issueMenuEligibility(issues, surface)
  const ids = issues.map((issue) => issue.id)
  const handoff =
    issues.length === 1
      ? issueHandoffAvailability(first, sessions, reposToViews(repos), machines)
      : null
  const handoffSession = handoff && 'session' in handoff ? handoff.session : null
  const handoffCandidates =
    handoff && 'availability' in handoff && !handoff.availability.blocker
      ? handoff.availability.candidates
      : []
  const handoffBlocker =
    handoff && 'blocker' in handoff
      ? issueHandoffBlockerText(handoff.blocker)
      : handoff && 'availability' in handoff && handoff.availability.blocker && handoffSession
        ? handoffBlockerText(handoff.availability.blocker, handoffSession.agentKind)
        : undefined

  const run = (fn: () => Promise<unknown>): void => {
    fn().catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
    onClose()
  }

  const handoffTo = (machineId: MachineId, machineName: string): void => {
    if (!handoffSession) return
    onClose()
    void trpc.sessions.handoff.mutate({ sessionId: handoffSession.sessionId, machineId }).then(
      () => toast.success(`${sessionDisplayName(handoffSession)} resumed on ${machineName}`),
      (error: unknown) =>
        toast.error(
          `Handover to ${machineName} failed — ${error instanceof Error ? error.message : String(error)}`,
        ),
    )
  }

  // Every one of these is optimistic + outboxed (POD-781). The menu serves the
  // sidebar AND the issue board, so a stage move, a colour or a label repaints
  // the row on the press on both surfaces — the same store action, one queue.
  const setStage = (stage: IssueStage): void =>
    run(() => Promise.all(ids.map((id) => updateIssue(id, { stage }))))
  const setPriority = (priority: number): void =>
    run(() => Promise.all(ids.map((id) => updateIssue(id, { priority }))))
  // Same patch the IdSquare picker sends; `null` clears back to the slate flow.
  const setColor = (color: IssueColorSlot | null): void =>
    run(() => Promise.all(ids.map((id) => updateIssue(id, { color }))))
  const toggleLabel = (label: string): void =>
    run(() =>
      Promise.all(toggleLabelAcross(issues, label).map((p) => setIssueLabels(p.id, p.labels))),
    )
  const assignAgent = (agentKind: string): void =>
    run(() =>
      spawnIssueAgent(trpc.issues, agentKind ? { id: first.id, agentKind } : { id: first.id }),
    )
  const close = (reason: IssueCloseReason): void => {
    if (onRequestClose) {
      onClose()
      onRequestClose(reason)
      return
    }
    // The guard is raised only when it has something to list (POD-1278) —
    // otherwise this is an ordinary menu command and behaves like one: the panel
    // goes and the ending is recorded on the press.
    if (!needsCloseGuard(first)) {
      onClose()
      closeIssue(first.id, reason).catch((e: unknown) =>
        toast.error(e instanceof Error ? e.message : String(e)),
      )
      return
    }
    // No `run()`: closing is never immediate. The panel gives way to the guard
    // above, which lists what is still unresolved before anything is sent.
    setPendingClose(reason)
  }
  const defer = (until: string | null): void => run(() => deferIssue(first.id, until))
  const undefer = (): void => run(() => undeferIssue(first.id))
  const rename = (): void => {
    onRename?.(first.id)
    onClose()
  }
  const duplicateOf = (canonicalId: string): void =>
    run(() => trpc.issues.duplicate.mutate({ id: first.id, canonicalId }))
  const del = (): void => {
    const n = ids.length
    const sessionIds = new Set(issues.flatMap((issue) => issue.memberSessionIds ?? []))
    const sessionCount = sessionIds.size
    onClose()
    void (async () => {
      const ok = await confirm({
        title: `Delete ${n === 1 ? 'this task' : `${n} tasks`}?`,
        description: `${describeCascade(n, sessionCount)} Tasks and sessions can be restored; running agents will be stopped.`,
        confirmLabel: 'Delete',
      })
      if (!ok) return
      // Optimistic + outboxed (POD-781): every selected row and its nested
      // sessions leave the sidebar on the press, not after the cascade
      // round-trips.
      await Promise.all(ids.map((id) => deleteIssue(id)))
    })()
  }
  /**
   * Archive, and SAY WHAT IT TAKES WITH IT (POD-1077).
   *
   * The old confirm fired only when `childCount > 0` and named no numbers, and
   * it never mentioned sessions at all — yet archiving an issue cascades to
   * every member session (#133), and each of those is PARKED: the server sends
   * a kill to the daemon (`parkArchivedSession`, POD-108). So the sentence the
   * operator most needed — "this stops N running agents" — was the one the
   * dialog omitted, which is why archiving read as filing.
   *
   * It therefore asks whenever there is anything to cascade to, sub-tasks or
   * sessions, and stays silent for a lone childless issue with no agents, where
   * archiving really is just tidying a row away. Unarchiving never asks: it does
   * not resurrect anything (`session-teardown.ts`), so there is nothing to warn
   * about.
   */
  const archive = (): void => {
    if (first.archived) {
      run(() => updateIssue(first.id, { archived: false }))
      return
    }
    const sessionCount = new Set(first.memberSessionIds ?? []).size
    if (first.childCount === 0 && sessionCount === 0) {
      run(() => updateIssue(first.id, { archived: true }))
      return
    }
    onClose()
    void (async () => {
      const ok = await confirm({
        title: 'Archive this task?',
        description: `${describeCascade(1 + first.childCount, sessionCount)} They leave active views, and any running agents are stopped. Unarchiving brings the task back but does not restart them.`,
        confirmLabel: 'Archive',
      })
      if (!ok) return
      await updateIssue(first.id, { archived: true })
    })()
  }
  // Optimistic + outboxed (POD-781): the row comes back on the press, and a
  // delete still sitting in the queue collapses against this restore instead of
  // making the round trip out and back.
  const restore = (): void => run(() => Promise.all(ids.map((id) => restoreIssue(id))))

  /**
   * Move discovered work between "part of the mission" and "its own thing"
   * (POD-679) — one mutation, so the parent link and the provenance edge can
   * never disagree. The origin comes from the issue's CURRENT placement: the
   * parent it hangs under, or the task it was discovered from.
   */
  const movePlacement = (placement: ProposalPlacement): void => {
    const byId = new Map(allIssues.map((issue) => [issue.id as string, issue]))
    const originId = discoveredPlacement(first, byId)?.originId
    if (!originId) return
    // Optimistic + outboxed (POD-781): the row nests into the mission, or leaves
    // it, on the press. The placement CHIP still waits for the round trip — the
    // overlay paints the parent link and the provenance edge is derived
    // server-side (see the `issueSetPlacement` case in overlay.ts).
    run(() => setIssuePlacement(first.id, placement, originId))
  }

  const menuData = createIssueMenuData({
    issues,
    allIssues,
    eligibility,
    surface,
    renameEnabled: onRename !== undefined,
    handoffEnabled: handoffEnabled && handoff !== null,
    primaryStart,
    handoff: handoff
      ? {
          sessionId: handoffSession?.sessionId,
          blocker: handoffBlocker,
          options:
            handoffCandidates.length === 0
              ? [
                  {
                    id: 'none',
                    label: 'No other machine has this repo',
                    disabled: true,
                    empty: true,
                  },
                ]
              : handoffCandidates.map(({ machine, rejection }) => ({
                  id: machine.id,
                  value: machine.id,
                  label: machine.name,
                  disabled: rejection !== undefined,
                  hint:
                    rejection && handoffSession
                      ? handoffRejectionText(rejection, handoffSession.agentKind, machine)
                      : undefined,
                })),
        }
      : undefined,
  })
  if (!menuData) return null
  const entries = issueMenuEntries(menuData)

  const itemCls = MENU_ITEM
  const disabledCls = MENU_ITEM_DISABLED
  const leafHover = { onMouseEnter: () => setSub(null) }

  const runAction = (action: Extract<IssueMenuConfig, { kind: 'action' }>['id']): void => {
    switch (action) {
      case 'open':
        onOpen?.(first.id)
        onClose()
        return
      case 'start':
        run(() => trpc.issues.start.mutate({ id: first.id }))
        return
      case 'rename':
        rename()
        return
      case 'markUnread':
        run(() => markIssueUnread(first.id))
        return
      case 'markRead':
        run(() => markIssueRead(first.id))
        return
      case 'pin':
        run(() => updateIssue(first.id, { pinned: !first.pinned }))
        return
      case 'archive':
        // The archive/unarchive TOGGLE — `issues.update`, not the one-way
        // `issues.archive` the sidebar's dismiss calls. Outboxed (POD-781).
        archive()
        return
      case 'restore':
        restore()
        return
      case 'delete':
        del()
        return
      case 'placeOnOwn':
        movePlacement('own')
        return
      case 'placeInMission':
        movePlacement('mission')
        return
    }
  }

  const runSubmenu = (kind: IssueMenuSubmenu, value: string): void => {
    switch (kind) {
      case 'status': {
        const intent = isIssueStatus(value) ? issueStatusIntent(value) : null
        if (!intent) return
        if (intent.kind === 'close') close(intent.reason)
        else setStage(intent.stage)
        return
      }
      case 'priority': {
        const priority = Number(value)
        if (Number.isInteger(priority) && priority >= 0 && priority <= 4) setPriority(priority)
        return
      }
      case 'agent':
        assignAgent(value)
        return
      case 'labels':
        toggleLabel(value)
        return
      case 'color':
        if (value === ISSUE_MENU_COLOR_NONE) setColor(null)
        else if (isIssueColorSlot(value)) setColor(value)
        return
      case 'handoff': {
        const target = handoffCandidates.find((candidate) => candidate.machine.id === value)
        if (target && !target.rejection) handoffTo(target.machine.id, target.machine.name)
        return
      }
      case 'defer':
        if (value === 'hour') defer(snoozeUntil1h(Date.now()))
        else if (value === 'tomorrow') defer(deferDateFromNow(Date.now(), 1))
        else if (value === 'week') defer(deferDateFromNow(Date.now(), 7))
        else if (value === 'next-message') defer(DEFER_NEXT_MESSAGE)
        else if (value === 'undefer') undefer()
        return
      case 'duplicate':
        duplicateOf(value)
        return
    }
  }

  // Names resolve in `issue-menu-icons` — shared with the command palette, so
  // the same action cannot wear two different marks on the two surfaces.
  const renderIcon = (icon: IssueMenuIcon): ReactNode => {
    const Glyph = issueMenuIcon(icon)
    return <Glyph size={14} aria-hidden="true" />
  }

  /** The colour row wears the issue's own square rather than a palette glyph —
   *  the same mark the IdSquare shows, so the row states the current colour
   *  instead of just naming the control. */
  const colorGlyph = (): ReactNode => {
    const hex = first.color ? ISSUE_COLOR_HEX[first.color] : undefined
    return (
      <span
        aria-hidden="true"
        data-testid="issue-menu-color-glyph"
        className="size-3.5 flex-none rounded-[4px] border"
        style={
          hex
            ? { background: hex, borderColor: 'transparent' }
            : {
                background: 'var(--hairline-soft)',
                borderColor: 'var(--text-dim)',
                borderStyle: 'dashed',
              }
        }
      />
    )
  }

  const entryIcon = (entry: IssueMenuConfig): ReactNode => {
    if (entry.kind === 'submenu') {
      if (entry.id === 'status') return <StatusGlyph status={issueStatusOf(first)} />
      if (entry.id === 'priority') return <PriorityGlyph priority={first.priority} />
      if (entry.id === 'color') return colorGlyph()
      if (entry.id === 'agent') return renderIcon(isIssueStartable(first) ? 'play' : 'agent')
    }
    if (entry.kind === 'action' && entry.id === 'pin') {
      return renderIcon(first.pinned ? 'pin-off' : 'pin')
    }
    if (entry.kind === 'action' && entry.id === 'archive') {
      return renderIcon(first.archived ? 'archive-restore' : 'archive')
    }
    return renderIcon(entry.icon)
  }

  const optionIcon = (
    entry: Extract<IssueMenuConfig, { kind: 'submenu' }>,
    option: IssueMenuOption,
  ): ReactNode => {
    if (entry.id === 'status' && option.value && isIssueStatus(option.value))
      return <StatusGlyph status={option.value} />
    if (entry.id === 'priority' && option.value)
      return <PriorityGlyph priority={Number(option.value)} />
    if (entry.id === 'agent') return issueAgentIcon(option.value || first.defaultAgent)
    return option.icon ? renderIcon(option.icon) : null
  }

  const submenuItems = new Map<IssueMenuSubmenu, JSX.Element[]>()
  for (const entry of entries) {
    if (entry.kind !== 'submenu') continue
    // Colour opens the picker's swatch grid, not a row list (POD-380).
    if (entry.id === 'color') continue
    submenuItems.set(
      entry.id,
      entry.options(menuData).map((option) =>
        option.empty ? (
          <span key={option.id} className={MENU_EMPTY}>
            {option.label}
          </span>
        ) : (
          <button
            data-pressable
            key={option.id}
            type="button"
            role="menuitem"
            disabled={option.disabled}
            className={option.disabled ? disabledCls : itemCls}
            onClick={() => option.value !== undefined && runSubmenu(entry.id, option.value)}
          >
            {entry.id === 'labels' && (
              <Check
                size={13}
                aria-hidden="true"
                className={option.checked ? undefined : 'invisible'}
              />
            )}
            {optionIcon(entry, option)}
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.hint && <span className={MENU_HINT}>{option.hint}</span>}
          </button>
        ),
      ),
    )
  }

  const subTrigger = (entry: Extract<IssueMenuConfig, { kind: 'submenu' }>): JSX.Element => (
    <button
      data-pressable
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={sub?.kind === entry.id}
      className={itemCls}
      onMouseEnter={(e) => setSub({ kind: entry.id, top: e.currentTarget.offsetTop })}
      onClick={(e) => setSub({ kind: entry.id, top: e.currentTarget.offsetTop })}
    >
      {entryIcon(entry)} {issueMenuEntryLabel(entry, menuData)}
      <ChevronRight size={12} aria-hidden="true" className="ml-auto text-text-dim" />
    </button>
  )

  let previousSection: IssueMenuSection = 'main'
  const renderedEntries = entries.map((entry) => {
    const changed = entry.section !== previousSection
    previousSection = entry.section
    const label = SECTION_LABEL[entry.section]
    const divider = changed ? (
      label ? (
        <div className={MENU_SECTION}>{label}</div>
      ) : (
        <hr className={MENU_RULE} />
      )
    ) : null
    if (entry.kind === 'submenu' && entry.id === 'handoff' && menuData.handoff?.blocker) {
      return (
        <Fragment key={entry.id}>
          {divider}
          <button
            data-pressable
            type="button"
            role="menuitem"
            disabled
            className={`${disabledCls} flex-col items-stretch gap-0.5`}
            {...leafHover}
          >
            <span className="flex items-center gap-2">
              {entryIcon(entry)} {issueMenuEntryLabel(entry, menuData)}
            </span>
            <span className={MENU_SUBTEXT}>{menuData.handoff.blocker}</span>
          </button>
        </Fragment>
      )
    }
    return (
      <Fragment key={entry.kind === 'action' ? entry.id : entry.id}>
        {divider}
        {entry.kind === 'submenu' ? (
          subTrigger(entry)
        ) : (
          <button
            data-pressable
            type="button"
            role="menuitem"
            className={entry.id === 'delete' ? MENU_ITEM_DESTRUCTIVE : itemCls}
            {...leafHover}
            onClick={() => runAction(entry.id)}
          >
            {entryIcon(entry)} {issueMenuEntryLabel(entry, menuData)}
          </button>
        )}
      </Fragment>
    )
  })

  // Flyout placement, shared by the option lists and the colour grid. The
  // bottom clamp reserves the panel's own height so it can't hang off-screen —
  // the fixed-size colour grid is taller than a couple of option rows.
  const flyoutReserve = sub?.kind === 'color' ? 130 : 60
  const flyoutStyle = sub
    ? {
        ...(pos.x + 400 > window.innerWidth ? { left: 'auto' as const, right: '100%' } : {}),
        top: Math.max(
          -pos.y + 8,
          Math.min(sub.top - 4, window.innerHeight - pos.y - flyoutReserve),
        ),
      }
    : undefined

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Task actions"
      className={`fixed z-[60] min-w-[196px] ${MENU_PANEL}`}
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* The picker's header line, verbatim: what this panel acts on, named in
          machine voice, with the ref pushed to the right edge. */}
      <div className={`${MENU_HEADER} px-[5px]`}>
        <span>TASK</span>
        <span className={`${MENU_HEADER_REF} tabular-nums`}>
          {issues.length > 1 ? `${issues.length} SELECTED` : issueDisplayRef(first)}
        </span>
      </div>
      {renderedEntries}
      {sub &&
        (sub.kind === 'color' ? (
          <div
            role="dialog"
            aria-label="Task colour"
            className={`absolute left-full z-[61] ${MENU_PICKER_PANEL}`}
            style={flyoutStyle}
          >
            <div className={MENU_HEADER}>
              <span>ISSUE COLOUR</span>
              <span className={MENU_HEADER_REF}>
                {issues.length > 1 ? `${issues.length} TASKS` : issueDisplayRef(first)}
              </span>
            </div>
            <IssueColorSwatches value={first.color} onPick={setColor} />
          </div>
        ) : (
          <div
            role="menu"
            aria-label={sub.kind === 'handoff' ? 'Handoff targets' : `${sub.kind} options`}
            className={`absolute left-full z-[61] max-h-[60vh] min-w-[180px] overflow-y-auto ${MENU_PANEL}`}
            style={flyoutStyle}
          >
            {submenuItems.get(sub.kind)}
          </div>
        ))}
    </div>,
    document.body,
  )
}
