import { relativeTime } from '@podium/client-core/focus'
import type { RecentFileEntry, RepoView, WorktreeView } from '@podium/client-core/values'
import { LOADING } from '@podium/client-graph'
import {
  type AgentKind,
  agentCapabilityRejection,
  agentLoginCondition,
  agentProbeTimeoutDescription,
  asMachineId,
  type IssueId,
  type MachineId,
  type MachineWire,
  machinePathBasename,
  machinePathsEqual,
  machinesForRepoOrClone,
  onlineMachinesForRepoOrClone,
  type SessionId,
} from '@podium/model/browser'
import { Circle, LayoutGrid, SquarePlus, SquareTerminal } from 'lucide-react'
import { observer } from 'mobx-react-lite'
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
  ARTIFACTS_TAB_ARTIFACT_ID,
  useArtifactCount,
  useOpenArtifactsTab,
} from '@/features/files/artifacts-tab'
import { FileTypeIcon } from '@/features/files/file-icon'
import {
  agentLabel,
  CapabilityAgentItem,
  capabilityHint,
  capabilityReason,
  loginWarning,
} from '@/lib/agent-capability'
import { agentIconFor } from '@/lib/agent-tone'
import { useResolvedDescriptors } from '@/lib/harness-descriptors'
import type { issueAgentDescriptors } from '@/lib/issue-agents'
import { MENU_HEADER, MENU_HEADER_REF, MENU_HINT, MENU_SECTION } from '@/lib/menu-surface'
import { headlessRuntimeDrivers, runtimeDriverLabel } from '@/lib/runtime-driver-options'
import { useFeature } from '@/lib/use-feature'
import {
  useCommandLaunchActions,
  useCommandLaunchOrigin,
  useCommandRecentFiles,
  useCommandTargetMachines,
} from './command-launch-data'

type IconComponent = React.ComponentType<Record<string, unknown>>

/**
 * Menu rows per harness, read off descriptors (POD-4475): `New ${shortLabel}`
 * with the bundled mark for harnesses this build knows and the served icon
 * DATA for newer ones. The workspace "+" (new tab) menu lists every agent
 * kind, including 'New Shell' — shells are spawnable kinds, not harnesses,
 * so the shell row stays static (SP-75b1 had excluded shells from this menu;
 * we deliberately keep them here). Each row is still capability-gated below;
 * a shell is always allowed on an online machine.
 */
function menuAgentsFor(
  descriptors: ReturnType<typeof issueAgentDescriptors>,
): { kind: AgentKind; label: string; Icon: IconComponent }[] {
  const rows = descriptors
    .filter((d) => d.kind !== 'shell')
    .map((d) => ({
      kind: d.kind as AgentKind,
      label: `New ${d.shortLabel}`,
      Icon: (agentIconFor(d.kind, descriptors) ?? SquareTerminal) as IconComponent,
    }))
  const shellIcon = (agentIconFor('shell') ?? SquareTerminal) as IconComponent
  return [...rows, { kind: 'shell' as AgentKind, label: 'New Shell', Icon: shellIcon }]
}

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

export function NewPanelMenu(
  props: Omit<Parameters<typeof NewPanelMenuBody>[0], 'data'>,
): JSX.Element {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = props.open ?? internalOpen
  const setOpen = (next: boolean) => {
    if (props.open === undefined) setInternalOpen(next)
    props.onOpenChange?.(next)
  }
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          props.trigger ?? (
            <Button variant="ghost" size="icon" aria-label="New panel">
              <SquarePlus size={16} />
            </Button>
          )
        }
      />
      {open && <NewPanelChoices {...props} />}
    </DropdownMenu>
  )
}

/** Closed tab-strip menus own only a trigger. Acquiring their launch projection
 * would build repository usage and session choices on every issue selection. */
function NewPanelChoices(props: Omit<Parameters<typeof NewPanelMenuBody>[0], 'data'>): JSX.Element {
  const data = useCommandLaunchOrigin(props.worktree.path, props.worktree.machineId)
  if (!data || data === LOADING)
    return (
      <DropdownMenuContent align="end">
        <span className="px-2 py-1 text-muted-foreground">Loading launch choices…</span>
      </DropdownMenuContent>
    )
  return <NewPanelMenuBody {...props} data={data} />
}

const NewPanelMenuBody = observer(function NewPanelMenuBody({
  data,
  worktree,
  onOpened,
  issueId,
}: {
  data: Exclude<ReturnType<typeof useCommandLaunchOrigin>, typeof LOADING | undefined>
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
  const { machines } = data
  const { launchSession, setPanelMode } = useCommandLaunchActions()
  const runtimeDriversEnabled = useFeature('runtime-drivers')

  // Resolve the repo view for the current worktree (cross-machine merged view).
  const repoView = ((): RepoView => {
    const found = data.repo
    if (found) return found
    // Fallback: synthesize a minimal single-machine RepoView so the logic below
    // never has to branch on undefined.
    return {
      path: worktree.repoPath,
      name: machinePathBasename(worktree.repoPath) || worktree.repoPath,
      worktrees: [worktree],
      machines: worktree.machineId ? [{ machineId: worktree.machineId, path: worktree.path }] : [],
    }
  })()

  // The recommended machine is agent-specific: a host with the repo but without
  // this harness (or its login) must never receive an optimistic spawn.
  function targetFor(agentKind: AgentKind): string | undefined {
    return targetMachines[agentKind]
  }

  /** Local path to use when opening an agent on machine M. */
  function cwdFor(machineId: MachineId | undefined): string {
    if (!machineId || machineId === (worktree.machineId ?? data.sourceMachineId))
      return worktree.path
    return repoView.machines.find((m) => m.machineId === machineId)?.path ?? worktree.path
  }

  // Menu rows read the descriptors of every machine in scope (POD-4475):
  // the single target when there is one, all repo machines otherwise, so a
  // newer harness appears without a client change. No machine (yet) renders
  // the bundled copy. The headed-create panel intent below reads the same
  // list (POD-4541), so no harness name lives in this client.
  const descriptors = useResolvedDescriptors([
    worktree.machineId,
    ...repoView.machines.map((m) => m.machineId),
  ])

  function create(agentKind: AgentKind, machineId?: MachineId, requestedDriverId?: string) {
    const cwd = cwdFor(machineId)
    // A concrete driver id is an explicit per-session selection (the
    // experimental driver row passes its id); absent is the manifest's headed
    // terminal default, which the daemon binds unconditionally (POD-4426). The
    // old `true` spelling named that default explicitly and is gone.
    //
    // A `session.launch` effect record (POD-6523): the session id is minted
    // here and the starting session paints from the record at once, also while
    // the machine is offline, so its panel opens without a round trip.
    const { sessionId } = launchSession({
      agentKind,
      target: {
        path: cwd,
        repoPath: repoView.path,
        ...(worktree.repoId ? { repoId: worktree.repoId } : {}),
        ...(machineId ? { machineId } : {}),
      },
      ...(issueId ? { issueId } : {}),
      ...(requestedDriverId !== undefined ? { requestedDriverId } : {}),
    })
    // Server-family sessions derive Chat before startScreen/device preferences.
    // Materialize a headed row's descriptor-stated native intent before exposing
    // the new tab, matching the established blank-launch ordering in
    // ColdStartComposer. The explicit experimental driver row intentionally
    // receives no override and stays chat-first. Unknown/missing renders as
    // today (no override).
    const headedPanelMode = descriptors.find((d) => d.kind === agentKind)?.defaults?.panelMode
    if (headedPanelMode === 'native' && requestedDriverId === undefined)
      setPanelMode(sessionId, 'native')
    onOpened(sessionId)
  }

  const header = (
    // The shared menu header (POD-380) — the
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

  const menuAgents = useMemo(() => menuAgentsFor(descriptors), [descriptors])
  const targetMachines = useCommandTargetMachines(
    repoView,
    machines,
    menuAgents.map((agent) => agent.kind),
  )

  // Single-machine (or no machines yet): no Machines region to choose between.
  if (machines.length <= 1) {
    const machine = machines[0]
    return (
      <DropdownMenuContent align="end" className="flex w-[248px] max-w-[calc(100vw-24px)] flex-col">
        {header}
        {menuAgents.map(({ kind, label, Icon }) => {
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
              onSelect={() => create(kind, machine?.id)}
            />
          )
        })}
        {runtimeDriversEnabled && machine ? (
          <HeadlessDriverItems machine={machine} onCreate={create} agents={menuAgents} />
        ) : null}
        {issueId ? <ArtifactsItem issueId={issueId} worktree={worktree} /> : null}
        <RecentFilesSection worktree={worktree} {...(issueId ? { issueId } : {})} />
      </DropdownMenuContent>
    )
  }

  // Multi-machine path.
  const repoMachines = machinesForRepoOrClone(repoView, machines)
  const eligible = onlineMachinesForRepoOrClone(repoView, machines)
  const eligibleIds = new Set(eligible.map((m) => m.id))

  return (
    <DropdownMenuContent align="end" className="flex w-[248px] max-w-[calc(100vw-24px)] flex-col">
      {header}

      {/* 1. Agent options — open on the resolved target machine */}
      {menuAgents.map(({ kind, label, Icon }) => {
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
            onSelect={() => create(kind, target === undefined ? undefined : asMachineId(target))}
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
              agents={menuAgents}
            />
          )
        })}
      </TooltipProvider>

      {issueId ? <ArtifactsItem issueId={issueId} worktree={worktree} /> : null}
      <RecentFilesSection worktree={worktree} {...(issueId ? { issueId } : {})} />
    </DropdownMenuContent>
  )
})

/** What the header's subject line says: the branch a worktree is on, or the repo
 *  name when this is the main checkout (where "main" would name the branch and
 *  not the place). */
function worktreeLabel(worktree: WorktreeView, repoView: RepoView): string {
  if (!worktree.isMain && worktree.branch) return worktree.branch
  return repoView.name || machinePathBasename(worktree.repoPath) || worktree.repoPath
}

/** "Artifacts" for the current task (POD-2078): opens the stage's Artifacts tab,
 *  the same one the task panel's "View all" opens. Not a new panel of work, so
 *  it sits apart from the agents, above the files it lists. */
function ArtifactsItem({
  issueId,
  worktree,
}: {
  issueId: IssueId
  worktree: WorktreeView
}): JSX.Element {
  const openArtifactsTab = useOpenArtifactsTab()
  const count = useArtifactCount(issueId)
  return (
    <>
      <div className={MENU_SECTION}>THIS TASK</div>
      <DropdownMenuItem
        data-testid="new-panel-artifacts"
        onClick={() => openArtifactsTab(issueId, worktree.path)}
      >
        <LayoutGrid className={`${MENU_GLYPH} text-text-dim`} aria-hidden="true" />
        <span className="min-w-0 flex-1">Artifacts</span>
        {count > 0 && <span className={`${MENU_HINT} tabular-nums`}>{count}</span>}
      </DropdownMenuItem>
    </>
  )
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
  const recentFiles = useCommandRecentFiles()
  const { openFileInWorktree, openArtifact } = useCommandLaunchActions()
  const now = Date.now()
  // The Artifacts index is a view, not a file — it has its own row above.
  const entries = recentFiles
    .filter(
      (f) =>
        f.artifact?.artifactId !== ARTIFACTS_TAB_ARTIFACT_ID &&
        machinePathsEqual(f.worktreePath, worktree.path),
    )
    .slice(0, RECENT_LIMIT)
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
          <FileTypeIcon name={f.path} size={14} />
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {machinePathBasename(f.path) || f.path}
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
  agents,
}: {
  machine: MachineWire
  onCreate: (kind: AgentKind, machineId: MachineId, requestedDriverId?: string) => void
  agents: { kind: AgentKind; label: string; Icon: IconComponent }[]
}): JSX.Element | null {
  const drivers = headlessRuntimeDrivers(machine)
  if (drivers.length === 0) return null
  return (
    <>
      <div className={MENU_SECTION}>HEADLESS DRIVERS</div>
      {drivers.map((driver) => {
        const agent = agents.find((candidate) => candidate.kind === driver.harness)
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
            onSelect={() => onCreate(driver.harness, machine.id, driver.id)}
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
  agents,
}: {
  machine: MachineWire
  onCreate: (kind: AgentKind, machineId: MachineId, requestedDriverId?: string) => void
  runtimeDriversEnabled: boolean
  agents: { kind: AgentKind; label: string; Icon: IconComponent }[]
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
        {agents.map(({ kind, label, Icon }) => {
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
              onSelect={() => onCreate(kind, machine.id)}
            />
          )
        })}
        {runtimeDriversEnabled ? (
          <HeadlessDriverItems machine={machine} onCreate={onCreate} agents={agents} />
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
