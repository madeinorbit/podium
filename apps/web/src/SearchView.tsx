import type { AgentKind } from '@podium/protocol'
import { GitBranch, Settings as SettingsIcon } from 'lucide-react'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { panelLabel, reposToViews } from './derive'
import { relativeTime } from './home'
import { SETTINGS_TABS } from './SettingsView'
import { useStore } from './store'
import { type ConversationHit, useConversationSearch } from './useConversationSearch'

export type { ConversationHit }

/**
 * Conversation search over the durable server-side index (FTS keyword now;
 * vector lane joins when an embeddings provider is configured). The worktree
 * filter defaults to where the user opened the search from.
 */
export function SearchView({ onClose }: { onClose: () => void }): JSX.Element {
  const { trpc, repos, setSelectedWorktree, setPane, setView, setSettingsTab } = useStore()
  const isMobile = useIsMobile()
  const [query, setQuery] = useState('')
  // Search the whole index by default. Pre-scoping to the current worktree silently
  // hid every match outside it — the user searches "pwa", the PWA work lives in
  // another worktree, and nothing shows. The scope picker still narrows on demand.
  const [scope, setScope] = useState<string>('')
  const now = Date.now()

  const worktrees = useMemo(
    () => reposToViews(repos).flatMap((r) => r.worktrees.map((w) => ({ ...w, repoName: r.name }))),
    [repos],
  )

  // Debounced live search; empty query browses by recency.
  const { hits, busy } = useConversationSearch({
    query,
    ...(scope ? { projectPath: scope } : {}),
    limit: 50,
    debounceMs: 180,
  })

  // Local, instant matches alongside indexed conversations: worktrees/branches to
  // jump to, and settings sections to open. Only with a query (empty = browse
  // conversations by recency).
  const q = query.trim().toLowerCase()
  const worktreeHits = useMemo(
    () =>
      q
        ? worktrees
            .filter(
              (w) =>
                w.repoName.toLowerCase().includes(q) ||
                (w.branch ?? '').toLowerCase().includes(q) ||
                w.path.toLowerCase().includes(q),
            )
            .slice(0, 8)
        : [],
    [worktrees, q],
  )
  const settingsHits = useMemo(
    () => (q ? SETTINGS_TABS.filter((t) => t.label.toLowerCase().includes(q) || t.key.includes(q)) : []),
    [q],
  )

  const openWorktree = (path: string) => {
    setSelectedWorktree(path)
    setView('workspace')
    onClose()
  }
  const openSettings = (tabKey: string) => {
    setSettingsTab(tabKey)
    setView('settings')
    onClose()
  }

  const resume = async (hit: ConversationHit) => {
    if (!hit.resumeKind || !hit.resumeValue) return
    const cwd = hit.projectPath ?? scope
    if (!cwd) return
    const { sessionId } = await trpc.sessions.resume.mutate({
      agentKind: hit.agentKind as AgentKind,
      cwd,
      resume: { kind: hit.resumeKind, value: hit.resumeValue },
      conversationId: hit.id,
      ...(hit.name || hit.title ? { title: hit.name ?? hit.title } : {}),
    })
    setSelectedWorktree(cwd)
    setPane('A', sessionId)
    setView('workspace')
    onClose()
  }

  return (
    <Dialog
      open
      modal={isMobile ? 'trap-focus' : true}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent
        aria-label="Search"
        className="flex max-h-[min(680px,calc(100dvh-2rem))] w-[min(640px,100%)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogHeader className="flex flex-row items-center gap-2 border-b border-border p-3">
          <DialogTitle className="sr-only">Search conversations, worktrees, settings</DialogTitle>
          <Input
            // biome-ignore lint/a11y/noAutofocus: a search modal exists to be typed into
            autoFocus
            type="text"
            placeholder="Search conversations, worktrees, settings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
            }}
            className="flex-1"
          />
          <Select value={scope} onValueChange={(v) => setScope(v ?? '')}>
            <SelectTrigger className="w-[180px] shrink min-w-0 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Everywhere</SelectItem>
              {worktrees.map((w) => (
                <SelectItem key={w.path} value={w.path}>
                  {w.repoName} / {w.branch ?? w.path.split('/').pop()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </DialogHeader>
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 pt-1.5 pb-3">
          {settingsHits.length > 0 && (
            <SearchGroup label="Settings">
              {settingsHits.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md border border-border px-[11px] py-2 text-left text-[13px] text-foreground hover:border-primary hover:bg-accent"
                  onClick={() => openSettings(t.key)}
                >
                  <SettingsIcon size={13} className="flex-none text-muted-foreground/70" />
                  <span className="font-medium">{t.label}</span>
                  <span className="ml-auto flex-none text-[11px] text-muted-foreground/70 [font-variant:all-small-caps]">
                    settings
                  </span>
                </button>
              ))}
            </SearchGroup>
          )}
          {worktreeHits.length > 0 && (
            <SearchGroup label="Worktrees">
              {worktreeHits.map((w) => (
                <button
                  key={w.path}
                  type="button"
                  className="flex w-full min-w-0 items-center gap-2 rounded-md border border-border px-[11px] py-2 text-left text-[13px] text-foreground hover:border-primary hover:bg-accent"
                  onClick={() => openWorktree(w.path)}
                >
                  <GitBranch size={13} className="flex-none text-muted-foreground/70" />
                  <span className="flex-none font-medium">{w.repoName}</span>
                  <span className="flex-none text-muted-foreground">
                    / {w.branch ?? w.path.split('/').pop()}
                  </span>
                  <span
                    className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground/70"
                    title={w.path}
                  >
                    {w.path.split('/').slice(-2).join('/')}
                  </span>
                </button>
              ))}
            </SearchGroup>
          )}
          {hits.length > 0 && q && (
            <div className="px-1 pt-1 text-[10px] uppercase tracking-[0.06em] text-muted-foreground/60">
              Conversations
            </div>
          )}
          {busy && hits.length === 0 && (
            <div className="p-3 text-xs text-muted-foreground/70">Searching…</div>
          )}
          {!busy && hits.length === 0 && worktreeHits.length === 0 && settingsHits.length === 0 && (
            <div className="p-3 text-xs text-muted-foreground/70">
              {query ? 'No matches.' : 'No conversations indexed yet.'}
            </div>
          )}
          {hits.map((hit) => (
            <div
              key={hit.id}
              className="flex flex-col gap-1 rounded-md border border-border px-[11px] py-2"
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-semibold text-foreground">
                  {hit.name || hit.title || hit.id}
                </span>
                <span className="flex-none text-muted-foreground/70 [font-variant:all-small-caps]">
                  {kindLabel(hit.agentKind)}
                </span>
                {hit.updatedAt && (
                  <span className="ml-auto flex-none text-[11px] text-muted-foreground/70">
                    {relativeTime(hit.updatedAt, now)}
                  </span>
                )}
              </div>
              {hit.summary && (
                <div className="text-xs text-muted-foreground">{hit.summary}</div>
              )}
              <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground/70">
                <span title={hit.projectPath}>
                  {hit.projectPath?.split('/').slice(-2).join('/')}
                </span>
                {typeof hit.messageCount === 'number' && <span>{hit.messageCount} messages</span>}
                {hit.resumeValue && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="ml-auto"
                    onClick={() => void resume(hit)}
                  >
                    ↻ Resume
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** A labelled group of local (non-conversation) search results. */
function SearchGroup({ label, children }: { label: string; children: JSX.Element[] }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="px-1 text-[10px] uppercase tracking-[0.06em] text-muted-foreground/60">
        {label}
      </div>
      {children}
    </div>
  )
}

function kindLabel(agentKind: string): string {
  if (
    agentKind === 'claude-code' ||
    agentKind === 'codex' ||
    agentKind === 'grok' ||
    agentKind === 'shell'
  ) {
    return panelLabel(agentKind)
  }
  return agentKind
}
