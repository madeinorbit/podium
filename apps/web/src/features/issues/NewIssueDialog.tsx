import { shallowEqual } from '@podium/client-core/store'
import { type RepoView, reposToViews, repoUsageAt } from '@podium/client-core/viewmodels'
import {
  agentCapabilityRejection,
  agentLoginCondition,
  ISSUE_STAGES,
  type IssueStage,
  type MachineWire,
  machinesForRepoOrClone,
  onlineMachinesForRepoOrClone,
  resolveTargetMachineForAgent,
} from '@podium/model/browser'
import { resolveRole } from '@podium/runtime'
import { ArrowRight, ChevronDown, ChevronRight, FolderGit2, Server, X, Zap } from 'lucide-react'
import type { ComponentProps, JSX, ReactNode } from 'react'
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  agentFleetStatus,
  CapabilityAgentItem,
  candidateFromAvailability,
  capabilityHint,
  capabilityReason,
  SIGNED_OUT_HINT,
} from '@/lib/agent-capability'
import { AUTO } from '@/lib/agent-models'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import {
  issueAgentIcon,
  issueAgentLabel,
  issueAgentOptions,
  issueDefaultAgentKind,
} from '@/lib/issue-agents'
import { EffortPicker, ModelPicker } from '@/lib/ModelEffortPicker'
import { MENU_HEADER, MENU_HEADER_REF, MENU_HINT, MENU_RULE } from '@/lib/menu-surface'
import { PropertyMenu, type PropertyOption } from '@/lib/PropertyMenu'
import { cn } from '@/lib/utils'
import { STAGE_LABELS } from './issue-card'
import { PriorityGlyph, StageGlyph } from './issue-glyphs'

/**
 * THE COMPOSER READS WHERE · WHAT · HOW (POD-1285).
 *
 * It used to be one flat wrap of nine pills — repo, branch, stage, priority,
 * type, labels, assignee, agent, model, effort — over a `<details>` block whose
 * only content was a Linear search. Everything a task needs before it exists sat
 * at the same weight as everything you would rather set on it afterwards, and
 * the repo (which decides what every other control even means) was a pill in the
 * middle of the row.
 *
 * The redesign splits the card into three zones, in the order the decisions are
 * actually made:
 *
 *   WHERE  the header — repo, then stage. Both scope the task; neither is a
 *          property OF it.
 *   WHAT   the body — title, description, priority. The task itself.
 *   HOW    the start-work band — agent · model · effort, and the machine. None of
 *          it means anything until work starts, so it lives UNDER `Start work
 *          now` and collapses to one line when that is off.
 *
 * Type, labels, assignee, branch and Linear linking left the composer entirely:
 * they are set on the issue after it exists, and the server already falls back
 * to `repo.branch || settings.gitWorkflow.defaultParentBranch || 'main'` for the
 * parent branch.
 */

/** The repo basename, falling back to the full path — repos are shown by name. */
function repoLabel(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/**
 * The composer's pill: a `PropertyMenu` trigger sized as a CONTROL.
 *
 * It was `rounded-full` — the shape this app gives a tag, i.e. a thing you read.
 * Every one of these opens a menu, so they are squared off to the 7px radius the
 * rest of the shell's controls wear, at the 26px height the runs-on band's
 * instrument group is built on. Forwards ref + injected props so Base UI's
 * `render={…}` wires the open handler onto the button.
 */
const PillButton = forwardRef<
  HTMLButtonElement,
  ComponentProps<typeof Button> & { icon?: ReactNode; label: string; chevron?: boolean }
>(({ icon, label, chevron = true, className, children, ...props }, ref) => (
  <Button
    ref={ref}
    type="button"
    variant="outline"
    size="sm"
    className={cn('h-[26px] gap-[7px] rounded-[7px] px-[9px] text-[12px] font-normal', className)}
    {...props}
  >
    {icon}
    {label}
    {children}
    {chevron && <ChevronDown size={14} aria-hidden="true" className="text-text-faint" />}
  </Button>
))
PillButton.displayName = 'PillButton'

/**
 * WHO CAN HOST THIS TASK.
 *
 * The options are the machines that carry this repo or a clone of it, and the
 * eligible set is the online half of that — `machinesForRepoOrClone` /
 * `onlineMachinesForRepoOrClone`, the same pair `NewPanelMenu` uses, so the two
 * overlays never disagree about who can run something.
 *
 * A host that refuses the agent stays LISTED and disabled with its reason on the
 * row (`capabilityHint`), never silently dropped: a machine missing from a list
 * reads as a machine you do not have. A host that is merely signed out is a
 * different answer and gets a different one — `agentLoginCondition` is a
 * WARNING, not a refusal, here exactly as in the "+" menu: the session opens and
 * you log in in the pane, so disabling the row would refuse a start that works.
 */
function MachineMenu({
  trigger,
  machines,
  agentKind,
  agentName,
  autoMachine,
  value,
  onSelect,
}: {
  trigger: ReactNode
  machines: MachineWire[]
  agentKind: string
  agentName: string
  autoMachine: MachineWire | undefined
  /** `''` = Auto. */
  value: string
  onSelect: (machineId: string) => void
}): JSX.Element {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={trigger as JSX.Element} />
      <DropdownMenuContent align="start" className="w-[264px]">
        <div className={MENU_HEADER}>
          <span>MACHINE</span>
          <span className={MENU_HEADER_REF}>has podium</span>
        </div>
        <DropdownMenuItem
          className={value ? undefined : 'bg-hairline-soft text-text-strong'}
          onClick={() => onSelect('')}
        >
          <Zap className="size-3.5 flex-none text-text-dim" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">Auto</span>
          <span className={MENU_HINT}>{autoMachine?.name ?? 'no host'}</span>
        </DropdownMenuItem>
        {/* Auto names its pick above; this says what the pick is FOR. It is
            agent-specific, so it re-reads whenever the agent changes. */}
        <p className="px-[5px] pt-[3px] pb-[6px] font-mono text-[10.5px] leading-[1.45] text-text-faint">
          picks an online host that can run {agentName}
        </p>
        <hr className={MENU_RULE} />
        {machines.map((machine) => {
          const rejection = agentCapabilityRejection(machine, agentKind)
          const reason = capabilityReason(machine.name, agentName, rejection)
          const loggedOut = agentLoginCondition(machine, agentKind) === 'logged-out'
          // The right column is the machine's hardware OR its refusal, never
          // both: a row that reads "darwin arm64 · offline" invites you to click
          // the half that is still true.
          const hint =
            capabilityHint(rejection) ??
            (loggedOut
              ? SIGNED_OUT_HINT
              : machine.inventory
                ? `${machine.inventory.os} ${machine.inventory.arch}`
                : '')
          return (
            <DropdownMenuItem
              key={machine.id}
              disabled={rejection !== undefined}
              title={reason ?? undefined}
              className={cn(machine.id === value && 'bg-hairline-soft text-text-strong')}
              onClick={() => onSelect(machine.id)}
            >
              <span
                className={cn(
                  'mx-[4px] size-1.5 flex-none rounded-full',
                  machine.online ? 'bg-success-solid' : 'ring-1 ring-text-faint ring-inset',
                )}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{machine.name}</span>
              {hint && <span className={MENU_HINT}>{hint}</span>}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The harness picker uses the same fleet status and refusal rows as every
 * other spawn surface. A harness stays visible when unavailable, with the
 * reason on the row, and is accepted when any candidate host can run it. */
function AgentMenu({
  trigger,
  options,
  selectedValue,
  onSelect,
}: {
  trigger: ReactNode
  options: Array<PropertyOption & { status: ReturnType<typeof agentFleetStatus> }>
  selectedValue: string
  onSelect: (value: string) => void
}): JSX.Element {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={trigger as JSX.Element} />
      <DropdownMenuContent align="start" className="w-56">
        {options.map((option) => (
          <CapabilityAgentItem
            key={option.value}
            icon={option.icon}
            label={option.label}
            status={option.status}
            selected={option.value === selectedValue}
            onSelect={() => onSelect(option.value)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function NewIssueDialog({
  onClose,
  initialStage,
}: {
  onClose: () => void
  /** Lane the composer was opened from. Presets the Stage pill; creation itself is
   *  always Backlog server-side, so a non-backlog stage is applied as a post-create
   *  patch. */
  initialStage?: IssueStage
}): JSX.Element {
  const { trpc, repos, sessions, machines } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      repos: s.repos,
      sessions: s.sessions ?? [],
      machines: s.machines ?? [],
    }),
    shallowEqual,
  )
  const isMobile = useIsMobile()
  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [stage, setStage] = useState<IssueStage>(initialStage ?? 'backlog')
  const [priority, setPriority] = useState(2)
  // Default repo = the most recently used one (mount-time snapshot).
  const [repoPath, setRepoPath] = useState(() => {
    const choices = repos.filter((r) => r.kind !== 'worktree')
    const mru = [...choices].sort((a, b) => repoUsageAt(b, sessions) - repoUsageAt(a, sessions))[0]
    return mru?.path ?? repos[0]?.path ?? ''
  })
  const [defaultAgent, setDefaultAgent] = useState('claude-code')
  // '' = use the configured default agent (no flag).
  const [agent, setAgent] = useState('')
  // 'auto' = inherit the settings default model/effort (no per-issue override).
  const [model, setModel] = useState(AUTO)
  const [effort, setEffort] = useState(AUTO)
  // '' = Auto, i.e. let the server resolve a host at spawn time.
  const [machineChoice, setMachineChoice] = useState('')
  const [startNow, setStartNow] = useState(true)
  const [createMore, setCreateMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    trpc.settings.get
      .query()
      .then((settings) => {
        if (cancelled) return
        setDefaultAgent(resolveRole(settings, 'coding').harness)
      })
      .catch(() => {
        // Best-effort: creation still works with the server defaults.
      })
    return () => {
      cancelled = true
    }
  }, [trpc])

  // Most-recently-used repos first — matches the sidebar's New-agent menu.
  const repoChoices = repos
    .filter((r) => r.kind !== 'worktree')
    .sort(
      (a, b) =>
        repoUsageAt(b, sessions) - repoUsageAt(a, sessions) ||
        repoLabel(a.path).localeCompare(repoLabel(b.path), undefined, { sensitivity: 'base' }),
    )
  const repoOptions: PropertyOption[] = repoChoices.map((r) => ({
    value: r.path,
    label: repoLabel(r.path),
    icon: <FolderGit2 size={13} aria-hidden="true" className="text-muted-foreground" />,
  }))
  const stageOptions: PropertyOption[] = ISSUE_STAGES.map((s) => ({
    value: s,
    label: STAGE_LABELS[s],
    icon: <StageGlyph stage={s} />,
  }))
  const priorityOptions: PropertyOption[] = [0, 1, 2, 3, 4].map((p) => ({
    value: String(p),
    label: `P${p}`,
    icon: <PriorityGlyph priority={p} />,
  }))
  // Model + effort are scoped to the effective agent; changing agent resets both
  // (a model/effort valid for one CLI is usually meaningless for another).
  const agentKind = issueDefaultAgentKind(agent || defaultAgent)
  const agentName = issueAgentLabel(agent || defaultAgent)
  const selectAgent = (value: string) => {
    setAgent(value)
    setModel(AUTO)
    setEffort(AUTO)
  }

  // The cross-machine view of the selected repo. `machinesForRepoOrClone` reads
  // `machines` + `originUrl` off it, so a repo the replica has not merged into a
  // view yet simply offers no hosts rather than offering all of them.
  const repoView = useMemo(
    (): RepoView | undefined => reposToViews(repos).find((r) => r.path === repoPath),
    [repos, repoPath],
  )
  const repoMachines = repoView ? machinesForRepoOrClone(repoView, machines) : []
  const agentOptions = issueAgentOptions(defaultAgent).map((option) => {
    const kind = issueDefaultAgentKind(option.value || defaultAgent)
    const label = issueAgentLabel(kind)
    const candidates = repoMachines.map((machine) =>
      candidateFromAvailability(
        machine,
        machine.use === 'denied' ? 'unauthorized' : machine.online ? 'available' : 'unreachable',
        kind,
      ),
    )
    return {
      ...option,
      // Selection already identifies the default; repeating "default" in the
      // label adds no information and makes the control read like a setting.
      label,
      status: repoMachines.length > 0 ? agentFleetStatus(candidates, label) : {},
    }
  })
  const eligibleIds = new Set(
    (repoView ? onlineMachinesForRepoOrClone(repoView, machines) : [])
      .filter((m) => agentCapabilityRejection(m, agentKind) === undefined)
      .map((m) => m.id),
  )
  const autoMachine = useMemo(() => {
    if (!repoView) return undefined
    const resolved = resolveTargetMachineForAgent(repoView, sessions, machines, agentKind)
    return machines.find((m) => m.id === resolved)
  }, [repoView, sessions, machines, agentKind])
  const pinnedMachine = machineChoice ? repoMachines.find((m) => m.id === machineChoice) : undefined
  // A host pinned while it was up can go down before you press Create. The pin is
  // not silently honoured and not silently dropped either: the pill says so, and
  // the create falls back to Auto.
  const pinnedUnavailable =
    pinnedMachine !== undefined && !eligibleIds.has(pinnedMachine.id) ? pinnedMachine : undefined
  const effectiveMachine = pinnedUnavailable ? undefined : pinnedMachine
  const canSubmit = Boolean(title.trim()) && Boolean(repoPath) && !busy

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError('')
    try {
      const created = await trpc.issues.create.mutate({
        repoPath,
        title: title.trim(),
        description: description.trim() || undefined,
        startNow,
        // The runs-on band is the ONLY place these are chosen, and it is folded
        // away when the task is not starting — so a deferred ticket carries no
        // agent, model, effort or host, exactly as the collapsed band says.
        ...(startNow
          ? {
              ...(agent ? { defaultAgent: agent } : {}),
              ...(model !== AUTO ? { defaultModel: model } : {}),
              ...(effort !== AUTO ? { defaultEffort: effort } : {}),
              ...(effectiveMachine ? { machineId: effectiveMachine.id } : {}),
            }
          : {}),
        // Omit fields at their defaults so a bare issue stays bare.
        ...(priority !== 2 ? { priority } : {}),
      })
      // `create` always lands in Backlog, so honor the chosen stage with a follow-up
      // patch. Backlog is the default — no patch needed.
      if (stage !== 'backlog') {
        await trpc.issues.update.mutate({ id: created.id, patch: { stage } })
      }
      if (createMore) {
        // Keep the chosen properties; clear only the per-issue text and refocus.
        setTitle('')
        setDescription('')
        setBusy(false)
        titleRef.current?.focus()
      } else {
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const machinePill = (
    <PillButton
      aria-label="Machine"
      icon={
        <Server
          size={15}
          aria-hidden="true"
          className={pinnedUnavailable ? 'text-warning' : 'text-text-dim'}
        />
      }
      label={pinnedMachine?.name ?? 'Auto'}
      className={cn(
        'font-normal',
        pinnedUnavailable && 'border-warning/40 text-warning hover:text-warning',
      )}
    >
      {pinnedUnavailable ? (
        <span className="font-mono text-[11px] text-warning/80">
          {capabilityHint(agentCapabilityRejection(pinnedUnavailable, agentKind)) ?? 'unavailable'}{' '}
          · pick another host
        </span>
      ) : pinnedMachine ? null : (
        <span className="flex items-center gap-[5px] font-mono text-[11px] text-text-dim">
          <span aria-hidden="true" className="text-text-faint">
            ·
          </span>
          {autoMachine ? (
            <>
              <span className="size-[5px] rounded-full bg-success-solid" aria-hidden="true" />
              {autoMachine.name}
            </>
          ) : (
            'no host'
          )}
        </span>
      )}
    </PillButton>
  )

  return (
    <Dialog
      open
      modal={isMobile ? 'trap-focus' : true}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-[660px] flex-col gap-0 overflow-hidden rounded-[14px] bg-bar p-0 sm:max-w-[660px]"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            void submit()
            return
          }
          // ⌥S toggles the band. `code` rather than `key`: Alt+S emits 'ß' on a
          // mac layout, which is not a letter this app could match on.
          if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyS') {
            e.preventDefault()
            setStartNow((on) => !on)
          }
        }}
      >
        {/* ── WHERE ───────────────────────────────────────────────────────── */}
        <div className="flex h-[46px] flex-none items-center gap-2 border-b border-hairline-soft px-4">
          <DialogTitle className="sr-only">New Task</DialogTitle>
          <PropertyMenu
            trigger={
              <PillButton
                icon={<FolderGit2 size={13} aria-hidden="true" />}
                label={repoLabel(repoPath) || 'Repo'}
              />
            }
            options={repoOptions}
            selectedValue={repoPath}
            placeholder="Select a repo…"
            onSelect={(v) => {
              setRepoPath(v)
              // Hosts are scoped to the repo — a pin from the previous one may
              // not even carry this checkout.
              setMachineChoice('')
            }}
          />
          <ChevronRight size={16} aria-hidden="true" className="text-text-faint" />
          <PropertyMenu
            trigger={<PillButton icon={<StageGlyph stage={stage} />} label={STAGE_LABELS[stage]} />}
            options={stageOptions}
            selectedValue={stage}
            onSelect={(v) => setStage(v as IssueStage)}
          />
          <span className="ml-auto font-mono text-[10px] text-text-faint">esc</span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </Button>
        </div>

        {/* ── WHAT ────────────────────────────────────────────────────────── */}
        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[18px] pt-5 pb-4">
          <Input
            // The caret starts in the title (the design's blinking cursor). It is
            // also what keeps the dialog's initial focus INSIDE the body: with the
            // header pill first in the DOM, Base UI's focus trap opened on the repo
            // trigger, and the trap then fought that menu's own type-ahead field for
            // focus — the menu opened and closed itself on the next tick.
            autoFocus
            ref={titleRef}
            aria-label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            className="h-auto border-none bg-transparent px-0 py-0 font-medium text-[17px] tracking-[-0.015em] shadow-none focus-visible:ring-0 dark:bg-transparent"
          />

          <Textarea
            aria-label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add description…"
            className="min-h-[104px] resize-none border-none bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />

          <div className="flex items-center gap-[7px]">
            <PropertyMenu
              trigger={
                <PillButton
                  icon={<PriorityGlyph priority={priority} />}
                  label={`P${String(priority)}`}
                  chevron={false}
                />
              }
              options={priorityOptions}
              selectedValue={String(priority)}
              onSelect={(v) => setPriority(Number(v))}
            />
          </div>

          {error && <p className="text-[12px] text-destructive">{error}</p>}
        </div>

        {/* ── HOW ─────────────────────────────────────────────────────────── */}
        <div className="flex-none border-t border-hairline-soft bg-engraved px-[18px] py-3">
          <div className="flex items-center gap-[9px]">
            <Label className="cursor-pointer gap-[9px] font-medium text-[12.5px] text-text-strong">
              <Checkbox checked={startNow} onCheckedChange={(c) => setStartNow(c === true)} />
              Start work now
            </Label>
            {!startNow && (
              <span className="font-mono text-[11px] text-text-faint">
                off — agent, model and machine are chosen when you start it
              </span>
            )}
            <span
              className="ml-auto font-mono text-[10px] text-text-faint"
              role="img"
              aria-label="Alt S"
            >
              ⌥S
            </span>
          </div>

          {startNow && (
            <div className="mt-[11px] flex flex-wrap items-center gap-[7px]">
              {/* One instrument, three readings — the group the cold-deck
                  composer already wears. The dividers ride the model and effort
                  segments' own left border so a harness with no effort ladder
                  (EffortPicker renders nothing) cannot leave a hanging rule. */}
              <div className="inline-flex h-[26px] max-w-full flex-none items-stretch overflow-hidden rounded-[7px] bg-[var(--well-floor)] shadow-[inset_0_0_0_1px_var(--hairline-bar)]">
                <AgentMenu
                  trigger={
                    <button
                      type="button"
                      data-pressable
                      aria-label="Agent"
                      className="inline-flex h-[26px] items-center gap-1.5 px-2.5 text-[12px] leading-none font-medium text-text-strong hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {issueAgentIcon(agent || defaultAgent, 12)}
                      {agentName}
                    </button>
                  }
                  options={agentOptions}
                  selectedValue={agent}
                  onSelect={selectAgent}
                />
                <ModelPicker
                  variant="composer"
                  className="h-[26px] border-l border-hairline-bar"
                  agentKind={agentKind}
                  value={model}
                  onChange={(m) => {
                    // Effort is per-model — reset it whenever the model changes.
                    setModel(m)
                    setEffort(AUTO)
                  }}
                />
                <EffortPicker
                  variant="composer"
                  className="h-[26px] border-l border-hairline-bar"
                  agentKind={agentKind}
                  model={model}
                  value={effort}
                  onChange={setEffort}
                />
              </div>
              <MachineMenu
                trigger={machinePill}
                machines={repoMachines}
                agentKind={agentKind}
                agentName={agentName}
                autoMachine={autoMachine}
                value={machineChoice}
                onSelect={setMachineChoice}
              />
            </div>
          )}
        </div>

        {/* ── COMMIT ──────────────────────────────────────────────────────── */}
        <div className="flex h-[56px] flex-none items-center gap-3 border-t border-hairline-soft px-4">
          <Label className="cursor-pointer gap-2 font-normal text-[12.5px] text-muted-foreground">
            <Switch checked={createMore} onCheckedChange={(c) => setCreateMore(c === true)} />
            Create more
          </Label>
          <span
            className="ml-auto font-mono text-[10.5px] text-text-faint"
            role="img"
            aria-label="Command Enter"
          >
            ⌘↵
          </span>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            pending={busy}
            pendingLabel="Creating task…"
            onClick={() => void submit()}
          >
            Create
            <ArrowRight size={15} aria-hidden="true" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
