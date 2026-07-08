import { shallowEqual } from '@podium/client-core/store'
import type { AgentKind } from '@podium/protocol'
import { Circle, SquarePlus, SquareTerminal } from 'lucide-react'
import type React from 'react'
import { type JSX, useEffect, useMemo, useRef, useState } from 'react'
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
import { machinesForRepo, machinesWithRepo, reposToViews, resolveTargetMachine } from './derive'
import { relativeTime } from './home'
import { ClaudeCodeIcon, CursorIcon, GrokIcon, OpenAIcon, OpenCodeIcon } from './icons/AgentIcons'
import { useStoreSelector } from './store'
import type { RepoView, WorktreeView } from './types'
import { type ConversationHit, useConversationSearch } from './useConversationSearch'

type IconComponent = React.ComponentType<Record<string, unknown>>

export const NEW_AGENTS: { kind: AgentKind; label: string; Icon: IconComponent }[] = [
  { kind: 'claude-code', label: 'New Claude', Icon: ClaudeCodeIcon },
  { kind: 'codex', label: 'New Codex', Icon: OpenAIcon },
  { kind: 'grok', label: 'New Grok', Icon: GrokIcon },
  { kind: 'opencode', label: 'New OpenCode', Icon: OpenCodeIcon },
  { kind: 'cursor', label: 'New Cursor', Icon: CursorIcon },
  { kind: 'shell', label: 'New Shell', Icon: SquareTerminal },
]

const MINI_LIMIT = 8
// Fewer hits shown inside each machine's submenu to keep it compact.
const SUB_HIT_LIMIT = 4

/**
 * The "+" menu: start a fresh agent/shell, or resume from history. The resume
 * list is the mini search — server-indexed, capped, recency-first, with a
 * filter box — instead of dumping every discovered conversation.
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
  onOpened: (sessionId: string) => void
  /** Attach every session spawned from this menu to an issue (issue-as-workspace:
   *  the "+" inside an issue-keyed workspace). Omitted = today's behavior. */
  issueId?: string
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

  // The machine we'd open on by default (MRU with repo → first with repo → undefined).
  const target = useMemo(
    () => resolveTargetMachine(repoView, sessions, machines),
    [repoView, sessions, machines],
  )

  /** Local path to use when opening an agent on machine M. */
  function cwdFor(machineId: string | undefined): string {
    if (!machineId || machineId === worktree.machineId) return worktree.path
    return repoView.machines.find((m) => m.machineId === machineId)?.path ?? worktree.path
  }

  async function create(agentKind: AgentKind, machineId?: string) {
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

  // Single-machine (or no machines yet): render the original menu byte-for-byte.
  if (machines.length <= 1) {
    return (
      // modal={false}: the resume <input> lives in the content, so we must not
      // scroll-lock — that would fight the mobile keyboard pinning.
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            trigger ?? (
              <Button variant="ghost" size="icon" aria-label="New panel">
                <SquarePlus size={16} />
              </Button>
            )
          }
        />
        <DropdownMenuContent align="end" className="flex w-56 flex-col">
          {NEW_AGENTS.map(({ kind, label, Icon }) => (
            <DropdownMenuItem key={kind} onClick={() => void create(kind)}>
              <Icon size={14} aria-hidden="true" className="text-muted-foreground" />
              {label}
            </DropdownMenuItem>
          ))}
          <div className="px-2.5 pt-2 pb-0.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground/70">
            Resume
          </div>
          <Input
            ref={searchRef}
            type="text"
            className="mx-1.5 mb-1 mt-0.5 h-auto w-auto py-1 text-xs"
            placeholder="Search history…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            // Base UI's Menu treats keystrokes as typeahead/arrow navigation and
            // steals them from this input (the post-Base-UI "search is broken"
            // regression). Keep keystrokes local to the field.
            onKeyDown={(e) => e.stopPropagation()}
          />
          {hits.length === 0 && (
            <div className="px-3 py-3 text-xs text-muted-foreground/70">No matching history</div>
          )}
          {hits.map((hit) => (
            <DropdownMenuItem
              key={hit.id}
              onClick={() => void resume(hit)}
              className="flex items-baseline gap-2"
            >
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                ↻ {hit.name || hit.title || hit.id}
              </span>
              {hit.updatedAt && (
                <span className="ml-auto flex-none text-[11px] text-muted-foreground/70">
                  {relativeTime(hit.updatedAt, now)}
                </span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  // Multi-machine path.
  const repoMachines = machinesWithRepo(repoView, machines)
  const eligible = machinesForRepo(repoView, machines)
  const eligibleIds = new Set(eligible.map((m) => m.id))

  return (
    // modal={false}: keep mobile keyboard pinning working.
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          trigger ?? (
            <Button variant="ghost" size="icon" aria-label="New panel">
              <SquarePlus size={16} />
            </Button>
          )
        }
      />
      <DropdownMenuContent align="end" className="flex w-56 flex-col">
        {/* 1. Agent options — open on the resolved target machine */}
        {NEW_AGENTS.map(({ kind, label, Icon }) => (
          <DropdownMenuItem key={kind} onClick={() => void create(kind, target)}>
            <Icon size={14} aria-hidden="true" className="text-muted-foreground" />
            {label}
          </DropdownMenuItem>
        ))}

        {/* 2. Machines section */}
        <div className="px-2.5 pt-2 pb-0.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground/70">
          Machines
        </div>
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
                    <DropdownMenuItem disabled className="flex items-center gap-1.5">
                      <Circle size={6} className="flex-none text-muted-foreground/40" />
                      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                        {machine.name}
                      </span>
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

        {/* 3. Resume convos — global mini-search, unchanged layout */}
        <div className="px-2.5 pt-2 pb-0.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground/70">
          Resume
        </div>
        <Input
          ref={searchRef}
          type="text"
          className="mx-1.5 mb-1 mt-0.5 h-auto w-auto py-1 text-xs"
          placeholder="Search history…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          // Base UI's Menu treats keystrokes as typeahead/arrow navigation and
          // steals them from this input (the post-Base-UI "search is broken"
          // regression). Keep keystrokes local to the field.
          onKeyDown={(e) => e.stopPropagation()}
        />
        {hits.length === 0 && (
          <div className="px-3 py-3 text-xs text-muted-foreground/70">No matching history</div>
        )}
        {hits.map((hit) => (
          <DropdownMenuItem
            key={hit.id}
            onClick={() => void resume(hit)}
            className="flex items-baseline gap-2"
          >
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
              ↻ {hit.name || hit.title || hit.id}
            </span>
            {hit.updatedAt && (
              <span className="ml-auto flex-none text-[11px] text-muted-foreground/70">
                {relativeTime(hit.updatedAt, now)}
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
  machine: { id: string; name: string; online: boolean }
  onCreate: (kind: AgentKind, machineId: string) => Promise<void>
  onResume: (hit: ConversationHit) => Promise<void>
  hits: ConversationHit[]
  now: number
}): JSX.Element {
  // Filter global hits to this machine; cap so the submenu stays compact.
  const machineHits = hits.filter((h) => h.machineId === machine.id).slice(0, SUB_HIT_LIMIT)

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="flex items-center gap-1.5">
        <Circle
          size={6}
          className={`flex-none ${machine.online ? 'fill-emerald-500 text-emerald-500' : 'text-muted-foreground/40'}`}
        />
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {machine.name}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {NEW_AGENTS.map(({ kind, label, Icon }) => (
          <DropdownMenuItem key={kind} onClick={() => void onCreate(kind, machine.id)}>
            <Icon size={14} aria-hidden="true" className="text-muted-foreground" />
            {label}
          </DropdownMenuItem>
        ))}
        {machineHits.length > 0 && (
          <>
            <div className="px-2.5 pt-2 pb-0.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground/70">
              Resume
            </div>
            {machineHits.map((hit) => (
              <DropdownMenuItem
                key={hit.id}
                onClick={() => void onResume(hit)}
                className="flex items-baseline gap-2"
              >
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  ↻ {hit.name || hit.title || hit.id}
                </span>
                {hit.updatedAt && (
                  <span className="ml-auto flex-none text-[11px] text-muted-foreground/70">
                    {relativeTime(hit.updatedAt, now)}
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
