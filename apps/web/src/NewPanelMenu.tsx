import type { AgentKind } from '@podium/protocol'
import { Plus, SquareTerminal } from 'lucide-react'
import type React from 'react'
import { type JSX, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { reposToViews } from './derive'
import { relativeTime } from './home'
import { ClaudeCodeIcon, CursorIcon, GrokIcon, OpenAIcon, OpenCodeIcon } from './icons/AgentIcons'
import { useStore } from './store'
import type { WorktreeView } from './types'
import { type ConversationHit, useConversationSearch } from './useConversationSearch'

type IconComponent = React.ComponentType<Record<string, unknown>>

const NEW_AGENTS: { kind: AgentKind; label: string; Icon: IconComponent }[] = [
  { kind: 'claude-code', label: 'New Claude', Icon: ClaudeCodeIcon },
  { kind: 'codex', label: 'New Codex', Icon: OpenAIcon },
  { kind: 'grok', label: 'New Grok', Icon: GrokIcon },
  { kind: 'opencode', label: 'New OpenCode', Icon: OpenCodeIcon },
  { kind: 'cursor', label: 'New Cursor', Icon: CursorIcon },
  { kind: 'shell', label: 'New Shell', Icon: SquareTerminal },
]

const MINI_LIMIT = 8

/**
 * The "+" menu: start a fresh agent/shell, or resume from history. The resume
 * list is the mini search — server-indexed, capped, recency-first, with a
 * filter box — instead of dumping every discovered conversation.
 */
export function NewPanelMenu({
  worktree,
  onOpened,
}: {
  worktree: WorktreeView
  onOpened: (sessionId: string) => void
}): JSX.Element {
  const { trpc, repos } = useStore()
  const [filter, setFilter] = useState('')
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

  async function create(agentKind: AgentKind) {
    const { sessionId } = await trpc.sessions.create.mutate({ agentKind, cwd: worktree.path })
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
    })
    onOpened(sessionId)
  }

  return (
    // modal={false}: the resume <input> lives in the content, so we must not
    // scroll-lock — that would fight the mobile keyboard pinning.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="New panel">
            <Plus size={16} />
          </Button>
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
