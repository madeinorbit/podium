import { shallowEqual } from '@podium/client-core/store'
import { reposToViews } from '@podium/client-core/viewmodels'
import {
  DEFER_NEXT_MESSAGE,
  ISSUE_COLOR_HEX,
  ISSUE_STAGES,
  type IssueColorSlot,
  type IssueId,
  type IssueStage,
  isIssueColorSlot,
  snoozeUntil1h,
} from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
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
  Palette,
  Pencil,
  Pin,
  PinOff,
  Play,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { Fragment, type JSX, type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import type { IssueViewModel } from '@/app/store'
import { useStoreSelector } from '@/app/store'
import { IssueColorSwatches } from '@/components/IssueColorSwatches'
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
} from '@/lib/SessionContextMenu'
import { useFeature } from '@/lib/use-feature'
import { sessionDisplayName } from '@/lib/WorkerLabel'
import {
  deferDateFromNow,
  type IssueMenuSurface,
  issueHandoffAvailability,
  issueMenuEligibility,
  toggleLabelAcross,
} from './issue-context-menu'
import { PriorityGlyph, StageGlyph } from './issue-glyphs'
import type { IssueCloseReason } from './issue-lifecycle'
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
import { isIssueStartable } from './issue-startable'

/** Regions get named in mono micro-caps, the way the colour picker names its
 *  own (POD-380) — the menu's separators used to be anonymous rules. `main`
 *  has no label: the panel header already sits above it. */
const SECTION_LABEL: Record<IssueMenuSection, string | null> = {
  main: null,
  lifecycle: 'LIFECYCLE',
  destructive: 'MANAGE',
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
}: {
  issues: IssueViewModel[]
  allIssues: IssueViewModel[]
  anchor: ContextMenuAnchor
  onClose: () => void
  onOpen: (id: IssueId) => void
  onRename?: (id: string) => void
  onRequestClose?: (reason: IssueCloseReason) => void
  surface?: IssueMenuSurface
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
  const handoffEnabled = useFeature('session-handoff')
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<ContextMenuAnchor>(anchor)
  const [sub, setSub] = useState<{ kind: IssueMenuSubmenu; top: number } | null>(null)

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

  const handoffTo = (machineId: string, machineName: string): void => {
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

  const setStage = (stage: IssueStage): void =>
    run(() => Promise.all(ids.map((id) => trpc.issues.update.mutate({ id, patch: { stage } }))))
  const setPriority = (priority: number): void =>
    run(() => Promise.all(ids.map((id) => trpc.issues.update.mutate({ id, patch: { priority } }))))
  // Same patch the IdSquare picker sends; `null` clears back to the slate flow.
  const setColor = (color: IssueColorSlot | null): void =>
    run(() => Promise.all(ids.map((id) => trpc.issues.update.mutate({ id, patch: { color } }))))
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
  const close = (reason: IssueCloseReason): void => {
    if (onRequestClose) {
      onClose()
      onRequestClose(reason)
      return
    }
    run(() => trpc.issues.close.mutate({ id: first.id, reason }))
  }
  const defer = (until: string | null): void =>
    run(() => trpc.issues.defer.mutate({ id: first.id, until }))
  const undefer = (): void => run(() => trpc.issues.undefer.mutate({ id: first.id }))
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
    const message = `Delete ${n} task${n > 1 ? 's' : ''} and ${sessionCount} session${sessionCount === 1 ? '' : 's'}? Tasks and sessions can be restored; running processes will be stopped.`
    if (!window.confirm(message)) return
    run(() => Promise.all(ids.map((id) => trpc.issues.delete.mutate({ id }))))
  }
  const restore = (): void =>
    run(() => Promise.all(ids.map((id) => trpc.issues.restore.mutate({ id }))))

  const menuData = createIssueMenuData({
    issues,
    allIssues,
    eligibility,
    surface,
    renameEnabled: onRename !== undefined,
    handoffEnabled: handoffEnabled && handoff !== null,
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
                      ? handoffRejectionText(rejection, handoffSession.agentKind)
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
        onOpen(first.id)
        onClose()
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
      case 'closeDone':
        close('done')
        return
      case 'closeWontfix':
        close('wontfix')
        return
      case 'pin':
        run(() => trpc.issues.update.mutate({ id: first.id, patch: { pinned: !first.pinned } }))
        return
      case 'archive':
        run(() => trpc.issues.update.mutate({ id: first.id, patch: { archived: !first.archived } }))
        return
      case 'restore':
        restore()
        return
      case 'delete':
        del()
        return
    }
  }

  const runSubmenu = (kind: IssueMenuSubmenu, value: string): void => {
    switch (kind) {
      case 'stage':
        if ((ISSUE_STAGES as readonly string[]).includes(value)) setStage(value as IssueStage)
        return
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

  const renderIcon = (icon: IssueMenuIcon): ReactNode => {
    const props = { size: 14, 'aria-hidden': true }
    switch (icon) {
      case 'alarm-clock':
        return <AlarmClock {...props} />
      case 'alarm-clock-off':
        return <AlarmClockOff {...props} />
      case 'archive':
        return <Archive {...props} />
      case 'archive-restore':
        return <ArchiveRestore {...props} />
      case 'arrow-right-left':
        return <ArrowRightLeft {...props} />
      case 'agent':
        return <Bot {...props} />
      case 'check':
        return <Check {...props} />
      case 'copy':
        return <Copy {...props} />
      case 'external-link':
        return <ExternalLink {...props} />
      case 'mail':
        return <Mail {...props} />
      case 'mail-open':
        return <MailOpen {...props} />
      case 'palette':
        return <Palette {...props} />
      case 'pencil':
        return <Pencil {...props} />
      case 'pin':
        return <Pin {...props} />
      case 'pin-off':
        return <PinOff {...props} />
      case 'play':
        return <Play {...props} />
      case 'tag':
        return <Tag {...props} />
      case 'trash':
        return <Trash2 {...props} />
      case 'x':
        return <X {...props} />
    }
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
      if (entry.id === 'stage') return <StageGlyph stage={first.stage} />
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
    if (entry.id === 'stage' && option.value)
      return <StageGlyph stage={option.value as IssueStage} />
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
