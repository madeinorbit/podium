import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import type { RecentFileEntry, RepoView, WorktreeView } from '@podium/client-core/viewmodels'
import { reposToViews } from '@podium/client-core/viewmodels'
import {
  type AgentKind,
  agentCapabilityRejection,
  agentLoginCondition,
  agentProbeTimeoutDescription,
  asMachineId,
  type IssueId,
  type MachineId,
  type MachineWire,
  machinesForRepoOrClone,
  onlineMachinesForRepoOrClone,
  resolveTargetMachineForAgent,
  type SessionId,
} from '@podium/model/browser'
import { Circle, FileText, SquarePlus } from 'lucide-react'
import type React from 'react'
import { type JSX, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  agentLabel,
  CapabilityAgentItem,
  capabilityHint,
  capabilityReason,
  loginWarning,
} from '@/lib/agent-capability'
import { AGENT_KIND_ICON } from '@/lib/agent-tone'
import { MENU_HEADER, MENU_HEADER_REF, MENU_HINT, MENU_SECTION } from '@/lib/menu-surface'
import { headlessRuntimeDrivers, runtimeDriverLabel } from '@/lib/runtime-driver-options'
import { useFeature } from '@/lib/use-feature'
import { useStoreSelector } from './store'

type IconComponent = React.ComponentType<Record<string, unknown>>

/** Menu copy per harness. The MARK for each one comes from `agent-tone`'s
 *  kind→icon table (POD-591) rather than a second list here — this menu and the
 *  fleet stacks on the board and in the sidebar all draw the same glyph, so
 *  adding a harness is one row in one file. */
const NEW_AGENT_LABELS: readonly (readonly [AgentKind, string])[] = [
  ['claude-code', 'New Claude'],
  ['codex', 'New Codex'],
  ['grok', 'New Grok'],
  ['opencode', 'New OpenCode'],
  ['cursor', 'New Cursor'],
  ['pi', 'New Pi'],
  ['shell', 'New Shell'],
]

export const NEW_AGENTS: { kind: AgentKind; label: string; Icon: IconComponent }[] =
  NEW_AGENT_LABELS.map(([kind, label]) => ({
    kind,
    label,
    Icon: AGENT_KIND_ICON[kind],
  }))

// The workspace "+" (new tab) menu lists every agent kind, including 'New Shell'.
// (SP-75b1 had excluded shells from this menu; we deliberately keep them here.)
// Each row is still capability-gated below; a shell is always allowed on an
// online machine (agentCapabilityRejection returns undefined for 'shell').
const TAB_AGENTS = NEW_AGENTS

// Recent files shown in the menu (POD-149) — reachability, not a file browser.
const RECENT_LIMIT = 6

/** Every glyph in the panel is 14px on one text column, so agent marks and file
 *  glyphs leave their labels at the same x. That is also the dropdown's own
 *  default, so this states in the markup what the panel depends on rather than
 *  inheriting it silently. */
const MENU_GLYPH = 'size-3.5 flex-none'

/** A machine's status dot is a reading, not an icon, so it keeps the 6px the
 *  sidebar and the new-agent menu draw it at — but it is indented into the same
 *  14px column, so the names still line up with the labels above them. */
const MACHINE_DOT = 'mx-[4px] size-1.5 flex-none'

/**
 * The "+" menu: start a fresh agent or shell in this checkout.
 *
 * ---------------------------------------------------------------------------
 * NO RESUME REGION (POD-1201)
 * ---------------------------------------------------------------------------
 *
 * It used to end in a RESUME section — a server-indexed mini-search over
 * discovered conversations, with its own filter field that took the menu's focus
 * on open and forced the panel non-modal so the mobile keyboard could pin. The
 * operator's call is that the "+" is for STARTING something: a history search
 * competing for the same 248px is a second, differently-shaped tool wearing the
 * new-panel menu's clothes, and it was the region that decided this menu's focus
 * behaviour for every other row in it. Picking up an old conversation is its own
 * gesture and does not belong on the tab strip's plus.
 *
 * ---------------------------------------------------------------------------
 * THE HOUSE VOCABULARY (POD-1084)
 * ---------------------------------------------------------------------------
 *
 * This menu opens one pixel from the tab strip's own context menu and, before
 * POD-1084, wore a different skin than every other overlay in the shell: stock
 * shadcn popover tokens over `--popover`, a `ring-foreground/10` hairline,
 * `shadow-md`, 14px rows, and section headings invented here in Geist Sans small
 * caps. `lib/menu-surface` (POD-380) is the vocabulary the session menu, the
 * issue menu and the colour picker already share, and it exists precisely
 * because two overlays a pixel apart must read as one family.
 *
 * POD-1084 dressed this one menu through a pair of opt-in bridge constants;
 * POD-1099 moved the preset into `components/ui/dropdown-menu` itself, so the
 * panel, the rows and the rules below are simply what a dropdown looks like now
 * and this file only says what is particular to it — its width, its header, its
 * search field, and the sections it names.
 */
export function NewPanelMenu({
  worktree,
  onOpened,
  open: controlledOpen,
  onOpenChange,
  trigger,
  issueId,
}: {
  worktree: WorktreeView
  onOpened: (sessionId: SessionId) => void
  /** Attach every session spawned from this menu to an issue (issue-as-workspace:
   *  the "+" inside an issue-keyed workspace). Omitted = today's behavior. */
  issueId?: IssueId
  /** Controlled open state. Omit to leave the menu self-managed (uncontrolled). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Override the default "+" trigger button (e.g. a compact per-repo "+"). */
  trigger?: React.ReactElement
}): JSX.Element {
  const { trpc, repos, sessions, machines, setPanelMode } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      repos: s.repos,
      sessions: s.sessions,
      machines: s.machines,
      setPanelMode: s.setPanelMode,
    }),
    shallowEqual,
  )
  // Uncontrolled fallback so the desktop/mobile "+" still works without a parent
  // driving its open state; the controlled props win when supplied.
  const [internalOpen, setInternalOpen] = useState(false)
  const runtimeDriversEnabled = useFeature('runtime-drivers')
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next)
    onOpenChange?.(next)
  }

  // Resolve the repo view for the current worktree (cross-machine merged view).
  const repoView = useMemo((): RepoView => {
    const found = reposToViews(repos).find((r) => r.worktrees.some((w) => w.path === worktree.path))
    if (found) return found
    // Fallback: synthesize a minimal single-machine RepoView so the logic below
    // never has to branch on undefined.
    return {
      path: worktree.repoPath,
      name: worktree.repoPath.split('/').pop() || worktree.repoPath,
      worktrees: [worktree],
      machines: worktree.machineId ? [{ machineId: worktree.machineId, path: worktree.path }] : [],
    }
  }, [repos, worktree])

  // The recommended machine is agent-specific: a host with the repo but without
  // this harness (or its login) must never receive an optimistic spawn.
  function targetFor(agentKind: AgentKind): string | undefined {
    return resolveTargetMachineForAgent(repoView, sessions, machines, agentKind)
  }

  /** Local path to use when opening an agent on machine M. */
  function cwdFor(machineId: MachineId | undefined): string {
    if (!machineId || machineId === worktree.machineId) return worktree.path
    return repoView.machines.find((m) => m.machineId === machineId)?.path ?? worktree.path
  }

  async function create(
    agentKind: AgentKind,
    machineId?: MachineId,
    runtimeContract?: string | true,
  ) {
    const cwd = cwdFor(machineId)
    // OpenCode's headed default is the stock native CLI attached to its existing
    // server-family engine. `true` asks the shared resolver for the manifest
    // default without naming a driver, so an unavailable/logged-out server can
    // still degrade to the interactive terminal login path. The experimental
    // driver row passes its concrete string and therefore remains an explicit
    // per-session selection rather than being collapsed into this default.
    const headedOpencode = runtimeContract === undefined && agentKind === 'opencode'
    const driverRequest = runtimeContract ?? (headedOpencode ? true : undefined)
    const { sessionId } = await trpc.sessions.create.mutate({
      agentKind,
      cwd,
      ...(machineId ? { machineId } : {}),
      ...(issueId ? { issueId } : {}),
      ...(driverRequest !== undefined ? { runtimeContract: driverRequest } : {}),
    })
    // Server-family sessions derive Chat before startScreen/device preferences.
    // Materialize this row's headed intent before exposing the new tab, matching
    // the established blank-launch ordering in ColdStartComposer. The explicit
    // experimental driver row intentionally receives no override and stays
    // chat-first.
    if (headedOpencode) setPanelMode(sessionId, 'native')
    onOpened(sessionId)
  }

  const defaultTrigger = (
    <Button variant="ghost" size="icon" aria-label="New panel">
      <SquarePlus size={16} />
    </Button>
  )

  const header = (
    // The header the session menu and the colour picker wear (POD-380) — the
    // label in machine voice, the SUBJECT pushed right in normal case. The
    // subject here is where a pick will land: every row in this panel opens in
    // one specific checkout, and until now nothing in it said which.
    <div className={`${MENU_HEADER} px-[5px]`}>
      <span>NEW PANEL</span>
      <span className={`${MENU_HEADER_REF} min-w-0 truncate normal-case`}>
        {worktreeLabel(worktree, repoView)}
      </span>
    </div>
  )

  // Single-machine (or no machines yet): no Machines region to choose between.
  if (machines.length <= 1) {
    const machine = machines[0]
    return (
      // modal={false}: this opens a pixel from the tab strip inside a shell that
      // scrolls behind it, and scroll-locking the whole window for a 248px menu
      // is a heavier claim than the gesture makes.
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger render={trigger ?? defaultTrigger} />
        <DropdownMenuContent
          align="end"
          className="flex w-[248px] max-w-[calc(100vw-24px)] flex-col"
        >
          {header}
          {TAB_AGENTS.map(({ kind, label, Icon }) => {
            const rejection = machine ? agentCapabilityRejection(machine, kind) : undefined
            const reason = machine
              ? capabilityReason(
                  machine.name,
                  label,
                  rejection,
                  agentProbeTimeoutDescription(machine, kind),
                )
              : undefined
            const hint = machine ? capabilityHint(rejection) : undefined
            const warning = machine
              ? loginWarning(machine.name, label, agentLoginCondition(machine, kind))
              : undefined
            return (
              <CapabilityAgentItem
                key={kind}
                label={label}
                icon={<Icon className={`${MENU_GLYPH} text-text-dim`} aria-hidden="true" />}
                status={{
                  ...(reason ? { reason } : {}),
                  ...(hint ? { hint } : {}),
                  ...(warning ? { warning } : {}),
                }}
                onSelect={() => void create(kind, machine?.id)}
              />
            )
          })}
          {runtimeDriversEnabled && machine ? (
            <HeadlessDriverItems machine={machine} onCreate={create} />
          ) : null}
          <RecentFilesSection worktree={worktree} {...(issueId ? { issueId } : {})} />
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  // Multi-machine path.
  const repoMachines = machinesForRepoOrClone(repoView, machines)
  const eligible = onlineMachinesForRepoOrClone(repoView, machines)
  const eligibleIds = new Set(eligible.map((m) => m.id))

  return (
    // modal={false}: see the single-machine panel above.
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger render={trigger ?? defaultTrigger} />
      <DropdownMenuContent align="end" className="flex w-[248px] max-w-[calc(100vw-24px)] flex-col">
        {header}

        {/* 1. Agent options — open on the resolved target machine */}
        {TAB_AGENTS.map(({ kind, label, Icon }) => {
          const target = targetFor(kind)
          return (
            <CapabilityAgentItem
              key={kind}
              label={label}
              icon={<Icon className={`${MENU_GLYPH} text-text-dim`} aria-hidden="true" />}
              status={
                target
                  ? {}
                  : {
                      reason: `No online machine with this repository can run ${agentLabel(label)}.`,
                      hint: 'no host',
                    }
              }
              onSelect={() =>
                void create(kind, target === undefined ? undefined : asMachineId(target))
              }
            />
          )
        })}

        {/* 2. Machines section */}
        <div className={MENU_SECTION}>MACHINES</div>
        <TooltipProvider>
          {repoMachines.map((machine) => {
            const isEligible = eligibleIds.has(machine.id)
            if (!isEligible) {
              const tooltipText = `${machine.name} is offline`
              return (
                <Tooltip key={machine.id}>
                  {/*
                   * The wrapper span is the actual tooltip trigger — it stays
                   * pointer-events-auto so mouseenter/mouseover reach Base UI's
                   * tooltip logic. The inner DropdownMenuItem is disabled
                   * (data-disabled → pointer-events-none + opacity-50 via CSS)
                   * which prevents clicks from spawning an agent, but the
                   * pointer events bubble up through the DOM to the span wrapper
                   * before the CSS suppression fires on the item itself, so
                   * hover events DO reach the trigger. The item's visual
                   * disabled state (opacity) is preserved via its disabled prop.
                   */}
                  <TooltipTrigger render={<span className="block pointer-events-auto" />}>
                    <DropdownMenuItem disabled>
                      <Circle className={`${MACHINE_DOT} text-text-faint`} aria-hidden="true" />
                      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                        {machine.name}
                      </span>
                      {/* The reason is stated inline as well as on hover: a
                          tooltip is the one affordance a touch pointer never
                          reaches, and this row is refusing a click. */}
                      <span className={MENU_HINT}>offline</span>
                    </DropdownMenuItem>
                  </TooltipTrigger>
                  <TooltipContent side="right">{tooltipText}</TooltipContent>
                </Tooltip>
              )
            }

            return (
              <MachineSubmenu
                key={machine.id}
                machine={machine}
                onCreate={create}
                runtimeDriversEnabled={runtimeDriversEnabled}
              />
            )
          })}
        </TooltipProvider>

        <RecentFilesSection worktree={worktree} {...(issueId ? { issueId } : {})} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** What the header's subject line says: the branch a worktree is on, or the repo
 *  name when this is the main checkout (where "main" would name the branch and
 *  not the place). */
function worktreeLabel(worktree: WorktreeView, repoView: RepoView): string {
  if (!worktree.isMain && worktree.branch) return worktree.branch
  return repoView.name || worktree.repoPath.split('/').pop() || worktree.repoPath
}

/** The "+" menu's Recent-files section (POD-149): strict issue scoping shows a
 *  file tab only under its owning issue, so this list is how a file opened
 *  under another issue (or closed) stays reachable from the current checkout.
 *  Reopening an ordinary file stamps it to the CURRENT issue; an artifact
 *  snapshot reopens via its immutable store and reveals its owning issue. */
function RecentFilesSection({
  worktree,
  issueId,
}: {
  worktree: WorktreeView
  issueId?: IssueId
}): JSX.Element | null {
  const { recentFiles, openFileInWorktree, openArtifact } = useStoreSelector(
    (s) => ({
      recentFiles: s.recentFiles,
      openFileInWorktree: s.openFileInWorktree,
      openArtifact: s.openArtifact,
    }),
    shallowEqual,
  )
  const now = Date.now()
  const entries = recentFiles.filter((f) => f.worktreePath === worktree.path).slice(0, RECENT_LIMIT)
  if (entries.length === 0) return null

  const reopen = (f: RecentFileEntry): void => {
    if (f.artifact) {
      openArtifact({
        issueId: f.artifact.issueId,
        artifactId: f.artifact.artifactId,
        path: f.path,
        ...(f.worktreePath ? { worktreePath: f.worktreePath } : {}),
      })
      return
    }
    openFileInWorktree({
      ...(f.machineId ? { machineId: f.machineId } : {}),
      root: f.worktreePath,
      path: f.path,
      ...(issueId ? { issueId } : {}),
    })
  }

  return (
    <>
      <div className={MENU_SECTION}>RECENT FILES</div>
      {entries.map((f) => (
        <DropdownMenuItem
          key={`${f.worktreePath} ${f.path} ${f.artifact?.artifactId ?? ''}`}
          onClick={() => reopen(f)}
        >
          <FileText className={`${MENU_GLYPH} text-text-dim`} aria-hidden="true" />
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {f.path.split('/').pop() || f.path}
          </span>
          <span className={`${MENU_HINT} tabular-nums`}>
            {relativeTime(new Date(f.openedAt).toISOString(), now)}
          </span>
        </DropdownMenuItem>
      ))}
    </>
  )
}

/** The submenu for one eligible machine in the multi-machine menu. */
function HeadlessDriverItems({
  machine,
  onCreate,
}: {
  machine: MachineWire
  onCreate: (
    kind: AgentKind,
    machineId: MachineId,
    runtimeContract?: string | true,
  ) => Promise<void>
}): JSX.Element | null {
  const drivers = headlessRuntimeDrivers(machine)
  if (drivers.length === 0) return null
  return (
    <>
      <div className={MENU_SECTION}>HEADLESS DRIVERS</div>
      {drivers.map((driver) => {
        const agent = NEW_AGENTS.find((candidate) => candidate.kind === driver.harness)
        if (!agent) return null
        const Icon = agent.Icon
        const loggedOut = agentLoginCondition(machine, driver.harness) === 'logged-out'
        return (
          <CapabilityAgentItem
            key={`${driver.harness}:${driver.id}`}
            label={`${agent.label} — ${runtimeDriverLabel(driver.id)}`}
            icon={<Icon className={`${MENU_GLYPH} text-text-dim`} aria-hidden="true" />}
            status={{
              ...(loggedOut
                ? {
                    warning: `${machine.name} is logged out; this driver may refuse or fall back.`,
                    hint: 'logged out',
                  }
                : {}),
            }}
            onSelect={() => void onCreate(driver.harness, machine.id, driver.id)}
          />
        )
      })}
    </>
  )
}

function MachineSubmenu({
  machine,
  onCreate,
  runtimeDriversEnabled,
}: {
  machine: MachineWire
  onCreate: (
    kind: AgentKind,
    machineId: MachineId,
    runtimeContract?: string | true,
  ) => Promise<void>
  runtimeDriversEnabled: boolean
}): JSX.Element {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Circle
          className={`${MACHINE_DOT} ${machine.online ? 'fill-success text-success' : 'text-text-faint'}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {machine.name}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[168px]">
        {TAB_AGENTS.map(({ kind, label, Icon }) => {
          const rejection = agentCapabilityRejection(machine, kind)
          const reason = capabilityReason(
            machine.name,
            label,
            rejection,
            agentProbeTimeoutDescription(machine, kind),
          )
          const hint = capabilityHint(rejection)
          const warning = loginWarning(machine.name, label, agentLoginCondition(machine, kind))
          return (
            <CapabilityAgentItem
              key={kind}
              label={label}
              icon={<Icon className={`${MENU_GLYPH} text-text-dim`} aria-hidden="true" />}
              status={{
                ...(reason ? { reason } : {}),
                ...(hint ? { hint } : {}),
                ...(warning ? { warning } : {}),
              }}
              onSelect={() => void onCreate(kind, machine.id)}
            />
          )
        })}
        {runtimeDriversEnabled ? (
          <HeadlessDriverItems machine={machine} onCreate={onCreate} />
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
