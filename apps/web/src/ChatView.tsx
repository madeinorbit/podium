import type { TranscriptItem } from '@podium/protocol'
import {
  ArrowDownToLine,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  FileText,
  Image as ImageIcon,
  Mic,
  Paperclip,
} from 'lucide-react'
import type { JSX } from 'react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  blockMatches,
  type ChatBlock,
  measureBlockOffsets,
  type MinimapTick,
  ticksFromOffsets,
  type PendingItem,
  pairToolResults,
  reconcilePending,
  searchBlocks,
} from './chat'
import { chatActivity } from './derive'
import { resolveAgainstCwd } from './file-path'
import { useIsMobile } from './hooks/use-is-mobile'
import { renderMarkdown } from './markdown'
import { useStore } from './store'
import { useVoiceInput } from './voice'

// Windowing: a marathon session can hold tens of thousands of items, and
// rendering every one mounts a matching count of (markdown-parsed) DOM
// subtrees — slow to lay out and heavy to keep. Cap the rendered tail and grow it
// in PAGE steps as the user scrolls up; the node count stays bounded no matter how
// long the transcript is. RENDER_WINDOW is the initial/grow-step block count.
const RENDER_WINDOW = 300
// On-demand older-page size fetched off disk when the user scrolls past the items
// already held locally (sessions.transcriptPage). Matches the server input default.
const OLDER_PAGE_LIMIT = 400

/**
 * Claude-app-style chat rendering of a session's structured transcript, with a
 * native write-through input, quick transcript search, and a Sublime-style
 * birds-eye minimap (user prompts highlighted; click scrolls).
 *
 * Arbitrary-length sessions: only a bounded tail of blocks is rendered at once;
 * scrolling toward the top first reveals more locally-held blocks, then autoloads
 * older pages straight off disk (sessions.transcriptPage) and prepends them while
 * preserving the scroll position. Live tailing (append + auto-scroll-to-bottom)
 * is unchanged.
 */

/** Returns true when a DataTransferItemList contains at least one image item. */
export function hasImageItems(items: DataTransferItemList): boolean {
  for (let i = 0; i < items.length; i++) {
    if (items[i]?.type.startsWith('image/')) return true
  }
  return false
}

/** Build the path-prefixed prompt: image paths prepended newline-separated, then the user text. */
export function buildImagePrompt(paths: string[], text: string): string {
  if (paths.length === 0) return text
  return `${paths.join('\n')}\n${text}`
}

type Attachment = {
  id: string
  name: string
  previewUrl: string
  path?: string
  state: 'uploading' | 'ready' | 'failed'
}

/**
 * Returns true when incoming transcript items represent a reset that should
 * force the scroll position back to the bottom (new session load, reconnect
 * snapshot, or Codex session-switch that sends a fresh snapshot).
 *
 * Extracted as a pure function so it can be unit-tested without a DOM.
 */
export function shouldPinOnReset(isReset: boolean, pinnedToBottom: boolean): boolean {
  // A reset always re-pins: the user's scroll offset into the old data is
  // meaningless once the list has been replaced with a fresh snapshot.
  // Incremental appends respect the current pin state (user may have scrolled up).
  return isReset || pinnedToBottom
}

export function ChatView({
  sessionId,
  active = true,
}: {
  sessionId: string
  /** False when this panel is mounted but hidden (keep-mounted deck). On
   *  becoming active (true) the view snaps to the bottom if still pinned. */
  active?: boolean
}): JSX.Element {
  const { hub, trpc, sessions, drafts, setSessionDraft, resumeAndSend, openFile } = useStore()
  const session = sessions.find((s) => s.sessionId === sessionId)
  const cwd = session?.cwd ?? '/'
  const [items, setItems] = useState<TranscriptItem[]>([])
  // A parked session (hibernated/exited) has no live tail and an empty server
  // buffer after a restart, so the stream stays empty. Read its history off disk
  // on demand instead. Prefer it only when the live buffer is empty (a session
  // parked within this server's lifetime still has its buffer).
  const [fetched, setFetched] = useState<TranscriptItem[] | null>(null)
  const parked = session !== undefined && session.status !== 'live' && session.status !== 'starting'
  // Older items paged in from disk on scroll-to-top (sessions.transcriptPage),
  // newest-last. Always a contiguous chunk that sits immediately BEFORE the
  // live/fetched tail, so [...older, ...tail] is a clean prefix→suffix of the full
  // on-disk transcript.
  const [older, setOlder] = useState<TranscriptItem[]>([])
  // True while we still believe earlier items exist on disk beyond what's loaded.
  const [hasMoreOlder, setHasMoreOlder] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // How many trailing blocks to render (bounded DOM). Grows in RENDER_WINDOW steps
  // as the user scrolls up; reset per session.
  const [renderCount, setRenderCount] = useState(RENDER_WINDOW)
  // A live/starting session streams its transcript over the WS subscription: the
  // initial `cb(entry.items)` fires synchronously (usually empty) and the server's
  // buffered snapshot lands a beat later. Until that snapshot arrives we can't tell
  // "still loading" from "genuinely empty", so show a loader for a short grace
  // window after the subscription starts; once it expires (or any item arrives) we
  // trust the empty feed and fall back to the "No transcript yet" copy.
  const [liveGraceElapsed, setLiveGraceElapsed] = useState(false)
  // A parked-but-recoverable session can still take a composed message — submitting
  // wakes it and the text is delivered once it's ready (auto-resume on submit).
  const canResume =
    session?.status === 'hibernated' ||
    (session?.status === 'exited' && session?.resumable === true)
  // Draft lives in the store, keyed by session — shared across every view of this
  // session and preserved when toggling chat/native or splitting panes.
  const draft = drafts[sessionId] ?? ''
  const setDraft = (text: string) => setSessionDraft(sessionId, text)
  const [query, setQuery] = useState('')
  const [matchCursor, setMatchCursor] = useState(0)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const pinnedToBottom = useRef(true)
  // One-shot: snap to the newest message the first time a transcript populates
  // (initial load / session switch), not just on incremental growth.
  const didInitialScroll = useRef(false)
  // Scroll-anchor for prepends: the scroller's measured height + scrollTop captured
  // just before older blocks are inserted at the top, so a layout effect can keep
  // the previously-visible content from jumping by re-pinning scrollTop after the
  // inserted height lands. Null when no prepend is in flight.
  const prependAnchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  // Guards re-entrant older-page loads (a single scroll fires onScroll repeatedly).
  const loadingOlderRef = useRef(false)
  const [atBottom, setAtBottom] = useState(true)
  const [pending, setPending] = useState<PendingItem[]>([])
  const pendingSeq = useRef(0)
  // Block ids seen on the previous render — lets us detect *newly arrived* user
  // blocks so a freshly-echoed prompt reconciles its optimistic bubble.
  const seenUserIds = useRef<Set<string>>(new Set())
  const [justSent, setJustSent] = useState(false)
  const isMobile = useIsMobile()
  const voice = useVoiceInput((text) => setDraft(draft ? `${draft} ${text}` : text))
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(
    () =>
      hub.subscribeTranscript(sessionId, (newItems, meta) => {
        if (meta.reset) {
          // A snapshot reset replaces the whole list — re-pin and re-arm the
          // one-shot initial-scroll so the new content lands at the bottom.
          pinnedToBottom.current = true
          didInitialScroll.current = false
        }
        setItems(newItems)
      }),
    [hub, sessionId],
  )

  // Live-transcript grace window (see `liveGraceElapsed` above): reset on every
  // session switch, then expire after a beat so a genuinely empty live session
  // settles to the "No transcript yet" copy instead of spinning forever.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm the timer per session
  useEffect(() => {
    setLiveGraceElapsed(false)
    const t = setTimeout(() => setLiveGraceElapsed(true), 1500)
    return () => clearTimeout(t)
  }, [sessionId])

  useEffect(() => {
    if (!parked) {
      setFetched(null)
      return
    }
    let cancelled = false
    trpc.sessions.transcript
      .query({ sessionId })
      .then((r) => {
        if (!cancelled) setFetched(r.items)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [parked, sessionId, trpc])

  // The live/fetched tail the server hands us (the bounded window). Older items
  // beyond it are paged in via `older` and prepended below.
  const tail = parked && fetched && fetched.length > 0 ? fetched : items
  const effectiveItems = useMemo(
    () => (older.length > 0 ? [...older, ...tail] : tail),
    [older, tail],
  )
  const blocks = useMemo(() => pairToolResults(effectiveItems), [effectiveItems])
  // Render only the trailing window of blocks so the DOM node count stays bounded
  // for arbitrarily long transcripts. Indices passed to ChatBlockView/data-block
  // stay absolute into `blocks` so the minimap and search keep lining up.
  const renderStart = Math.max(0, blocks.length - renderCount)
  const visibleBlocks = renderStart > 0 ? blocks.slice(renderStart) : blocks
  // More blocks exist above the current window: either already loaded locally
  // (just reveal them) or still on disk (autoload + prepend). Drives the top
  // sentinel + the scroll trigger.
  const moreAbove = renderStart > 0 || hasMoreOlder
  // The single AskUserQuestion the user can answer right now: the LAST one in the
  // transcript that hasn't been answered yet (no paired tool result), and only
  // when the session is live so a digit can actually reach the native menu.
  // Every other AskUserQuestion card stays read-only with its chosen-option
  // highlight. Index into `blocks` so the card can self-identify by position.
  const livePendingAskIndex = useMemo(() => {
    const live = session?.status === 'live' || session?.status === 'starting'
    if (!live) return -1
    let last = -1
    blocks.forEach((b, i) => {
      const isAsk =
        b.item.role === 'tool' && b.item.toolName === 'AskUserQuestion' && b.item.toolInputJson
      const answered = (b.result ?? b.item.toolResult) !== undefined
      if (isAsk && !answered) last = i
    })
    return last
  }, [blocks, session?.status])
  // Show the loader (not the empty-state copy) while a transcript is still in
  // flight. Two cases: a parked session's on-disk history hasn't resolved
  // (`fetched === null`), or a live/starting session hasn't streamed anything yet
  // and we're still inside the initial grace window (the buffered snapshot may
  // still land). Once the live grace expires with zero items, we trust it's empty.
  const loadingTranscript =
    blocks.length === 0 && (parked ? fetched === null : session !== undefined && !liveGraceElapsed)
  const matches = useMemo(() => searchBlocks(blocks, query), [blocks, query])
  const activeMatch = matches.length > 0 ? matches[matchCursor % matches.length] : undefined

  // A mobile AgentPanel reuses one ChatView instance across sessions (it isn't
  // keyed by sessionId like the desktop tabs are), so reset per-session local UI
  // state on a session switch — otherwise a stale optimistic bubble or "Sending…"
  // row from the previous session bleeds into the newly selected one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on session switch
  useEffect(() => {
    setPending([])
    setJustSent(false)
    seenUserIds.current = new Set()
    pinnedToBottom.current = true
    didInitialScroll.current = false
    // Fresh paging state for the newly selected session.
    setOlder([])
    setHasMoreOlder(true)
    setLoadingOlder(false)
    setRenderCount(RENDER_WINDOW)
  }, [sessionId])

  useEffect(() => {
    const prev = seenUserIds.current
    const next = new Set<string>()
    const newUserTexts: string[] = []
    for (const b of blocks) {
      if (b.item.role !== 'user') continue
      next.add(b.item.id)
      if (!prev.has(b.item.id)) newUserTexts.push(b.item.text)
    }
    seenUserIds.current = next
    if (newUserTexts.length > 0) {
      setPending((p) => (p.length === 0 ? p : reconcilePending(p, newUserTexts)))
    }
  }, [blocks])

  // Drop the "sending" affordance after a grace period even if no echo arrived
  // (slow tail / uninstrumented) — the prompt was still sent, so settle to 'sent'
  // (a plain bubble), NOT 'failed'. Only an actual send rejection marks 'failed'.
  useEffect(() => {
    if (!pending.some((p) => p.state === 'sending')) return
    const t = setTimeout(() => {
      setPending((p) => p.map((x) => (x.state === 'sending' ? { ...x, state: 'sent' } : x)))
    }, 30_000)
    return () => clearTimeout(t)
  }, [pending])

  // Clear the optimistic flag once the agent actually reports working (the badge
  // keeps the row visible) or after a short ceiling so it never sticks.
  useEffect(() => {
    if (!justSent) return
    if (session?.agentState?.phase === 'working' || session?.agentState?.phase === 'compacting') {
      setJustSent(false)
      return
    }
    const t = setTimeout(() => setJustSent(false), 8_000)
    return () => clearTimeout(t)
  }, [justSent, session?.agentState?.phase])

  // Follow the live tail unless the user scrolled up to read. Re-runs as blocks
  // arrive (snapshot lands after mount, then live appends) — an empty dep array
  // fired once before any transcript existed and never followed the stream.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the block list grows
  useEffect(() => {
    const el = scrollerRef.current
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight
  }, [blocks.length])
  // Scroll-anchor for prepends: after older blocks are inserted at the top (window
  // widened or a disk page prepended), the content the user was reading shifts down
  // by the inserted height. Re-pin scrollTop by that delta BEFORE paint so the view
  // doesn't jump. Keyed on the values that change the top of the list; a no-op
  // unless a prepend captured an anchor. Runs before the bottom-snap effect below,
  // and that effect is gated on pinnedToBottom (false while scrolled up), so the two
  // never fight.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-anchor when the top of the list changes
  useLayoutEffect(() => {
    const anchor = prependAnchor.current
    if (!anchor) return
    prependAnchor.current = null
    const el = scrollerRef.current
    if (!el) return
    const delta = el.scrollHeight - anchor.scrollHeight
    if (delta !== 0) el.scrollTop = anchor.scrollTop + delta
  }, [blocks.length, renderStart])

  // Initial-load snap: the growth effect above can fire before markdown/code
  // blocks have laid out (it measures a shorter scrollHeight and lands above the
  // tail). On the first populated render, defer two frames so layout settles,
  // then pin to the bottom. One-shot per session — incremental growth is handled
  // above and must still honour a user who scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot keyed off the block count
  useEffect(() => {
    if (didInitialScroll.current || blocks.length === 0) return
    didInitialScroll.current = true
    const el = scrollerRef.current
    if (!el) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (pinnedToBottom.current) el.scrollTop = el.scrollHeight
      })
    })
  }, [blocks.length])
  // ResizeObserver: while pinned, re-snap to bottom whenever the stream grows
  // taller (async markdown / code-block layout that settles after the DOM paint).
  // Gated on pinnedToBottom so it never yanks the view while the user has scrolled
  // up to read or page older content.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (pinnedToBottom.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Snap to bottom on pane switch-in: the keep-mounted panel deck hides inactive
  // panels with `display:none`, so scroll events stop firing. When this pane
  // becomes active again, honour the pin by jumping straight to the bottom (and
  // only then — a user who scrolled up keeps their position).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire only on active transition
  useEffect(() => {
    if (!active) return
    const el = scrollerRef.current
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight
  }, [active])

  // Reveal more above the current window: first grow the render window over blocks
  // we already hold locally; once those run out, fetch the next older page off disk
  // and prepend it. Captures the scroll geometry first so the anchoring layout
  // effect can keep the view from jumping when the inserted height lands.
  const loadOlder = () => {
    if (loadingOlderRef.current) return
    const el = scrollerRef.current
    // More blocks already loaded but windowed out → just widen the window.
    if (renderStart > 0) {
      if (el) prependAnchor.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
      setRenderCount((c) => c + RENDER_WINDOW)
      return
    }
    // Nothing left to reveal locally and nothing more on disk → done.
    if (!hasMoreOlder) return
    loadingOlderRef.current = true
    setLoadingOlder(true)
    if (el) prependAnchor.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
    // `fromEnd` = items we already hold (a contiguous suffix of the full
    // transcript); ask for the page immediately before them.
    const fromEnd = effectiveItems.length
    trpc.sessions.transcriptPage
      .query({ sessionId, fromEnd, limit: OLDER_PAGE_LIMIT })
      .then((r) => {
        if (r.items.length > 0) {
          setOlder((prev) => [...r.items, ...prev])
          // Keep the freshly-prepended items rendered (don't let the window slice
          // them straight back off).
          setRenderCount((c) => c + r.items.length)
        }
        setHasMoreOlder(r.hasMore)
      })
      .catch(() => {
        // Leave hasMoreOlder as-is so a transient failure can be retried by
        // scrolling again; just clear the anchor so we don't mis-restore.
        prependAnchor.current = null
      })
      .finally(() => {
        loadingOlderRef.current = false
        setLoadingOlder(false)
      })
  }

  const onScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinnedToBottom.current = near
    setAtBottom(near)
    // Near the TOP and more exists above → reveal/fetch older content.
    if (el.scrollTop < 200 && moreAbove) loadOlder()
  }
  const jumpToBottom = () => {
    const el = scrollerRef.current
    if (!el) return
    pinnedToBottom.current = true
    el.scrollTop = el.scrollHeight
    setAtBottom(true)
  }

  const processFiles = async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    const newAttachments: Attachment[] = imageFiles.map((f) => ({
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: f.name,
      previewUrl: URL.createObjectURL(f),
      state: 'uploading' as const,
    }))
    setAttachments((prev) => [...prev, ...newAttachments])
    await Promise.all(
      imageFiles.map(async (file, i) => {
        // newAttachments is built from imageFiles with the same length, so index is always valid
        const att = newAttachments[i] as Attachment
        try {
          const dataBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => {
              const result = reader.result as string
              resolve(result.split(',')[1] ?? result)
            }
            reader.onerror = () => reject(new Error('FileReader error'))
            reader.readAsDataURL(file)
          })
          const res = await trpc.sessions.uploadImage.mutate({
            sessionId,
            filename: file.name,
            mimeType: file.type,
            dataBase64,
          })
          setAttachments((prev) =>
            prev.map((a) => (a.id === att.id ? { ...a, path: res.path, state: 'ready' } : a)),
          )
        } catch {
          setAttachments((prev) =>
            prev.map((a) => (a.id === att.id ? { ...a, state: 'failed' } : a)),
          )
        }
      }),
    )
  }

  // Auto-grow the composer with its content, capped by the max-height (~8
  // lines), after which it scrolls. Runs on every draft change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the draft changes
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [draft])

  const scrollToBlock = (index: number) => {
    scrollerRef.current
      ?.querySelector(`[data-block="${index}"]`)
      ?.scrollIntoView({ block: 'center' })
  }
  // Jump to the active search match. A match can sit ABOVE the rendered window
  // (search runs over all loaded blocks, the DOM holds only the trailing window),
  // so first widen the window to include it, then scroll a frame later once its
  // node has mounted. (Matches still only span LOADED blocks — see the Minimap note
  // on paged-in-on-demand history.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolling is the effect of cursor moves
  useEffect(() => {
    if (activeMatch === undefined) return
    if (activeMatch < renderStart) {
      // Reveal enough trailing blocks to cover the match (no scroll-anchor — this
      // is an explicit jump, not a position-preserving prepend).
      setRenderCount(blocks.length - activeMatch + RENDER_WINDOW)
      requestAnimationFrame(() => scrollToBlock(activeMatch))
    } else {
      scrollToBlock(activeMatch)
    }
  }, [activeMatch])

  const send = async () => {
    const text = draft.trim()
    const readyAttachments = attachments.filter((a) => a.state === 'ready' && a.path)
    if (!text && readyAttachments.length === 0) return
    if (attachments.some((a) => a.state === 'uploading')) return
    const readyPaths = readyAttachments.map((a) => a.path as string)
    const fullText = buildImagePrompt(readyPaths, text)
    setDraft('')
    setAttachments([])
    pinnedToBottom.current = true
    setAtBottom(true)
    const id = `pending-${++pendingSeq.current}`
    const tags = readyAttachments.map((a) => ({ kind: 'image' as const, label: a.name }))
    setPending((p) => [...p, { id, text: fullText, at: Date.now(), state: 'sending', tags: tags.length > 0 ? tags : undefined }])
    setJustSent(true)
    try {
      // Live → send straight through. Parked but recoverable → wake it and let
      // the server deliver the text once the resumed CLI is ready.
      if (session?.status === 'live' || session?.status === 'starting') {
        await trpc.sessions.sendText.mutate({ sessionId, text: fullText })
      } else {
        await resumeAndSend(sessionId, fullText)
      }
    } catch {
      setPending((p) => p.map((x) => (x.id === id ? { ...x, state: 'failed' } : x)))
    }
  }

  // Answer a live AskUserQuestion from its chat card: send the chosen 1-based
  // option index per question to the server, which types the matching digit(s)
  // into the agent's native menu. Returns the promise so the card can show a
  // pending/failed state; the transcript reconciles when the agent's result tails
  // back (the answered card then renders read-only with its highlight). Memoized
  // so its identity stays stable — ChatBlockView is memo'd and a fresh callback
  // each render would defeat that for every block.
  const answerAsk = useMemo(
    () => async (choices: { optionIndices: number[] }[]) => {
      await trpc.sessions.answerAskUserQuestion.mutate({ sessionId, choices })
    },
    [trpc, sessionId],
  )

  const sendable = session?.status === 'live' || session?.status === 'starting'
  // The composer accepts input when the agent is live OR when it can be woken by
  // sending (auto-resume). Only a truly dead/unrecoverable session locks it out.
  const composerEnabled = sendable || canResume
  const activity = chatActivity(session, justSent)

  // Autofocus the composer when the chat view becomes active for a session that
  // can take input, so the user can type straight away. Re-runs on session switch
  // (the mobile AgentPanel reuses one instance). Gated on an enabled composer and
  // a settled transcript so we don't grab focus mid-load. Desktop only: forcing
  // focus on mobile would pop the soft keyboard over the conversation unbidden.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus on session switch / enable
  useEffect(() => {
    if (isMobile || !composerEnabled || loadingTranscript) return
    taRef.current?.focus()
  }, [sessionId, composerEnabled, loadingTranscript, isMobile])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
        <Input
          type="text"
          placeholder="Search transcript…"
          className="h-auto flex-1 rounded-md bg-background px-2.5 py-1 text-xs text-foreground"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setMatchCursor(0)
          }}
        />
        {query && (
          <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-[11px] text-muted-foreground">
            {matches.length === 0
              ? '0'
              : `${(matchCursor % Math.max(1, matches.length)) + 1}/${matches.length}`}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title="Previous match"
              className="size-auto rounded-none p-0.5 text-muted-foreground hover:bg-transparent hover:text-foreground"
              onClick={() =>
                setMatchCursor((c) => (c - 1 + matches.length) % Math.max(1, matches.length))
              }
            >
              <ChevronUp size={13} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title="Next match"
              className="size-auto rounded-none p-0.5 text-muted-foreground hover:bg-transparent hover:text-foreground"
              onClick={() => setMatchCursor((c) => (c + 1) % Math.max(1, matches.length))}
            >
              <ChevronDown size={13} aria-hidden="true" />
            </Button>
          </span>
        )}
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div
          className="flex min-w-0 flex-1 flex-col gap-0 overflow-y-auto px-5 pt-5 pb-6"
          ref={scrollerRef}
          onScroll={onScroll}
        >
          {blocks.length === 0 && loadingTranscript && (
            <div
              className="mx-auto my-8 flex items-center gap-2 text-[13px] text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <span
                className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground"
                aria-hidden="true"
              />
              Loading transcript…
            </div>
          )}
          {blocks.length === 0 && !loadingTranscript && (
            <div className="mx-auto my-6 max-w-[52ch] text-center text-[13px] text-muted-foreground/70">
              No transcript yet. For Claude, Codex, and Grok sessions the feed starts with the first
              prompt; shells have no structured transcript.
            </div>
          )}
          {/* Top sentinel: only the bounded tail of blocks is mounted; more exist
              above (windowed-out locally or still on disk). Scrolling here autoloads
              them (onScroll → loadOlder); this is also a manual fallback if the
              scroll trigger is missed. */}
          {blocks.length > 0 && moreAbove && (
            <button
              type="button"
              onClick={loadOlder}
              disabled={loadingOlder}
              className="mx-auto my-1 inline-flex items-center gap-2 text-[12px] text-muted-foreground/70 hover:text-foreground disabled:cursor-default"
              aria-live="polite"
            >
              {loadingOlder ? (
                <>
                  <span
                    className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground"
                    aria-hidden="true"
                  />
                  Loading earlier messages…
                </>
              ) : (
                'Load earlier messages'
              )}
            </button>
          )}
          {visibleBlocks.map((block, i) => {
            // Absolute index into `blocks` so minimap/search/data-block line up
            // with the full loaded list, not just the rendered window.
            const idx = renderStart + i
            return (
              <ChatBlockView
                key={`${idx}-${block.item.id}`}
                block={block}
                index={idx}
                highlighted={idx === activeMatch}
                dimmed={query.trim() !== '' && !blockMatches(block, query)}
                sessionId={sessionId}
                cwd={cwd}
                openFile={openFile}
                askLivePending={idx === livePendingAskIndex}
                onAnswerAsk={answerAsk}
              />
            )
          })}
          {pending.map((p) => (
            <div
              key={p.id}
              className={cn(
                'transcript-row mx-auto w-full max-w-[960px]',
                p.state === 'failed' && 'opacity-60',
              )}
            >
              {/* User rail */}
              <div className="transcript-rail transcript-rail--user" aria-hidden="true" />
              <div className="transcript-body">
                <div className="transcript-header">
                  <span className="transcript-role">You</span>
                  {p.state === 'sending' && (
                    <span className="transcript-meta">sending…</span>
                  )}
                  {p.state === 'failed' && (
                    <span className="transcript-meta text-destructive">not delivered</span>
                  )}
                </div>
                <div className="chat-md whitespace-pre-wrap">{p.text}</div>
                {p.tags && p.tags.length > 0 && (
                  <div className="mt-1.5 flex gap-1.5">
                    {p.tags.map((tag, i) => (
                      <span
                        key={`${tag.kind}-${i}`}
                        className="inline-flex items-center gap-1 rounded border border-input px-[7px] py-0.5 text-[11px] text-muted-foreground"
                      >
                        <ImageIcon size={12} aria-hidden="true" />
                        {tag.label ?? tag.kind}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {activity && (
            <div
              role="status"
              aria-live="polite"
              className={cn(
                // Match the shared status palette: working → green, needs-you →
                // yellow, everything else muted.
                'mx-auto flex w-full max-w-[960px] items-center gap-2 py-3 pl-[calc(3px+12px)] text-xs',
                activity.tone === 'attention'
                  ? 'text-amber-500'
                  : activity.tone === 'working'
                    ? 'text-emerald-500'
                    : 'text-muted-foreground',
              )}
            >
              <span className="inline-flex gap-0.5">
                <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.2s]" />
                <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.1s]" />
                <span className="size-1.5 animate-bounce rounded-full bg-current" />
              </span>
              {activity.label}
            </div>
          )}
        </div>
        {/* Minimap maps the RENDERED window (visibleBlocks), so its segments line
            up with the scrollable content. For a very long transcript that means
            it reflects the loaded/visible tail, not the entire on-disk history;
            scrolling up to page in older items extends what it covers. */}
        <Minimap blocks={visibleBlocks} scrollerRef={scrollerRef} />
        {!atBottom && (
          <button
            type="button"
            className="absolute bottom-3 left-1/2 z-[4] inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-input bg-muted px-3 py-[5px] text-xs text-foreground shadow-[0_4px_14px_rgba(0,0,0,0.4)] hover:border-primary"
            onClick={jumpToBottom}
          >
            <ArrowDownToLine size={13} aria-hidden="true" /> Jump to bottom
          </button>
        )}
      </div>
      {/* Composer: one auto-growing box (≈2 lines, up to 8) with the attach /
          voice / send actions inside it, Claude-iOS style. Enter inserts a
          newline; the send button (or ⌘/Ctrl+Enter) submits. */}
      <div
        className="border-t border-border bg-card px-3 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom,0px))]"
        onDragOver={(e) => {
          e.preventDefault()
          if (e.dataTransfer.items && hasImageItems(e.dataTransfer.items)) setDragOver(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          void processFiles(Array.from(e.dataTransfer.files))
        }}
      >
        <div className="relative flex flex-col gap-0.5 rounded-2xl border border-input bg-background px-2.5 pt-2 pb-1.5 focus-within:border-primary">
          {dragOver && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/5">
              <span className="text-sm font-medium text-primary">Drop image to attach</span>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void processFiles(Array.from(e.target.files))
              e.target.value = ''
            }}
          />
          <Textarea
            ref={taRef}
            rows={1}
            placeholder={
              sendable
                ? 'Message the agent…'
                : canResume
                  ? 'Message — resumes the agent…'
                  : 'Session is not running.'
            }
            className="max-h-44 min-h-11 w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0.5 text-sm leading-[1.45] text-foreground transition-none outline-none [field-sizing:fixed] focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100 dark:bg-transparent dark:disabled:bg-transparent"
            value={draft}
            disabled={!composerEnabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Desktop power-shortcut: ⌘/Ctrl+Enter submits. Plain Enter is a
              // newline (the send button submits), matching the mobile keyboard.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void send()
              }
            }}
            onPaste={(e) => {
              const { items } = e.clipboardData
              if (hasImageItems(items)) {
                e.preventDefault()
                const files: File[] = []
                for (let i = 0; i < items.length; i++) {
                  const item = items[i]
                  if (item?.type.startsWith('image/')) {
                    const f = item.getAsFile()
                    if (f) files.push(f)
                  }
                }
                void processFiles(files)
              }
            }}
          />
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-0.5 pt-1">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className={cn(
                    'relative flex items-center gap-1 rounded-lg border border-input bg-muted/50 px-2 py-1 text-[11px]',
                    att.state === 'failed' && 'border-destructive/50 text-destructive',
                  )}
                >
                  {att.previewUrl && att.state !== 'failed' && (
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      className="size-5 rounded object-cover"
                    />
                  )}
                  <span className="max-w-[80px] truncate text-muted-foreground">{att.name}</span>
                  {att.state === 'uploading' && (
                    <span className="size-2.5 animate-spin rounded-full border border-muted-foreground/30 border-t-muted-foreground" />
                  )}
                  {att.state === 'failed' && <span className="text-destructive">!</span>}
                  <button
                    type="button"
                    className="ml-0.5 text-muted-foreground/70 hover:text-foreground"
                    onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                    aria-label={`Remove ${att.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="rounded-full text-muted-foreground hover:bg-transparent hover:text-foreground [&_svg:not([class*='size-'])]:size-4"
              title="Attach image"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={16} aria-hidden="true" />
            </Button>
            {voice.supported && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "rounded-full text-muted-foreground hover:bg-transparent hover:text-foreground [&_svg:not([class*='size-'])]:size-4",
                  voice.listening && 'animate-pulse text-destructive hover:text-destructive',
                )}
                title={voice.listening ? 'Stop voice input' : 'Voice input'}
                onClick={voice.toggle}
              >
                <Mic size={16} aria-hidden="true" />
              </Button>
            )}
            <Button
              type="button"
              size="icon"
              className="rounded-full bg-primary text-primary-foreground hover:bg-primary/80 disabled:bg-secondary disabled:text-muted-foreground/70 disabled:opacity-100 [&_svg:not([class*='size-'])]:size-4"
              disabled={!composerEnabled || (!draft.trim() && attachments.length === 0) || attachments.some((a) => a.state === 'uploading')}
              title="Send (⌘/Ctrl+Enter)"
              onClick={() => void send()}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Memoized: ChatView re-renders on every search keystroke, every 700ms
// transcript poll, and every session-state change in the store. Block identity
// is stable across renders that don't change `items` (pairToolResults is
// memoized), so memo skips the expensive markdown re-render for unaffected rows.
const ChatBlockView = memo(function ChatBlockView({
  block,
  index,
  highlighted,
  dimmed,
  sessionId,
  cwd,
  openFile,
  askLivePending,
  onAnswerAsk,
}: {
  block: ChatBlock
  index: number
  highlighted: boolean
  dimmed: boolean
  sessionId: string
  cwd: string
  openFile: (sessionId: string, path: string) => void
  /** True only for the latest unanswered AskUserQuestion on a live session. */
  askLivePending: boolean
  onAnswerAsk: (choices: { optionIndices: number[] }[]) => Promise<void>
}): JSX.Element | null {
  const { item } = block
  const html = useMemo(() => renderMarkdown(item.text), [item.text])
  const rowClass = cn(
    'transcript-row mx-auto w-full max-w-[960px]',
    highlighted && 'rounded-md outline outline-1 outline-primary outline-offset-4',
    dimmed && 'opacity-35',
  )

  if (item.role === 'tool' && item.toolName === 'AskUserQuestion' && item.toolInputJson)
    return (
      <AskUserQuestionCard
        block={block}
        cls={rowClass}
        index={index}
        livePending={askLivePending}
        onAnswer={onAnswerAsk}
      />
    )
  if (item.role === 'tool')
    return (
      <ToolBlock
        block={block}
        cls={rowClass}
        index={index}
        sessionId={sessionId}
        cwd={cwd}
        openFile={openFile}
      />
    )

  // A recognized user action that isn't a chat message (e.g. interrupt) — show it
  // as a thin inline divider, not a "You" bubble.
  if (item.event === 'interrupt') {
    return (
      <div
        data-block={index}
        className={cn(
          rowClass,
          'my-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.07em] text-muted-foreground/55',
        )}
      >
        <span className="h-px flex-1 bg-border" />
        Interrupted
        <span className="h-px flex-1 bg-border" />
      </div>
    )
  }

  // Rail: user → blue accent, final answer → primary/amber, everything else → none
  const hasUserRail = item.role === 'user'
  const hasAnswerRail = item.role === 'assistant' && !!item.answer
  const hasRail = hasUserRail || hasAnswerRail

  return (
    <div className={rowClass} data-block={index}>
      {hasRail ? (
        <div
          className={cn(
            'transcript-rail',
            hasUserRail && 'transcript-rail--user',
            hasAnswerRail && 'transcript-rail--answer',
          )}
          aria-hidden="true"
        />
      ) : (
        // No rail: spacer so body lines up with railed rows
        <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      )}
      <div className="transcript-body">
        {item.role === 'user' && (
          <div className="transcript-header">
            <span className="transcript-role">You</span>
          </div>
        )}
        {item.role === 'system' && (
          <div className="transcript-header">
            <span className="transcript-role transcript-role--system">System</span>
          </div>
        )}
        {item.role === 'assistant' && item.answer && (
          <div className="transcript-header">
            <span className="transcript-role transcript-role--answer">Answer</span>
          </div>
        )}
        <div
          className="chat-md"
          onClick={(e) => {
            const a = (e.target as HTMLElement).closest('a.file-link') as HTMLElement | null
            if (!a) return
            e.preventDefault()
            const p = a.getAttribute('data-path')
            if (p) openFile(sessionId, resolveAgainstCwd(cwd, p))
          }}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify above
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {item.tags && item.tags.length > 0 && (
          <div className="mt-1.5 flex gap-1.5">
            {item.tags.map((tag, i) => {
              const filePath =
                tag.kind === 'file' && item.toolPaths?.[0]
                  ? resolveAgainstCwd(cwd, item.toolPaths[0])
                  : null
              return filePath ? (
                <button
                  key={`${tag.kind}-${i}`}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    openFile(sessionId, filePath)
                  }}
                  className="inline-flex cursor-pointer items-center gap-1 rounded border border-input px-[7px] py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={`Open ${filePath}`}
                >
                  <FileText size={12} aria-hidden="true" />
                  {tag.label ?? tag.kind}
                </button>
              ) : (
                <span
                  key={`${tag.kind}-${i}`}
                  className="inline-flex items-center gap-1 rounded border border-input px-[7px] py-0.5 text-[11px] text-muted-foreground"
                >
                  {tag.kind === 'image' ? (
                    <ImageIcon size={12} aria-hidden="true" />
                  ) : (
                    <FileText size={12} aria-hidden="true" />
                  )}
                  {tag.label ?? tag.kind}
                </span>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
})

interface AskOption {
  label: string
  description?: string
}
interface AskQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options?: AskOption[]
}

/**
 * The agent asking the human (AskUserQuestion) — render the question(s) and
 * options as a readable card instead of a collapsed tool row.
 *
 * Two modes:
 *  - `livePending`: the latest unanswered question on a live session. Options are
 *    clickable; a click submits the chosen 1-based option index(es) through the
 *    server, which types the matching digit(s) into the agent's native selector
 *    menu (the native terminal is unmounted in chat mode, so this is the only
 *    route to the prompt). After submit the card shows an optimistic selection +
 *    "Answer sent" and disables further clicks; the agent's tailed-back result
 *    then reconciles it to the read-only highlight.
 *  - otherwise (historical / already-answered / parked): read-only, with the
 *    chosen option highlighted from the tool result text.
 *
 * NEEDS IN-BROWSER VERIFICATION against a real Claude prompt: the exact key the
 * AskUserQuestion TUI accepts is documented (single-select commits on the option
 * number key; multi-select takes comma-separated numbers + Enter) but not yet
 * confirmed live here.
 */
function AskUserQuestionCard({
  block,
  cls,
  index,
  livePending,
  onAnswer,
}: {
  block: ChatBlock
  cls: string
  index: number
  livePending: boolean
  onAnswer: (choices: { optionIndices: number[] }[]) => Promise<void>
}): JSX.Element {
  const { item } = block
  let questions: AskQuestion[] = []
  try {
    const parsed = JSON.parse(item.toolInputJson ?? '{}')
    if (Array.isArray(parsed?.questions)) questions = parsed.questions
  } catch {
    // malformed input — fall through to an empty card
  }
  // The answer arrives as: …"<question>"="<chosen label>"… — match per option.
  const answer = block.result ?? item.toolResult ?? ''
  const isChosen = (label: string) => answer.includes(`"${label}"`)

  // Local answer state for a live question. `picks[qi]` is the set of selected
  // 0-based option indices for question qi. Multi-select toggles; single-select
  // submits on the first click. Once submitted we lock the card and wait for the
  // transcript to reconcile (which turns it back into a read-only highlight).
  const [picks, setPicks] = useState<Record<number, Set<number>>>({})
  const [submitState, setSubmitState] = useState<'idle' | 'sending' | 'failed'>('idle')
  const locked = submitState === 'sending' || !livePending

  const submit = async (next: Record<number, Set<number>>) => {
    // One choice entry per question, in order, with 1-based option indices.
    const choices = questions.map((_, qi) => ({
      optionIndices: [...(next[qi] ?? new Set<number>())].sort((a, b) => a - b).map((oi) => oi + 1),
    }))
    if (choices.some((c) => c.optionIndices.length === 0)) return // not every question answered yet
    setSubmitState('sending')
    try {
      await onAnswer(choices)
    } catch {
      setSubmitState('failed')
    }
  }

  const onOptionClick = (q: AskQuestion, qi: number, oi: number) => {
    if (locked) return
    setPicks((prev) => {
      const cur = new Set(prev[qi])
      if (q.multiSelect) {
        // Toggle within the question; the user confirms the set with the button.
        if (cur.has(oi)) cur.delete(oi)
        else cur.add(oi)
      } else {
        cur.clear()
        cur.add(oi)
      }
      const next = { ...prev, [qi]: cur }
      // Single-select with a single question → submit immediately (matches the
      // native menu, which commits the instant the option number is pressed).
      const allSingle = questions.every((qq) => !qq.multiSelect)
      const allAnswered = questions.every((_, i) => (next[i]?.size ?? 0) > 0)
      if (allSingle && allAnswered) void submit(next)
      return next
    })
  }

  // A live multi-select (or multi-question) card needs an explicit confirm: the
  // user toggles options, then submits the whole set in one go.
  const needsConfirmButton =
    livePending && submitState !== 'sending' && questions.some((q) => q.multiSelect)
  const allAnswered = questions.length > 0 && questions.every((_, qi) => (picks[qi]?.size ?? 0) > 0)

  return (
    <div className={cn(cls)} data-block={index}>
      {/* Amber rail to match the "attention" tone of AskUserQuestion */}
      <div className="transcript-rail transcript-rail--answer" aria-hidden="true" />
      <div className="transcript-body">
        <div className="transcript-header">
          <span className="transcript-role transcript-role--answer">Question for you</span>
          {livePending && submitState === 'sending' && (
            <span className="transcript-meta">answer sent…</span>
          )}
          {livePending && submitState === 'failed' && (
            <span className="transcript-meta text-destructive">not delivered</span>
          )}
        </div>
        <div className="mt-1.5 flex flex-col gap-3">
          {questions.map((q, qi) => (
            <div key={`${q.header ?? q.question}-${qi}`}>
              {q.header && (
                <div className="mb-0.5 text-[10px] uppercase tracking-[0.06em] text-muted-foreground/70">
                  {q.header}
                </div>
              )}
              <div className="text-sm font-medium text-foreground">{q.question}</div>
              <div className="mt-2 flex flex-col gap-1">
                {(q.options ?? []).map((o, oi) => {
                  // Pending: highlight the user's local pick. Read-only: highlight
                  // the option the agent's result says was chosen.
                  const picked = (picks[qi]?.has(oi) ?? false) && livePending
                  const chosen = livePending ? picked : isChosen(o.label)
                  const body = (
                    <>
                      <span className="font-medium text-foreground">
                        {chosen ? '✓ ' : livePending ? `${oi + 1}. ` : ''}
                        {o.label}
                      </span>
                      {o.description && (
                        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground/80">
                          {o.description}
                        </span>
                      )}
                    </>
                  )
                  const baseCls = cn(
                    'rounded-md border px-2.5 py-1.5 text-left text-xs',
                    chosen
                      ? 'border-primary/50 bg-primary/[0.08] text-foreground'
                      : 'border-border text-muted-foreground',
                  )
                  // Only the live pending card gets clickable controls; everything
                  // else stays a plain read-only row.
                  return livePending ? (
                    <button
                      key={`${o.label}-${oi}`}
                      type="button"
                      disabled={locked}
                      onClick={() => onOptionClick(q, qi, oi)}
                      className={cn(
                        baseCls,
                        'transition-colors',
                        locked
                          ? 'cursor-default'
                          : 'cursor-pointer hover:border-primary/60 hover:bg-primary/[0.12]',
                      )}
                    >
                      {body}
                    </button>
                  ) : (
                    <div key={`${o.label}-${oi}`} className={baseCls}>
                      {body}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          {needsConfirmButton && (
            <button
              type="button"
              disabled={!allAnswered}
              onClick={() => void submit(picks)}
              className="mt-1 self-start rounded-md border border-primary/50 bg-primary/[0.12] px-3 py-1.5 text-xs font-medium text-foreground hover:bg-primary/20 disabled:cursor-default disabled:opacity-50"
            >
              Submit answer
            </button>
          )}
          {questions.length === 0 && (
            <div className="text-xs text-muted-foreground">AskUserQuestion (unparseable input)</div>
          )}
        </div>
      </div>
    </div>
  )
}

function ToolBlock({
  block,
  cls,
  index,
  sessionId,
  cwd,
  openFile,
}: {
  block: ChatBlock
  cls: string
  index: number
  sessionId: string
  cwd: string
  openFile: (sessionId: string, path: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const { item } = block
  const result = block.result ?? item.toolResult
  // Orphan results render as a bare result row; calls render name + input.
  const label = item.toolName ?? 'result'
  return (
    <div className={cls} data-block={index}>
      {/* No rail for tool rows — they stay quiet */}
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body py-0.5">
        <button
          type="button"
          className="flex w-full min-w-0 items-baseline gap-[7px] py-0.5 text-left text-xs text-muted-foreground"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="flex-none font-mono text-[10px] text-muted-foreground/50">{open ? '▾' : '▸'}</span>
          <span className="flex-none font-mono text-[11px] font-semibold text-muted-foreground/80">{label}</span>
          {item.toolInput && (
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/50">
              {item.toolInput}
            </span>
          )}
        </button>
        {item.toolPaths?.map((p) => (
          <button
            key={p}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              openFile(sessionId, resolveAgainstCwd(cwd, p))
            }}
            className="ml-[17px] inline-flex max-w-full items-center gap-1 truncate rounded border border-input px-[7px] py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            title={`Open ${p}`}
          >
            {p.split('/').pop()}
          </button>
        ))}
        {open && (
          <pre className="my-1 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 px-2.5 py-2 font-mono text-[11px] text-muted-foreground">
            {result ?? '(no result captured)'}
          </pre>
        )}
      </div>
    </div>
  )
}

/**
 * Birds-eye strip: one tick per block, absolutely positioned by real DOM offsets
 * so ticks, the viewport box, and click-to-scroll all share one linear scroll
 * coordinate space (ratios of scrollHeight). User prompts pop in accent so
 * "where did I steer" reads at a glance. Click or drag to scrub.
 */
function Minimap({
  blocks,
  scrollerRef,
}: {
  blocks: ChatBlock[]
  scrollerRef: React.RefObject<HTMLDivElement | null>
}): JSX.Element | null {
  const [ticks, setTicks] = useState<MinimapTick[]>([])
  const [viewport, setViewport] = useState({ top: 0, height: 1 })
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)

  // Re-measure DOM offsets after scroll, resize, or block list change.
  // We use rAF so the browser has laid out before we read offsetTop/offsetHeight.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    let rafId: number | undefined

    const measure = () => {
      const total = el.scrollHeight || 1
      setViewport({ top: el.scrollTop / total, height: el.clientHeight / total })
      const offsets = measureBlockOffsets(el)
      setTicks(ticksFromOffsets(blocks, offsets))
    }

    const schedMeasure = () => {
      if (rafId !== undefined) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(measure)
    }

    schedMeasure()
    el.addEventListener('scroll', schedMeasure, { passive: true })
    const ro = new ResizeObserver(schedMeasure)
    ro.observe(el)
    return () => {
      if (rafId !== undefined) cancelAnimationFrame(rafId)
      el.removeEventListener('scroll', schedMeasure)
      ro.disconnect()
    }
  }, [scrollerRef, blocks])

  // Map a pointer Y on the strip to a scroll position, centring the viewport on
  // the pointer — so a click jumps there and a drag scrubs continuously.
  const scrubTo = (clientY: number) => {
    const el = scrollerRef.current
    const track = trackRef.current
    if (!el || !track) return
    const r = track.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientY - r.top) / (r.height || 1)))
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    el.scrollTop = Math.max(0, Math.min(max, f * el.scrollHeight - el.clientHeight / 2))
  }

  if (blocks.length < 2) return null
  return (
    // The whole strip is the scrub surface; ticks are non-interactive colour
    // guides (pointer-events-none) so clicks/drags reach the track.
    <div
      ref={trackRef}
      className="relative my-1 mr-[3px] flex-[0_0_14px] cursor-pointer touch-none overflow-hidden rounded-[3px] bg-foreground/[0.04]"
      role="presentation"
      onPointerDown={(e) => {
        e.preventDefault()
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        scrubTo(e.clientY)
      }}
      onPointerMove={(e) => {
        if (dragging.current) scrubTo(e.clientY)
      }}
      onPointerUp={() => {
        dragging.current = false
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
    >
      {ticks.map((tick) => (
        <div
          key={tick.index}
          className={cn(
            'pointer-events-none absolute inset-x-0 min-h-[2px]',
            // Priority of attention: user prompts > final answer > agent prose > tool/system.
            tick.role === 'user'
              ? 'bg-blue-500'
              : tick.answer
                ? 'bg-emerald-500'
                : tick.role === 'assistant'
                  ? 'bg-foreground/20'
                  : 'bg-foreground/[0.08]',
          )}
          style={{
            top: `${tick.top * 100}%`,
            height: `${Math.max(0.004, tick.height) * 100}%`,
          }}
        />
      ))}
      <div
        className="pointer-events-none absolute inset-x-0 rounded-[2px] border border-foreground/35 bg-foreground/15"
        style={{
          top: `${viewport.top * 100}%`,
          height: `${Math.max(0.04, viewport.height) * 100}%`,
        }}
      />
    </div>
  )
}
