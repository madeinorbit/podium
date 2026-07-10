import { shallowEqual } from '@podium/client-core/store'
import type { AgentKind, SearchResultWire } from '@podium/protocol'
import {
  CircleDot,
  FileText,
  MessagesSquare,
  Settings as SettingsIcon,
  SquareTerminal,
} from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { relativeTime } from '@/lib/home'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { cn } from '@/lib/utils'

const DEBOUNCE_MS = 250
const MIN_QUERY_LEN = 2

/** Render order of the kind sections; within a section hits keep server rank. */
const GROUPS: { kind: SearchResultWire['kind']; label: string }[] = [
  { kind: 'session', label: 'Sessions' },
  { kind: 'issue', label: 'Issues' },
  { kind: 'conversation', label: 'Conversations' },
  { kind: 'transcript', label: 'Transcripts' },
  { kind: 'setting', label: 'Settings' },
]

const KIND_ICON: Record<SearchResultWire['kind'], typeof SquareTerminal> = {
  session: SquareTerminal,
  issue: CircleDot,
  conversation: MessagesSquare,
  transcript: FileText,
  setting: SettingsIcon,
}

/**
 * Debounced, race-guarded omni-search over the server-side index
 * (trpc `search.query` → ranked SearchResultWire[]). The seq ref drops a slow
 * response for a stale query so it can't overwrite the current results.
 */
function useOmniSearch(query: string): {
  hits: SearchResultWire[]
  busy: boolean
  failed: boolean
} {
  const trpc = useStoreSelector((s) => s.trpc)
  const [state, setState] = useState<{
    hits: SearchResultWire[]
    busy: boolean
    failed: boolean
  }>({ hits: [], busy: false, failed: false })
  const seq = useRef(0)

  useEffect(() => {
    const text = query.trim()
    const mySeq = ++seq.current
    if (text.length < MIN_QUERY_LEN) {
      // Keep the same state object when already empty so this effect can't
      // re-render (and re-run) itself in a loop.
      setState((s) =>
        s.hits.length === 0 && !s.busy && !s.failed ? s : { hits: [], busy: false, failed: false },
      )
      return
    }
    setState((s) => ({ ...s, busy: true }))
    const t = setTimeout(() => {
      trpc.search.query
        .query({ text, limit: 50 })
        .then((hits) => {
          if (seq.current === mySeq) setState({ hits, busy: false, failed: false })
        })
        .catch(() => {
          if (seq.current === mySeq) setState({ hits: [], busy: false, failed: true })
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [trpc, query])

  return state
}

/**
 * A transcript FTS snippet with `**` match markers, rendered as text + <mark>
 * spans. The snippet is plain text — split on the markers and build elements,
 * never innerHTML. An unpaired trailing marker leaves its tail unhighlighted.
 */
function SnippetSpans({ text }: { text: string }): JSX.Element {
  const parts = text.split('**')
  // With balanced markers the array has odd length; even length means the last
  // opening marker never closed — treat that tail as plain text.
  const lastMarked = parts.length % 2 === 1 ? parts.length : parts.length - 1
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 && i < lastMarked ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <mark key={i} className="rounded-[2px] bg-primary/25 px-px text-foreground">
            {p}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

/**
 * Omni-search over the server-side index: sessions, issues (incl. comment
 * bodies), conversations, transcripts (FTS) and settings, one ranked list
 * grouped by kind. Every hit navigates: session/transcript-with-live-session →
 * open the panel, issue → issue detail, conversation → resume, setting →
 * deep-linked settings tab.
 */
export function SearchView({ onClose }: { onClose: () => void }): JSX.Element {
  const { trpc, sessions, setSelectedWorktree, setPane, setView, setSettingsTab, setOpenIssueId } =
    useStoreSelector(
      (s) => ({
        trpc: s.trpc,
        sessions: s.sessions,
        setSelectedWorktree: s.setSelectedWorktree,
        setPane: s.setPane,
        setView: s.setView,
        setSettingsTab: s.setSettingsTab,
        setOpenIssueId: s.setOpenIssueId,
      }),
      shallowEqual,
    )
  const isMobile = useIsMobile()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [navError, setNavError] = useState<string | null>(null)
  const now = Date.now()

  const { hits, busy, failed } = useOmniSearch(query)

  // Grouped by kind for the sections; `flat` in render order drives the
  // arrow-key selection.
  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({ ...g, hits: hits.filter((h) => h.kind === g.kind) })).filter(
        (g) => g.hits.length > 0,
      ),
    [hits],
  )
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when results change
  useEffect(() => {
    setSelected(0)
  }, [flat])

  const openSession = (sessionId: string) => {
    const cwd = sessions.find((s) => s.sessionId === sessionId)?.cwd
    if (cwd) setSelectedWorktree(cwd)
    setPane('A', sessionId)
    setView('workspace')
    onClose()
  }

  // Omni hits don't carry resume refs; resolve the full conversation row from
  // the conversation index (the same store the hit came from), then resume it.
  const openConversation = async (conversationId: string) => {
    setNavError(null)
    try {
      let rows = await trpc.conversations.search.query({
        ...(query.trim() ? { query: query.trim() } : {}),
        limit: 50,
      })
      let row = rows.find((r) => r.id === conversationId)
      if (!row) {
        rows = await trpc.conversations.search.query({ limit: 200 })
        row = rows.find((r) => r.id === conversationId)
      }
      if (!row?.resumeKind || !row.resumeValue || !row.projectPath) {
        setNavError('This conversation has no resume handle.')
        return
      }
      const { sessionId } = await trpc.sessions.resume.mutate({
        agentKind: row.agentKind as AgentKind,
        cwd: row.projectPath,
        resume: { kind: row.resumeKind, value: row.resumeValue },
        conversationId: row.id,
        ...(row.name || row.title ? { title: row.name ?? row.title } : {}),
      })
      setSelectedWorktree(row.projectPath)
      setPane('A', sessionId)
      setView('workspace')
      onClose()
    } catch {
      setNavError('Could not open that conversation.')
    }
  }

  const activate = (hit: SearchResultWire) => {
    switch (hit.kind) {
      case 'session':
        openSession(hit.sessionId ?? hit.id)
        break
      case 'issue':
        setOpenIssueId(hit.id)
        setView('issues')
        onClose()
        break
      case 'setting':
        setSettingsTab(hit.settingKey ?? hit.id)
        setView('settings')
        onClose()
        break
      case 'conversation':
        void openConversation(hit.nativeId ?? hit.id)
        break
      case 'transcript':
        if (hit.sessionId) openSession(hit.sessionId)
        else if (hit.podiumId) void openConversation(hit.podiumId)
        else setNavError('No live session or conversation for this transcript.')
        break
    }
  }

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, Math.max(0, flat.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      const hit = flat[selected]
      if (hit) {
        e.preventDefault()
        activate(hit)
      }
    }
  }

  const tooShort = query.trim().length < MIN_QUERY_LEN
  let flatIndex = 0

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
          <DialogTitle className="sr-only">
            Search sessions, issues, conversations, transcripts, settings
          </DialogTitle>
          <Input
            // biome-ignore lint/a11y/noAutofocus: a search modal exists to be typed into
            autoFocus
            type="text"
            placeholder="Search sessions, issues, conversations, transcripts, settings…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setNavError(null)
            }}
            onKeyDown={onInputKeyDown}
            className="flex-1"
          />
        </DialogHeader>
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 pt-1.5 pb-3">
          {navError && <div className="px-1 pt-1 text-xs text-destructive">{navError}</div>}
          {failed && (
            <div className="p-3 text-xs text-muted-foreground/70">
              Search failed — is the server reachable?
            </div>
          )}
          {tooShort && !failed && (
            <div className="p-3 text-xs text-muted-foreground/70">
              Search across sessions, issues, conversations, transcripts and settings.
            </div>
          )}
          {!tooShort && busy && flat.length === 0 && !failed && (
            <div className="p-3 text-xs text-muted-foreground/70">Searching…</div>
          )}
          {!tooShort && !busy && flat.length === 0 && !failed && (
            <div className="p-3 text-xs text-muted-foreground/70">No matches.</div>
          )}
          {groups.map((g) => (
            <div key={g.kind} className="flex flex-col gap-1">
              <div className="px-1 pt-1 text-[10px] uppercase tracking-[0.06em] text-muted-foreground/60">
                {g.label}
              </div>
              {g.hits.map((hit) => {
                const idx = flatIndex++
                const Icon = KIND_ICON[hit.kind]
                return (
                  <button
                    key={`${hit.kind}:${hit.id}`}
                    type="button"
                    data-selected={idx === selected || undefined}
                    className={cn(
                      'flex w-full min-w-0 flex-col gap-1 rounded-md border px-[11px] py-2 text-left text-[13px] text-foreground hover:border-primary hover:bg-accent',
                      idx === selected ? 'border-primary bg-accent' : 'border-border',
                    )}
                    onClick={() => activate(hit)}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon size={13} className="flex-none text-muted-foreground/70" />
                      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium">
                        {hit.title}
                      </span>
                      {hit.ts && (
                        <span className="ml-auto flex-none text-[11px] text-muted-foreground/70">
                          {relativeTime(hit.ts, now)}
                        </span>
                      )}
                    </div>
                    {hit.snippet && (
                      <div className="line-clamp-2 pl-[21px] text-xs text-muted-foreground">
                        <SnippetSpans text={hit.snippet} />
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
