import { machinePresence } from '@podium/model/browser'
import { MachinePresenceDot } from '@/components/machine-presence'
/**
 * THE "SET UP AGENTS" PANEL on web (POD-6858): the list of harnesses on one
 * machine, one harness's page, and its sign-in choice. Every answer comes from
 * the shared {@link AgentSetupView}; this file only lays it out.
 *
 * Hosts render it in `SetupAgentsDialog` (a 680 px dialog any harness menu
 * opens), Settings › Machine (`embedded`, no dialog chrome) and onboarding
 * (`onboarding`, whose host owns the list footer). A row carries at most ONE
 * control and a chevron to the harness page (POD-7440: the old row squeezed its
 * name to one word per line behind a wrap of buttons).
 */

import { relativeTime } from '@podium/client-core/focus'
import type {
  AgentSetupDetail,
  AgentSetupGroup,
  AgentSetupItem,
  AgentSetupView,
} from '@podium/client-graph/agent-setup-view'
import { observer } from '@podium/client-graph/react'
import type { BuiltinHarnessKind, MachineId } from '@podium/model'
import type { HarnessInstallAction } from '@podium/protocol'
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  X,
} from 'lucide-react'
import { createElement, type ReactNode, useEffect, useRef, useState } from 'react'
import { SetupLoginTerminalDialog } from '@/app/SetupLoginTerminalDialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { agentIconFor } from '@/lib/agent-tone'
import { useAgeNow } from '@/lib/clock-hooks'
import { cn } from '@/lib/utils'
import type { SetupAgentsRequest } from './open-setup-agents'

// ---------------------------------------------------------------------------
// Words the view model leaves to the screen
// ---------------------------------------------------------------------------

/** Who makes each harness, for the line beside its name. */
const MAKER: Readonly<Partial<Record<BuiltinHarnessKind, string>>> = {
  'claude-code': 'Anthropic',
  codex: 'OpenAI',
  grok: 'xAI',
  antigravity: 'Google',
}
/** Whose account a harness's own browser sign-in uses. */
const SIGN_IN_WITH: Readonly<Partial<Record<BuiltinHarnessKind, string>>> = {
  'claude-code': 'Claude',
  codex: 'ChatGPT',
  grok: 'xAI',
  cursor: 'Cursor',
  antigravity: 'Google',
}

const MB = 1024 * 1024
const megabytes = (bytes: number): string => String(Math.max(0, Math.round(bytes / MB)))

/**
 * Highest download percent seen per item. The machine reports percent and bytes
 * per downloaded file, so they restart when an adapter fetches several files:
 * once that happens the bar turns indeterminate instead of moving backwards.
 */
const downloadSeen = new WeakMap<AgentSetupItem, { max: number; restarted: boolean }>()

/** "Downloading · 18 of 41 MB · 44%", or the model's label without progress data. */
export function installStep(item: AgentSetupItem): { text: string; percent?: number } {
  const progress = item.progress
  if (!progress) {
    downloadSeen.delete(item)
    return { text: item.progressLabel ?? `Installing ${item.label}…` }
  }
  switch (progress.phase) {
    case 'download': {
      const seen = downloadSeen.get(item) ?? { max: 0, restarted: false }
      if (progress.percent !== undefined) {
        if (progress.percent < seen.max) seen.restarted = true
        seen.max = Math.max(seen.max, progress.percent)
      }
      downloadSeen.set(item, seen)
      if (seen.restarted || progress.percent === undefined) {
        return {
          text:
            !seen.restarted && progress.totalBytes !== undefined
              ? `Downloading · ${megabytes(progress.receivedBytes ?? 0)} of ${megabytes(progress.totalBytes)} MB`
              : 'Downloading',
        }
      }
      const percent = Math.max(0, Math.min(100, progress.percent))
      const bytes =
        progress.totalBytes !== undefined
          ? ` · ${megabytes(progress.receivedBytes ?? 0)} of ${megabytes(progress.totalBytes)} MB`
          : ''
      return { text: `Downloading${bytes} · ${percent}%`, percent }
    }
    case 'verify':
      downloadSeen.delete(item)
      return { text: 'Checking the download' }
    case 'setup':
      downloadSeen.delete(item)
      return { text: `Setting up Podium’s ${item.label} home` }
  }
}

function HarnessMark({ kind, size = 32 }: { kind: BuiltinHarnessKind; size?: number }) {
  const Icon = agentIconFor(kind)
  return (
    <span
      aria-hidden="true"
      className="inline-flex flex-none items-center justify-center rounded-lg bg-muted text-foreground ring-1 ring-border ring-inset"
      style={{ width: size, height: size }}
    >
      {Icon ? createElement(Icon, { size: Math.round(size / 2), 'aria-hidden': true }) : null}
    </span>
  )
}

function Caption({ children, count }: { children: ReactNode; count?: number | string }) {
  return (
    <p className="m-0 flex items-center gap-2 px-4 pt-4 pb-2 font-mono text-[9.5px] leading-none font-semibold tracking-[0.14em] text-muted-foreground uppercase sm:px-[22px]">
      <span>{children}</span>
      {count !== undefined && (
        <span className="rounded-full bg-muted px-1.5 py-[3px] font-sans text-[10.5px] font-medium tracking-normal normal-case">
          {count}
        </span>
      )}
    </p>
  )
}

function ProgressBar({ percent }: { percent?: number }) {
  return (
    <div
      className="mt-2 h-1 max-w-[360px] overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(percent !== undefined ? { 'aria-valuenow': percent } : {})}
    >
      {percent !== undefined ? (
        <div
          className="h-1 rounded-full bg-primary transition-[width] duration-150"
          style={{ width: `${percent}%` }}
        />
      ) : (
        <div className="setup-agents-indeterminate h-1 w-1/3 rounded-full bg-primary" />
      )}
    </div>
  )
}

function Chip({
  children,
  tone = 'muted',
}: {
  children: ReactNode
  tone?: 'ok' | 'muted' | 'warn'
}) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] flex-none items-center gap-1 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap',
        tone === 'ok' && 'bg-success/10 text-success',
        tone === 'muted' && 'bg-muted text-muted-foreground',
        tone === 'warn' && 'bg-warning/10 text-warning',
      )}
    >
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

type Page = { kind: 'list' } | { kind: 'sign-in'; harness: BuiltinHarnessKind }

/** A machine the header chip can switch to. */
export interface SetupAgentsMachineChoice {
  readonly id: MachineId
  readonly name?: string
}

export interface SetupAgentsPanelProps {
  readonly view: AgentSetupView
  /** `onboarding`: embedded list with the host's install-and-continue footer. */
  readonly variant: 'dialog' | 'embedded' | 'onboarding'
  readonly handBackKind?: SetupAgentsRequest['handBackKind']
  readonly onClose?: () => void
  /** Machines the person may set up; the header chip switches between them. */
  readonly machines?: readonly SetupAgentsMachineChoice[]
  readonly onSwitchMachine?: (machineId: MachineId) => void
}

export const SetupAgentsPanel = observer(function SetupAgentsPanel({
  view,
  variant,
  handBackKind,
  onClose,
  machines,
  onSwitchMachine,
}: SetupAgentsPanelProps) {
  const [page, setPage] = useState<Page>({ kind: 'list' })
  const justInstalled = useJustInstalled(view, (harness) => {
    // A menu waits on the harness it asked about: once installed, ask how it signs in.
    if (view.origin.kind !== 'settings' && harness === view.focus && !view.detail)
      setPage({ kind: 'sign-in', harness })
  })
  const signInItem = page.kind === 'sign-in' ? view.itemFor(page.harness) : undefined
  const detail = view.detail
  const back = () => {
    view.closeDetail()
    setPage({ kind: 'list' })
  }
  const openSignIn = (harness: BuiltinHarnessKind) => {
    view.closeDetail()
    setPage({ kind: 'sign-in', harness })
  }
  const loginItem = view.items.find((item) => item.signIn.loginSessionId)
  return (
    <div
      className={cn(
        'flex min-h-0 flex-col text-foreground',
        variant === 'dialog'
          ? 'max-h-[min(756px,calc(100dvh-2rem))] bg-popover'
          : 'overflow-hidden rounded-lg border border-border bg-card',
        variant === 'onboarding' && 'rounded-[13px]',
      )}
      data-setup-agents={variant}
    >
      {detail ? (
        <DetailPage
          detail={detail}
          view={view}
          variant={variant}
          onBack={back}
          onClose={onClose}
          onSignIn={openSignIn}
        />
      ) : signInItem ? (
        <SignInPage
          item={signInItem}
          view={view}
          variant={variant}
          handBackKind={handBackKind}
          justInstalled={justInstalled.has(signInItem.kind)}
          onBack={back}
          onClose={onClose}
        />
      ) : (
        <ListPage
          view={view}
          variant={variant}
          handBackKind={handBackKind}
          onClose={onClose}
          onSignIn={openSignIn}
          machines={machines}
          onSwitchMachine={onSwitchMachine}
        />
      )}
      <SetupLoginTerminalDialog
        sessionId={loginItem?.signIn.loginSessionId ?? null}
        onClose={() => loginItem?.signIn.closeLogin()}
      />
    </div>
  )
})

/** Harnesses whose install this panel watched finish, in this opening. */
function useJustInstalled(
  view: AgentSetupView,
  onInstalled: (harness: BuiltinHarnessKind) => void,
): ReadonlySet<BuiltinHarnessKind> {
  const seen = useRef(new Map<BuiltinHarnessKind, boolean>())
  const [done, setDone] = useState<ReadonlySet<BuiltinHarnessKind>>(() => new Set())
  const installing = view.items.map((item) => `${item.kind}:${item.installing ? 1 : 0}`).join(',')
  const usable = view.items.map((item) => `${item.kind}:${item.usable ? 1 : 0}`).join(',')
  const callback = useRef(onInstalled)
  callback.current = onInstalled
  // biome-ignore lint/correctness/useExhaustiveDependencies: the keys are the observed facts
  useEffect(() => {
    const finished: BuiltinHarnessKind[] = []
    for (const item of view.items) {
      const was = seen.current.get(item.kind)
      if (was === true && !item.installing && item.usable) finished.push(item.kind)
      seen.current.set(item.kind, item.installing)
    }
    if (!finished.length) return
    setDone((current) => new Set([...current, ...finished]))
    for (const kind of finished) callback.current(kind)
  }, [view, installing, usable])
  return done
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function CloseButton({ onClose }: { onClose?: () => void }) {
  if (!onClose) return null
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Close"
      className="size-11 flex-none text-muted-foreground sm:size-8"
      onClick={onClose}
    >
      <X size={16} aria-hidden="true" />
    </Button>
  )
}

const MachineChip = observer(function MachineChip({
  view,
  machines,
  onSwitchMachine,
}: {
  view: AgentSetupView
  machines?: readonly SetupAgentsMachineChoice[]
  onSwitchMachine?: (machineId: MachineId) => void
}) {
  const others = (machines ?? []).filter((machine) => machine.id !== view.machine.id)
  const dot = <MachinePresenceDot machine={view.machine} className="size-[7px]" />
  const chip =
    'inline-flex h-11 max-w-[14rem] items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs text-foreground sm:h-[30px]'
  if (!onSwitchMachine || others.length === 0)
    return (
      <span className={cn(chip, 'h-[30px] sm:h-[30px]')}>
        {dot}
        <span className="truncate">{view.machineName}</span>
      </span>
    )
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <button type="button" className={chip} aria-label={`Machine: ${view.machineName}`}>
            {dot}
            <span className="truncate">{view.machineName}</span>
            <ChevronDown size={12} aria-hidden="true" className="text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent align="end">
        {others.map((machine) => (
          <DropdownMenuItem key={machine.id} onClick={() => onSwitchMachine(machine.id)}>
            {machine.name || 'Unnamed machine'}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

function SubHeader({ onBack, onClose }: { onBack: () => void; onClose?: () => void }) {
  return (
    <div className="flex flex-none items-center gap-2 border-b border-border px-2 py-1.5 sm:px-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="min-h-11 gap-1 text-muted-foreground sm:min-h-0"
        onClick={onBack}
      >
        <ChevronLeft size={14} aria-hidden="true" />
        All agents
      </Button>
      <span className="flex-1" />
      <CloseButton onClose={onClose} />
    </div>
  )
}

function Footer({ note, children }: { note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-none flex-wrap items-center gap-2.5 border-t border-border bg-muted/40 px-4 py-3 sm:px-[22px]">
      <p className="m-0 min-w-0 flex-1 basis-48 text-xs leading-snug text-muted-foreground">
        {note}
      </p>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const ListPage = observer(function ListPage({
  view,
  variant,
  handBackKind,
  onClose,
  onSignIn,
  machines,
  onSwitchMachine,
}: {
  view: AgentSetupView
  variant: SetupAgentsPanelProps['variant']
  handBackKind?: SetupAgentsPanelProps['handBackKind']
  onClose?: () => void
  onSignIn: (harness: BuiltinHarnessKind) => void
  machines?: readonly SetupAgentsMachineChoice[]
  onSwitchMachine?: (machineId: MachineId) => void
}) {
  return (
    <>
      {variant === 'dialog' && (
        <div className="flex flex-none items-start gap-3 py-3 pr-2 pl-4 sm:border-b sm:border-border sm:py-4 sm:pr-3 sm:pl-[22px]">
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.01em]">Set up agents</h2>
            <p className="m-0 mt-1 text-[12.5px] text-muted-foreground" aria-live="polite">
              {view.checking ? `Checking ${view.machineName}…` : view.summary}
            </p>
          </div>
          <div className="hidden sm:block">
            <MachineChip view={view} machines={machines} onSwitchMachine={onSwitchMachine} />
          </div>
          <CloseButton onClose={onClose} />
        </div>
      )}
      {variant === 'dialog' && (
        <div className="flex-none border-b border-border px-4 py-2 sm:hidden">
          <MachineChip view={view} machines={machines} onSwitchMachine={onSwitchMachine} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
        {!view.reachable && !view.checking && (
          <p className="m-0 mx-4 mt-3 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning sm:mx-[22px]">
            {machinePresence(view.machine) === 'Online'
              ? `You can’t change agents on ${view.machineName}.`
              : machinePresence(view.machine) === 'Reconnecting'
                ? `Reconnecting to ${view.machineName}. Installs and sign-in wait for its current status.`
                : `${view.machineName} is offline. Installs and sign-in wait until it is back.`}
          </p>
        )}
        {view.checking ? (
          <p className="m-0 px-4 py-6 text-sm text-muted-foreground sm:px-[22px]" role="status">
            Checking which agents {view.machineName} has…
          </p>
        ) : (
          view.groups.map((group) => (
            <Group key={group.status} group={group} view={view} onSignIn={onSignIn} />
          ))
        )}
      </div>
      {variant !== 'onboarding' && (
        <ListFooter view={view} variant={variant} handBackKind={handBackKind} onClose={onClose} />
      )}
    </>
  )
})

const Group = observer(function Group({
  group,
  view,
  onSignIn,
}: {
  group: AgentSetupGroup
  view: AgentSetupView
  onSignIn: (harness: BuiltinHarnessKind) => void
}) {
  const selected = group.items.filter((item) => item.selected).length
  return (
    <section aria-label={group.title}>
      <Caption count={selected ? `${selected} selected` : group.items.length}>
        {group.title}
      </Caption>
      {group.items.map((item) => (
        <Row key={item.kind} item={item} view={view} onSignIn={onSignIn} />
      ))}
    </section>
  )
})

/** The one status line of a row. */
function statusLine(item: AgentSetupItem): {
  text: string
  tone: 'muted' | 'warn'
  role?: 'status' | 'alert'
  fix?: string
} {
  switch (item.status) {
    case 'installing':
      return { text: installStep(item).text, tone: 'muted', role: 'status' }
    case 'failed':
      return { text: item.failure ?? 'The install did not finish.', tone: 'warn', role: 'alert' }
    case 'blocked': {
      const block = item.blocked
      return {
        text: block?.reason ?? `Podium can’t install ${item.label} here.`,
        tone: 'warn',
        ...(block?.fix ? { fix: block.fix } : {}),
      }
    }
    case 'not-installed': {
      const prerequisite = item.prerequisites[0]
      if (prerequisite) return { text: prerequisite.reason, tone: 'warn' }
      return { text: item.row.installReason ?? 'Not installed', tone: 'muted' }
    }
    default: {
      const prerequisite = item.prerequisites[0]
      if (prerequisite) return { text: prerequisite.reason, tone: 'warn' }
      const sign = item.signIn.state
      const parts = [item.version, item.sourceLabel]
      if (item.status === 'needs-sign-in' || sign === 'saved-credential')
        parts.push(item.signIn.stateLabel)
      return { text: parts.filter(Boolean).join(' · '), tone: 'muted' }
    }
  }
}

/** The ONE control a row carries, if any. */
function RowControl({
  item,
  onSignIn,
}: {
  item: AgentSetupItem
  onSignIn: (harness: BuiltinHarnessKind) => void
}) {
  const button = 'min-h-11 sm:min-h-[30px] flex-none'
  switch (item.status) {
    case 'installing':
      return item.canCancel ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={button}
          onClick={() => item.cancel()}
        >
          Cancel
        </Button>
      ) : null
    case 'failed':
      return (
        <Button
          type="button"
          size="sm"
          className={button}
          disabled={!item.canInstall}
          onClick={() => item.retry()}
        >
          {item.installLabel}
        </Button>
      )
    case 'needs-sign-in':
      if (item.signIn.state === 'later') return <Chip>Sign in later</Chip>
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={button}
          disabled={!item.row.canAct && item.signIn.savedCredentials.length === 0}
          onClick={() => onSignIn(item.kind)}
        >
          Sign in
        </Button>
      )
    case 'ready':
      if (item.signIn.state === 'signed-in') return <Chip tone="ok">Signed in</Chip>
      if (item.signIn.state === 'later') return <Chip>Sign in later</Chip>
      return <Chip tone="ok">Ready</Chip>
    default:
      return null
  }
}

const Row = observer(function Row({
  item,
  view,
  onSignIn,
}: {
  item: AgentSetupItem
  view: AgentSetupView
  onSignIn: (harness: BuiltinHarnessKind) => void
}) {
  const line = statusLine(item)
  const step = item.status === 'installing' ? installStep(item) : undefined
  const maker = MAKER[item.kind]
  return (
    <div
      className={cn(
        'flex min-h-[60px] items-center gap-3 border-t border-border/60 py-2.5 pr-2 pl-4 sm:pr-3 sm:pl-[22px]',
        (item.selected || item.status === 'installing') && 'bg-primary/5',
        item.status === 'failed' && 'bg-warning/5',
      )}
      data-harness={item.kind}
      data-setup-status={item.status}
    >
      {item.selectable && (
        <span className="relative inline-flex size-[18px] flex-none">
          <input
            type="checkbox"
            className="peer size-[18px] cursor-pointer appearance-none rounded-[5px] border-[1.5px] border-muted-foreground/50 bg-background checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            checked={item.selected}
            aria-label={`Install ${item.label}`}
            onChange={() => view.toggle(item.kind)}
          />
          <Check
            size={12}
            strokeWidth={3.4}
            aria-hidden="true"
            className="pointer-events-none invisible absolute inset-0 m-auto text-primary-foreground peer-checked:visible"
          />
        </span>
      )}
      <span className={cn(item.status === 'blocked' && 'opacity-55')}>
        <HarnessMark kind={item.kind} />
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'm-0 text-sm leading-tight font-medium break-words',
            item.status === 'blocked' && 'text-muted-foreground',
          )}
        >
          {item.label}
          {maker && <span className="ml-1 text-xs font-normal text-muted-foreground">{maker}</span>}
        </p>
        <p
          className={cn(
            'm-0 mt-0.5 line-clamp-2 text-[12.5px] leading-snug',
            line.tone === 'warn' ? 'text-warning' : 'text-muted-foreground',
          )}
          {...(line.role ? { role: line.role } : {})}
        >
          {line.text}
        </p>
        {line.fix && (
          <p className="m-0 mt-0.5 font-mono text-[11.5px] text-warning break-words">{line.fix}</p>
        )}
        {step && <ProgressBar {...(step.percent !== undefined ? { percent: step.percent } : {})} />}
      </div>
      <RowControl item={item} onSignIn={onSignIn} />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Open ${item.label}`}
        className="size-11 flex-none text-muted-foreground sm:size-8"
        onClick={() => view.openDetail(item.kind)}
      >
        <ChevronRight size={16} aria-hidden="true" />
      </Button>
    </div>
  )
})

const ListFooter = observer(function ListFooter({
  view,
  variant,
  handBackKind,
  onClose,
}: {
  view: AgentSetupView
  variant: SetupAgentsPanelProps['variant']
  handBackKind?: SetupAgentsPanelProps['handBackKind']
  onClose?: () => void
}) {
  const selected = view.selectedKinds
  if (selected.length) {
    const [first] = selected
    const only = selected.length === 1 && first ? view.itemFor(first) : undefined
    return (
      <Footer note="Podium installs its own copies. Your own installs are never changed.">
        <Button type="button" variant="ghost" size="sm" onClick={() => view.clearSelection()}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!view.canInstallSelected}
          onClick={() => view.installSelected()}
        >
          {only ? `Install ${only.label}` : `Install ${selected.length} agents`}
        </Button>
      </Footer>
    )
  }
  const primary = view.primary
  const start =
    primary.kind === 'start' ? (
      <Button
        type="button"
        size="sm"
        disabled={!primary.enabled}
        onClick={() => {
          view.start()
          onClose?.()
        }}
      >
        {handBackKind === 'select' && view.focusItem
          ? `Use ${view.focusItem.label}`
          : `${primary.label} session`}
        <ArrowRight size={14} aria-hidden="true" />
      </Button>
    ) : null
  const busy = view.items.some((item) => item.status === 'installing' || item.status === 'failed')
  if (busy)
    return (
      <Footer
        note={
          variant === 'dialog'
            ? 'You can close this; installs keep going. Reopen Set up agents to check on them.'
            : 'Installs keep going if you leave this page.'
        }
      >
        {onClose && (
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        )}
        {start ??
          (onClose && (
            <Button type="button" size="sm" onClick={onClose}>
              Done
            </Button>
          ))}
      </Footer>
    )
  if (variant === 'embedded')
    return view.items.some((item) => item.selectable) ? (
      <Footer note="Tick an agent to install it, or open one to manage it." />
    ) : null
  return (
    <Footer note="Tick an agent to install it, or open one to manage it.">
      {start ?? (
        <Button type="button" size="sm" onClick={onClose}>
          Done
        </Button>
      )}
    </Footer>
  )
})

// ---------------------------------------------------------------------------
// One harness
// ---------------------------------------------------------------------------

const STATUS_CHIP: Readonly<
  Record<AgentSetupItem['status'], { label: string; tone: 'ok' | 'muted' | 'warn' }>
> = {
  ready: { label: 'Ready', tone: 'ok' },
  'needs-sign-in': { label: 'Needs sign-in', tone: 'muted' },
  'not-installed': { label: 'Not installed', tone: 'muted' },
  installing: { label: 'Installing', tone: 'muted' },
  failed: { label: 'Didn’t install', tone: 'warn' },
  blocked: { label: 'Can’t install here', tone: 'warn' },
}

function CheckedAt({ at }: { at: string }) {
  const now = useAgeNow(at)
  return <> · checked {relativeTime(at, now)}</>
}

function Fact({
  label,
  detail,
  value,
  children,
}: {
  label: string
  detail?: ReactNode
  value?: string
  children?: ReactNode
}) {
  return (
    <div className="flex min-h-[50px] flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 py-2 pr-3 pl-4 sm:flex-nowrap sm:pr-4 sm:pl-[22px]">
      <div className="min-w-0 flex-1 basis-48">
        <p className="m-0 text-[13px] leading-snug">{label}</p>
        {detail && (
          <p className="m-0 mt-0.5 text-xs leading-snug text-muted-foreground">{detail}</p>
        )}
      </div>
      {value && <span className="font-mono text-[12.5px] break-all">{value}</span>}
      {children}
    </div>
  )
}

function Notice({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' }) {
  return (
    <p
      className={cn(
        'm-0 mx-4 mt-2 rounded-md px-3 py-2 text-xs leading-snug sm:mx-[22px]',
        tone === 'warn' ? 'bg-warning/10 text-warning' : 'bg-muted text-muted-foreground',
      )}
      {...(tone === 'warn' ? { role: 'alert' } : {})}
    >
      {children}
    </p>
  )
}

const DetailPage = observer(function DetailPage({
  detail,
  view,
  variant,
  onBack,
  onClose,
  onSignIn,
}: {
  detail: AgentSetupDetail
  view: AgentSetupView
  variant: SetupAgentsPanelProps['variant']
  onBack: () => void
  onClose?: () => void
  onSignIn: (harness: BuiltinHarnessKind) => void
}) {
  const item = detail.item
  const chip = STATUS_CHIP[item.status]
  const maker = MAKER[item.kind]
  const sections = new Map(detail.sections.map((section) => [section.key, section.actions]))
  const has = (key: string, action: HarnessInstallAction) =>
    (sections.get(key as never) ?? []).includes(action)
  const step = item.status === 'installing' ? installStep(item) : undefined
  const updates = sections.get('updates') ?? []
  const own = sections.get('own') ?? []
  const installActions = sections.get('install') ?? []
  const press = (action: HarnessInstallAction) => detail.press(action)
  const signedIn = item.signIn.state === 'signed-in' || item.signIn.state === 'saved-credential'
  return (
    <>
      <SubHeader onBack={onBack} onClose={variant === 'dialog' ? onClose : undefined} />
      <div className="flex flex-none items-center gap-3 px-4 pt-4 pb-2 sm:px-[22px]">
        <HarnessMark kind={item.kind} size={40} />
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-[17px] font-semibold tracking-[-0.01em]">{item.label}</h2>
          <p className="m-0 mt-0.5 text-xs text-muted-foreground">
            {[maker, view.machineName].filter(Boolean).join(' · ')}
            {detail.lastCheckAt && <CheckedAt at={detail.lastCheckAt} />}
          </p>
        </div>
        <Chip tone={chip.tone}>{chip.label}</Chip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3">
        <Caption>This machine</Caption>
        <Fact
          label="Podium’s copy"
          detail={
            step ? (
              <>
                <span role="status">{step.text}</span>
                <ProgressBar {...(step.percent !== undefined ? { percent: step.percent } : {})} />
              </>
            ) : detail.podiumVersion ? (
              'Used by Podium sessions on this machine'
            ) : (
              (detail.podiumLabel ?? 'Not installed yet')
            )
          }
          {...(detail.podiumVersion ? { value: detail.podiumVersion } : {})}
        >
          {item.canCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={() => item.cancel()}>
              Cancel
            </Button>
          )}
        </Fact>
        {detail.ownLabel && (
          <Fact
            label="Your install"
            detail={
              item.row.tooOld
                ? 'Too old for Podium. Podium leaves it as it is.'
                : 'Left as it is; Podium never changes it'
            }
            {...(detail.ownVersion ? { value: detail.ownVersion } : {})}
          />
        )}
        {item.usable && (
          <Fact label="Sign-in" detail={item.signIn.stateLabel}>
            <Button
              type="button"
              variant={signedIn ? 'ghost' : 'outline'}
              size="sm"
              className="min-h-11 sm:min-h-0"
              onClick={() => onSignIn(item.kind)}
            >
              {signedIn ? 'Change' : 'Sign in'}
            </Button>
          </Fact>
        )}
        {item.failure && <Notice tone="warn">{item.failure}</Notice>}
        {item.blocked && (
          <Notice tone="warn">
            {item.blocked.reason}
            {item.blocked.fix && (
              <span className="mt-1 block font-mono text-[11.5px]">{item.blocked.fix}</span>
            )}
          </Notice>
        )}
        {item.prerequisites.map((prerequisite) => (
          <Notice key={prerequisite.reason} tone="warn">
            {prerequisite.reason}
          </Notice>
        ))}
        {detail.installReason && !item.blocked && <Notice>{detail.installReason}</Notice>}
        {detail.updateNotice && <Notice>{detail.updateNotice}</Notice>}
        {detail.sharingWarning && <Notice tone="warn">{detail.sharingWarning}</Notice>}
        {detail.ledgerNotice && <Notice tone="warn">{detail.ledgerNotice}</Notice>}
        {detail.lastError && detail.lastError !== item.failure && (
          <Notice tone="warn">{detail.lastError}</Notice>
        )}

        {updates.length > 0 && (
          <>
            <Caption>Updates</Caption>
            {detail.autoUpdate !== undefined &&
              (has('updates', 'pause') || has('updates', 'resume')) && (
                <Fact label="Update automatically" detail="Waits until no session is using it">
                  <Switch
                    aria-label="Update automatically"
                    checked={detail.autoUpdate}
                    disabled={detail.disabled(detail.autoUpdate ? 'pause' : 'resume')}
                    onCheckedChange={() => press(detail.autoUpdate ? 'pause' : 'resume')}
                  />
                </Fact>
              )}
            {has('updates', 'check') && (
              <Fact
                label="Check for a new version"
                {...(detail.latestVersion
                  ? { detail: `Latest seen: ${detail.latestVersion}` }
                  : {})}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={detail.disabled('check')}
                  onClick={() => press('check')}
                >
                  {detail.label('check')}
                </Button>
              </Fact>
            )}
            {has('updates', 'back') && (
              <Fact
                label="Go back to an earlier version"
                {...(item.row.managed?.previousVersion
                  ? { detail: `${item.row.managed.previousVersion} is kept on this machine` }
                  : {})}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={detail.disabled('back')}
                  onClick={() => press('back')}
                >
                  {detail.label('back')}
                </Button>
              </Fact>
            )}
          </>
        )}

        {own.length > 0 && (
          <>
            <Caption>Your own install</Caption>
            {(has('own', 'changes') || has('own', 'remove-changes')) && (
              <Fact
                label="Podium’s changes to your settings"
                detail="Hooks and settings Podium wrote in your own folder"
              >
                {has('own', 'changes') && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={detail.disabled('changes')}
                    onClick={() => press('changes')}
                  >
                    Show
                  </Button>
                )}
                {has('own', 'remove-changes') && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={detail.disabled('remove-changes')}
                    onClick={() => press('remove-changes')}
                  >
                    Undo
                  </Button>
                )}
              </Fact>
            )}
            {has('own', 'take-settings') && (
              <Fact
                label="Copy your settings into Podium’s copy"
                detail="Model, permissions and MCP servers"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={detail.disabled('take-settings')}
                  onClick={() => press('take-settings')}
                >
                  Copy
                </Button>
              </Fact>
            )}
          </>
        )}
        <Answers detail={detail} />
      </div>
      <DetailFooter detail={detail} installActions={installActions} />
    </>
  )
})

/** What the last action on this page answered. */
const Answers = observer(function Answers({ detail }: { detail: AgentSetupDetail }) {
  const changes = detail.changes
  const home = detail.home
  return (
    <>
      {detail.waiting && (
        <p role="status" className="m-0 px-4 pt-3 text-xs text-muted-foreground sm:px-[22px]">
          Waiting for the machine…
        </p>
      )}
      {detail.error && <Notice tone="warn">{detail.error}</Notice>}
      {detail.pendingSessionsNote && <Notice>{detail.pendingSessionsNote}</Notice>}
      {changes && (
        <section aria-label="Podium’s changes" className="mx-4 mt-3 space-y-2 sm:mx-[22px]">
          {changes.length === 0 ? (
            <p className="m-0 text-xs text-muted-foreground">
              No Podium changes are recorded in your own {detail.item.label} folder.
            </p>
          ) : (
            changes.map((change) => (
              <div key={change.id} className="rounded-md border border-border p-2 text-xs">
                <p className="m-0 font-mono break-all">{change.file}</p>
                <p className="m-0 mt-1 text-muted-foreground">
                  {change.edit.kind === 'owned-file'
                    ? 'File created by Podium'
                    : change.edit.kind === 'hook-handlers'
                      ? `Podium’s hooks for ${change.edit.events.length} events`
                      : `${change.edit.path.join('.')} = ${JSON.stringify(change.edit.value)}`}
                </p>
                {change.status && (
                  <p className="m-0 mt-1 text-muted-foreground">
                    {change.status === 'changed'
                      ? 'Kept: you changed this after Podium wrote it.'
                      : change.status === 'restored'
                        ? 'Restored.'
                        : `Could not restore: ${change.reason ?? 'unknown error'}`}
                  </p>
                )}
              </div>
            ))
          )}
        </section>
      )}
      {home && (
        <section
          aria-label="Podium home"
          className="mx-4 mt-3 rounded-md border border-border p-3 text-xs sm:mx-[22px]"
        >
          <p className="m-0">
            {home.exists
              ? home.conversations.length
                ? 'The Podium home holds these conversations:'
                : 'The Podium home holds no stored conversations.'
              : 'There is no Podium home on this machine.'}
          </p>
          {home.conversations.length > 0 && (
            <ul className="my-2 list-inside list-disc">
              {home.conversations.map((conversation) => (
                <li key={conversation.id}>
                  {conversation.title}{' '}
                  <span className="text-muted-foreground">({conversation.id})</span>
                </li>
              ))}
            </ul>
          )}
          {detail.confirmingRemoveHome ? (
            <div className="mt-2 space-y-2">
              <p className="m-0">{detail.removeHomeConfirmation}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => detail.cancelRemoveHome()}
                >
                  Keep it
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => detail.confirmRemoveHome()}
                >
                  Delete Podium home
                </Button>
              </div>
            </div>
          ) : (
            detail.sections.some((section) => section.actions.includes('remove-home')) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={detail.disabled('remove-home')}
                onClick={() => detail.press('remove-home')}
              >
                {detail.label('remove-home')}…
              </Button>
            )
          )}
        </section>
      )}
    </>
  )
})

const DetailFooter = observer(function DetailFooter({
  detail,
  installActions,
}: {
  detail: AgentSetupDetail
  installActions: readonly HarnessInstallAction[]
}) {
  if (detail.confirmingRemove)
    return (
      <Footer note={detail.removeConfirmation}>
        <Button type="button" variant="ghost" size="sm" onClick={() => detail.cancelRemove()}>
          Keep it
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => detail.confirmRemove()}
        >
          Remove
        </Button>
      </Footer>
    )
  const hasHome = detail.sections.some((section) => section.actions.includes('home-info'))
  const removable = detail.sections.some((section) => section.actions.includes('remove'))
  if (!hasHome && !removable && installActions.length === 0) return null
  return (
    <div className="flex flex-none flex-wrap items-center gap-2 border-t border-border bg-muted/40 px-3 py-2.5 sm:px-4">
      {hasHome && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={detail.disabled('home-info')}
          onClick={() => detail.press('home-info')}
        >
          Podium home…
        </Button>
      )}
      <span className="flex-1" />
      {removable && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={detail.disabled('remove')}
          onClick={() => detail.press('remove')}
        >
          Remove Podium’s copy…
        </Button>
      )}
      {installActions.map((action) => (
        <Button
          key={action}
          type="button"
          variant={action === 'install' ? 'default' : 'outline'}
          size="sm"
          disabled={detail.disabled(action)}
          {...(action === 'install' && detail.installReason ? { title: detail.installReason } : {})}
          onClick={() => detail.press(action)}
        >
          {action === 'install' && detail.item.status !== 'failed'
            ? `Install ${detail.item.label}`
            : detail.label(action)}
        </Button>
      ))}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

const SignInPage = observer(function SignInPage({
  item,
  view,
  variant,
  handBackKind,
  justInstalled,
  onBack,
  onClose,
}: {
  item: AgentSetupItem
  view: AgentSetupView
  variant: SetupAgentsPanelProps['variant']
  handBackKind?: SetupAgentsPanelProps['handBackKind']
  justInstalled: boolean
  onBack: () => void
  onClose?: () => void
}) {
  const signIn = item.signIn
  const [picking, setPicking] = useState(false)
  const chosen =
    signIn.state === 'saved-credential'
      ? 'saved'
      : signIn.state === 'later'
        ? 'later'
        : signIn.state === 'signed-in' ||
            signIn.state === 'opening' ||
            signIn.state === 'signing-in'
          ? 'browser'
          : undefined
  const saved = signIn.savedCredentials
  // `useSavedCredential` is the model's method, not a React hook.
  const applySaved = (id: string) =>
    // biome-ignore lint/correctness/useHookAtTopLevel: a view-model method named "use…", not a hook
    void signIn.useSavedCredential(id)
  const choose = (kind: 'browser' | 'saved' | 'later') => {
    if (kind === 'browser') void signIn.signInWithBrowser()
    else if (kind === 'later') signIn.chooseLater()
    else if (saved.length === 1 && saved[0]) applySaved(saved[0].id)
    else setPicking(true)
  }
  const title = (kind: 'browser' | 'saved' | 'later', fallback: string) =>
    kind === 'browser' && SIGN_IN_WITH[item.kind]
      ? `Sign in with ${SIGN_IN_WITH[item.kind]}`
      : fallback
  // The opener can start this harness: it is the focus, or the person set it up
  // here instead, and "Start" retargets the hand-back to it (setFocus).
  const canHandBack = view.origin.kind !== 'settings' && view.origin.onStart !== undefined
  const others = view.items.filter((other) => other !== item && other.status === 'installing')
  return (
    <>
      <SubHeader onBack={onBack} onClose={variant === 'dialog' ? onClose : undefined} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-[22px]">
        {justInstalled && (
          <p className="m-0 mb-4 flex items-start gap-2 rounded-md bg-success/10 px-3 py-2.5 text-[13px] text-foreground">
            <CircleCheck size={16} aria-hidden="true" className="mt-px flex-none text-success" />
            <span>
              Installed {item.label}{' '}
              {item.version && <span className="font-mono text-xs">{item.version}</span>} for
              Podium. Your own {item.label}, if you have one, wasn’t touched.
            </span>
          </p>
        )}
        <h3 className="m-0 text-[15px] font-semibold">How should {item.label} sign in?</h3>
        <p className="m-0 mt-1 text-[12.5px] leading-snug text-muted-foreground">
          Browser sign-in applies to Podium’s copy on {view.machineName}. A saved credential becomes
          your default for every {item.label} session you start, on any machine. You can change it
          later from this panel.
        </p>
        <div role="radiogroup" aria-label="Sign-in" className="mt-4 flex flex-col gap-2">
          {signIn.choices.map((choice) => {
            const checked = chosen === choice.kind
            return (
              // biome-ignore lint/a11y/useSemanticElements: a card choice with a title and a detail line, not a bare input
              <button
                key={choice.kind}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={!choice.available}
                onClick={() => choose(choice.kind)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border px-3.5 py-3 text-left disabled:cursor-not-allowed disabled:opacity-50',
                  checked
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-background hover:bg-muted/50',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-4 flex-none rounded-full border',
                    checked ? 'border-[5px] border-primary' : 'border-muted-foreground/50',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium">
                    {title(choice.kind, choice.title)}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {choice.kind === 'saved' && signIn.savedCredentialLabel && chosen === 'saved'
                      ? `Uses ${signIn.savedCredentialLabel}. ${choice.detail}`
                      : choice.kind === 'saved' && !choice.available
                        ? 'No saved credential works with this agent yet. Add one in Credentials.'
                        : choice.detail}
                  </span>
                </span>
                {choice.kind === 'browser' && signIn.opening && (
                  <span className="text-xs text-muted-foreground">Opening…</span>
                )}
              </button>
            )
          })}
        </div>
        {picking && saved.length > 1 && (
          <fieldset className="mt-3 rounded-lg border border-border p-2">
            <legend className="px-1 text-xs text-muted-foreground">Saved credentials</legend>
            {saved.map((credential) => (
              <Button
                key={credential.id}
                type="button"
                variant={signIn.savedCredentialId === credential.id ? 'secondary' : 'ghost'}
                size="sm"
                className="h-auto min-h-11 w-full justify-start py-1.5 text-left sm:min-h-9"
                onClick={() => {
                  applySaved(credential.id)
                  setPicking(false)
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate">{credential.label}</span>
                  {credential.hint && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {credential.hint}
                    </span>
                  )}
                </span>
              </Button>
            ))}
          </fieldset>
        )}
        {signIn.state === 'signing-in' && (
          <p role="status" className="m-0 mt-3 text-xs text-muted-foreground">
            {signIn.stateLabel}
          </p>
        )}
        {signIn.error && (
          <p role="alert" className="m-0 mt-3 text-xs text-warning">
            {signIn.error}
          </p>
        )}
      </div>
      <Footer
        note={
          others.length
            ? others
                .map((other) => {
                  const percent = installStep(other).percent
                  return `${other.label} is still installing${percent !== undefined ? ` · ${percent}%` : ''}`
                })
                .join(' · ')
            : signIn.stateLabel
        }
      >
        {canHandBack ? (
          <Button
            type="button"
            size="sm"
            disabled={!item.readyToStart}
            onClick={() => {
              if (view.focus !== item.kind) view.setFocus(item.kind)
              view.start()
              onClose?.()
            }}
          >
            {handBackKind === 'select' ? `Use ${item.label}` : `Start ${item.label} session`}
            <ArrowRight size={14} aria-hidden="true" />
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={onBack}>
            Done
          </Button>
        )}
      </Footer>
    </>
  )
})
