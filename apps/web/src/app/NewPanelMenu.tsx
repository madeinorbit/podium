import { relativeTime } from '@podium/client-core/focus'
import { shallowEqual } from '@podium/client-core/store'
import type { RecentFileEntry, RepoView, WorktreeView } from '@podium/client-core/viewmodels'
import { reposToViews } from '@podium/client-core/viewmodels'
import {
  type AgentKind,
  agentCapabilityRejection,
  agentLoginCondition,
  asMachineId,
  type IssueId,
  type MachineId,
  type MachineWire,
  machinesForRepoOrClone,
  onlineMachinesForRepoOrClone,
  resolveTargetMachineForAgent,
  type SessionId,
} from '@podium/model/browser'
import { Circle, FileText, RotateCcw, Search, SquarePlus } from 'lucide-react'
import type React from 'react'
import { type JSX, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { AGENT_KIND_ICON } from '@/lib/agent-tone'
import {
  MENU_DROPDOWN_ITEM,
  MENU_DROPDOWN_PANEL,
  MENU_EMPTY,
  MENU_HEADER,
  MENU_HEADER_REF,
  MENU_HINT,
  MENU_SECTION,
} from '@/lib/menu-surface'
import { type ConversationHit, useConversationSearch } from '@/lib/useConversationSearch'
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

const MINI_LIMIT = 8
// Fewer hits shown inside each machine's submenu to keep it compact.
const SUB_HIT_LIMIT = 4
// Recent files shown in the menu (POD-149) — reachability, not a file browser.
const RECENT_LIMIT = 6

/** Every glyph in the panel is 14px on one text column, so agent marks, file
 *  glyphs and the resume arrow leave their labels at the same x — the stock
 *  dropdown's `[&_svg]:size-4` only yields to a class carrying `size-`, which is
 *  why this is a class and not a `size={14}` prop. */
const MENU_GLYPH = 'size-3.5 flex-none'

/** A machine's status dot is a reading, not an icon, so it keeps the 6px the
 *  sidebar and the new-agent menu draw it at — but it is indented into the same
 *  14px column, so the names still line up with the labels above them. */
const MACHINE_DOT = 'mx-[4px] size-1.5 flex-none'

/**
 * The "+" menu: start a fresh agent/shell, or resume from history. The resume
 * list is the mini search — server-indexed, capped, recency-first, with a
 * filter box — instead of dumping every discovered conversation.
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
 * because two overlays a pixel apart must read as one family. Everything visual
 * below is that preset — panel, rules, rows, hints — through the Base-UI bridge.
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
  const { trpc, repos, sessions, machines } = useStoreSelector(
    (s) => ({ trpc: s.trpc, repos: s.repos, sessions: s.sessions, machines: s.machines }),
    shallowEqual,
  )
  const [filter, setFilter] = useState('')
  // Uncontrolled fallback so the desktop/mobile "+" still works without a parent
  // driving its open state; the controlled props win when supplied.
  const [internalOpen, setInternalOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next)
    onOpenChange?.(next)
  }
  // Focus the "Search history…" field the moment the menu opens so the user can
  // filter resumable conversations immediately (the input stops key propagation
  // so Base UI's typeahead won't steal the keystrokes).
  const searchRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (!open) return
    // Wait for the portalled content to mount before focusing.
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])
  const now = Date.now()
  // Main worktree searches the whole repo subtree so repo-level conversations
  // that matched no specific worktree are not lost; others stay exact.
  const scope = worktree.isMain ? worktree.repoPath : worktree.path

  // Worktrees commonly nest under the repo (e.g. .claude/worktrees/*), so a
  // subtree search from the main checkout would pull in every sibling worktree's
  // conversations and crowd out the repo's own. Exclude paths that belong to
  // another worktree of this repo.
  const siblingWorktreePaths = useMemo(() => {
    if (!worktree.isMain) return []
    const repo = reposToViews(repos).find((r) => r.path === worktree.repoPath)
    return (repo?.worktrees ?? [])
      .filter((w) => !w.isMain && w.path !== worktree.path)
      .map((w) => w.path)
  }, [repos, worktree.isMain, worktree.repoPath, worktree.path])

  // Over-fetch a little so the sibling filter still leaves a full list.
  const { hits: raw } = useConversationSearch({
    query: filter,
    projectPath: scope,
    limit: siblingWorktreePaths.length > 0 ? MINI_LIMIT * 3 : MINI_LIMIT,
    debounceMs: 150,
  })
  const hits = raw
    .filter((h) => h.resumeValue)
    .filter(
      (h) =>
        !siblingWorktreePaths.some(
          (p) => h.projectPath === p || h.projectPath?.startsWith(`${p}/`),
        ),
    )
    .slice(0, MINI_LIMIT)

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

  async function create(agentKind: AgentKind, machineId?: MachineId) {
    const cwd = cwdFor(machineId)
    const { sessionId } = await trpc.sessions.create.mutate({
      agentKind,
      cwd,
      ...(machineId ? { machineId } : {}),
      ...(issueId ? { issueId } : {}),
    })
    onOpened(sessionId)
  }

  async function resume(hit: ConversationHit) {
    if (!hit.resumeKind || !hit.resumeValue) return
    const { sessionId } = await trpc.sessions.resume.mutate({
      agentKind: hit.agentKind as AgentKind,
      cwd: hit.projectPath ?? worktree.path,
      resume: { kind: hit.resumeKind, value: hit.resumeValue },
      conversationId: hit.id,
      ...(hit.name || hit.title ? { title: hit.name ?? hit.title } : {}),
      ...(hit.machineId ? { machineId: hit.machineId } : {}),
    })
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

  const resumeSection = (
    <ResumeSection
      hits={hits}
      now={now}
      filter={filter}
      onFilterChange={setFilter}
      searchRef={searchRef}
      onResume={resume}
    />
  )

  // Single-machine (or no machines yet): no Machines region to choose between.
  if (machines.length <= 1) {
    return (
      // modal={false}: the resume <input> lives in the content, so we must not
      // scroll-lock — that would fight the mobile keyboard pinning.
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger render={trigger ?? defaultTrigger} />
        <DropdownMenuContent
          align="end"
          className={`flex w-[248px] max-w-[calc(100vw-24px)] flex-col ${MENU_DROPDOWN_PANEL}`}
        >
          {header}
          {TAB_AGENTS.map(({ kind, label, Icon }) => {
            const machine = machines[0]
            const rejection = machine ? agentCapabilityRejection(machine, kind) : undefined
            return (
              <CapabilityAgentItem
                key={kind}
                kind={kind}
                label={label}
                Icon={Icon}
                reason={machine ? capabilityReason(machine, label, rejection) : undefined}
                hint={machine ? capabilityHint(rejection) : undefined}
                warning={
                  machine
                    ? loginWarning(machine, label, agentLoginCondition(machine, kind))
                    : undefined
                }
                onSelect={() => void create(kind, machine?.id)}
              />
            )
          })}
          <RecentFilesSection worktree={worktree} {...(issueId ? { issueId } : {})} />
          {resumeSection}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  // Multi-machine path.
  const repoMachines = machinesForRepoOrClone(repoView, machines)
  const eligible = onlineMachinesForRepoOrClone(repoView, machines)
  const eligibleIds = new Set(eligible.map((m) => m.id))

  return (
    // modal={false}: keep mobile keyboard pinning working.
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger render={trigger ?? defaultTrigger} />
      <DropdownMenuContent
        align="end"
        className={`flex w-[248px] max-w-[calc(100vw-24px)] flex-col ${MENU_DROPDOWN_PANEL}`}
      >
        {header}

        {/* 1. Agent options — open on the resolved target machine */}
        {TAB_AGENTS.map(({ kind, label, Icon }) => {
          const target = targetFor(kind)
          return (
            <CapabilityAgentItem
              key={kind}
              kind={kind}
              label={label}
              Icon={Icon}
              reason={
                target
                  ? undefined
                  : `No online machine with this repository can run ${agentLabel(label)}.`
              }
              hint={target ? undefined : 'no host'}
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
                    <DropdownMenuItem disabled className={MENU_DROPDOWN_ITEM}>
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
                onResume={resume}
                hits={hits}
                now={now}
              />
            )
          })}
        </TooltipProvider>

        <RecentFilesSection worktree={worktree} {...(issueId ? { issueId } : {})} />

        {/* 3. Resume convos — global mini-search */}
        {resumeSection}
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

/** The Resume region: the mini-search field and its hits.
 *
 *  One component, two call sites — the single- and multi-machine panels rendered
 *  a byte-identical copy of this each, which is how their section headings drifted
 *  apart in the first place. */
function ResumeSection({
  hits,
  now,
  filter,
  onFilterChange,
  searchRef,
  onResume,
}: {
  hits: ConversationHit[]
  now: number
  filter: string
  onFilterChange: (next: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  onResume: (hit: ConversationHit) => Promise<void>
}): JSX.Element {
  return (
    <>
      <div className={MENU_SECTION}>RESUME</div>
      <div className="relative mx-[5px] mb-[5px]">
        <Search
          className="pointer-events-none absolute top-1/2 left-[7px] size-3 -translate-y-1/2 text-text-faint"
          aria-hidden="true"
        />
        <Input
          ref={searchRef}
          type="text"
          aria-label="Search history"
          // Carved into the panel rather than raised on it: `--background` is the
          // window's ground and the panel is `--chip`, so the field reads as
          // pressed in without a shadow (DESIGN.md §4, The Carved Rule).
          className="h-[26px] rounded-md border-hairline-soft bg-background pr-2 pl-[23px] text-[11.5px] placeholder:text-text-faint focus-visible:border-hairline-soft focus-visible:ring-2 focus-visible:ring-ring/40 md:text-[11.5px]"
          placeholder="Search history…"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          // Base UI's Menu treats keystrokes as typeahead/arrow navigation and
          // steals them from this input (the post-Base-UI "search is broken"
          // regression). Keep keystrokes local to the field.
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      {hits.length === 0 && <div className={MENU_EMPTY}>No matching history</div>}
      {hits.map((hit) => (
        <HistoryItem key={hit.id} hit={hit} now={now} onResume={onResume} />
      ))}
    </>
  )
}

/** One resumable conversation. The arrow is a glyph on the shared text column,
 *  not a `↻` typed into the label — a character in the copy sits on the baseline
 *  at the font's own weight and left every row in this region indented
 *  differently from the file rows above it. */
function HistoryItem({
  hit,
  now,
  onResume,
}: {
  hit: ConversationHit
  now: number
  onResume: (hit: ConversationHit) => Promise<void>
}): JSX.Element {
  return (
    <DropdownMenuItem onClick={() => void onResume(hit)} className={MENU_DROPDOWN_ITEM}>
      <RotateCcw className={`${MENU_GLYPH} text-text-dim`} aria-hidden="true" />
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {hit.name || hit.title || hit.id}
      </span>
      {hit.updatedAt && (
        <span className={`${MENU_HINT} tabular-nums`}>{relativeTime(hit.updatedAt, now)}</span>
      )}
    </DropdownMenuItem>
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
          className={MENU_DROPDOWN_ITEM}
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
function MachineSubmenu({
  machine,
  onCreate,
  onResume,
  hits,
  now,
}: {
  machine: MachineWire
  onCreate: (kind: AgentKind, machineId: MachineId) => Promise<void>
  onResume: (hit: ConversationHit) => Promise<void>
  hits: ConversationHit[]
  now: number
}): JSX.Element {
  // Filter global hits to this machine; cap so the submenu stays compact.
  const machineHits = hits.filter((h) => h.machineId === machine.id).slice(0, SUB_HIT_LIMIT)

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={MENU_DROPDOWN_ITEM}>
        <Circle
          className={`${MACHINE_DOT} ${machine.online ? 'fill-success text-success' : 'text-text-faint'}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {machine.name}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className={`min-w-[168px] ${MENU_DROPDOWN_PANEL}`}>
        {TAB_AGENTS.map(({ kind, label, Icon }) => (
          <CapabilityAgentItem
            key={kind}
            kind={kind}
            label={label}
            Icon={Icon}
            reason={capabilityReason(machine, label, agentCapabilityRejection(machine, kind))}
            hint={capabilityHint(agentCapabilityRejection(machine, kind))}
            warning={loginWarning(machine, label, agentLoginCondition(machine, kind))}
            onSelect={() => void onCreate(kind, machine.id)}
          />
        ))}
        {machineHits.length > 0 && (
          <>
            <div className={MENU_SECTION}>RESUME</div>
            {machineHits.map((hit) => (
              <HistoryItem key={hit.id} hit={hit} now={now} onResume={onResume} />
            ))}
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function agentLabel(menuLabel: string): string {
  return menuLabel.replace(/^New /, '')
}

function loginWarning(
  machine: Pick<MachineWire, 'name'>,
  label: string,
  condition: ReturnType<typeof agentLoginCondition>,
): string | undefined {
  return condition === 'logged-out'
    ? `${agentLabel(label)} isn't logged in on ${machine.name}; the session will open so you can log in in the pane.`
    : undefined
}

function capabilityReason(
  machine: Pick<MachineWire, 'name'>,
  label: string,
  rejection: ReturnType<typeof agentCapabilityRejection>,
): string | undefined {
  // Exhaustive on purpose: an unhandled rejection would return undefined, and
  // undefined ENABLES the row — so a new refusal reason would silently become
  // "spawn is fine". A `never` here makes adding one a compile error instead.
  switch (rejection) {
    case undefined:
      return undefined
    // §3.1.4 M5: spawn UI must not offer machines the principal lacks `use` on,
    // and denied must not read as offline — those need opposite responses.
    case 'unauthorized':
      return `You don’t have access to run agents on ${machine.name}.`
    case 'offline':
      return `${machine.name} is offline.`
    case 'harness-missing':
      return `${agentLabel(label)} is not installed on ${machine.name}.`
    default: {
      const exhaustive: never = rejection
      return exhaustive
    }
  }
}

/** The short form of a refusal, stated on the row itself. The tooltip carries the
 *  sentence; a touch pointer never opens a tooltip, so the row has to say enough
 *  on its own to explain why it will not respond. */
function capabilityHint(
  rejection: ReturnType<typeof agentCapabilityRejection>,
): string | undefined {
  switch (rejection) {
    case 'unauthorized':
      return 'no access'
    case 'offline':
      return 'offline'
    case 'harness-missing':
      return 'not installed'
    default:
      return undefined
  }
}

/** Disabled menu rows retain pointer events on a wrapper so their reason is hoverable. */
function CapabilityAgentItem({
  kind,
  label,
  Icon,
  reason,
  warning,
  hint,
  onSelect,
}: {
  kind: AgentKind
  label: string
  Icon: IconComponent
  reason?: string
  warning?: string
  hint?: string
  onSelect: () => void
}): JSX.Element {
  const detail = reason ?? warning
  const item = (
    <DropdownMenuItem
      key={kind}
      disabled={reason !== undefined}
      className={`${MENU_DROPDOWN_ITEM}${
        // Attention as INK, and it has to survive the hover: the preset lifts a
        // hovered row to `--text-strong`, which would drop the one signal the
        // row exists to carry at exactly the moment the pointer is on it.
        warning && !reason ? ' text-warning hover:text-warning focus:text-warning' : ''
      }`}
      onClick={onSelect}
    >
      <Icon className={`${MENU_GLYPH} text-text-dim`} aria-hidden="true" />
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
        {label}
      </span>
      {hint && <span className={MENU_HINT}>{hint}</span>}
    </DropdownMenuItem>
  )
  if (!detail) return item
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<span className="block pointer-events-auto" />}>
          {item}
        </TooltipTrigger>
        <TooltipContent side="right">{detail}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
