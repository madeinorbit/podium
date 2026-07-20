import { randomUUID } from '@podium/client-core/id'
import { shallowEqual } from '@podium/client-core/store'
import { buildImagePrompt, MACHINE_CONTEXT_RE } from '@podium/client-core/viewmodels'
import type { HeadlessActivityEvent } from '@podium/protocol'
import {
  ArrowDownToLine,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Clock,
  CloudOff,
  Image as ImageIcon,
  Mic,
  Paperclip,
  ScrollText,
  Square,
  X,
} from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { BlockCaret } from '@/lib/BlockCaret'
import { chatActivity } from '@/lib/derive'
import { useIsMobile } from '@/lib/hooks/use-is-mobile'
import { renderMarkdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import { useVoiceInput } from '@/lib/voice'
import { ChatBlockView } from './ChatBlockView'
import { blockMatches, type PendingItem, reconcilePending, searchBlocks } from './chat'
import { hasImageItems } from './image-items'
import { Minimap } from './Minimap'
import { OfferBar } from './OfferBar'
import { SinceStopTimer } from './SinceStopTimer'
import { ToolBatchView } from './ToolBatchView'
import { RENDER_WINDOW, useTranscriptWindow } from './useTranscriptWindow'

/**
 * Claude-app-style chat rendering of a session's structured transcript, with a
 * native write-through input, quick transcript search, and a Sublime-style
 * birds-eye minimap (user prompts highlighted; click scrolls).
 *
 * Arbitrary-length sessions: only a bounded tail of blocks is rendered at once;
 * scrolling toward the top first reveals more locally-held blocks, then autoloads
 * older pages straight off disk (a cursor-anchored sessions.transcriptRead) and
 * prepends them while preserving the scroll position. Live tailing (cursor-merged
 * deltas + auto-scroll-to-bottom) is unchanged.
 *
 * The rendering pieces (block dispatch, tool batching, the ask-question card,
 * the minimap, …) live under ./chat/ as their own components; the pure
 * formatters/predicates they and this file share live in
 * @podium/client-core/viewmodels (presentation-pure, shared with mobile where
 * the concept applies).
 */

type Attachment = {
  id: string
  name: string
  previewUrl: string
  path?: string
  state: 'uploading' | 'ready' | 'failed'
}

/** The superagent thread an embedded (headless) ChatView fronts: sends route to
 *  superagent.sendTurn / conciergeTurn instead of sessions.sendText. */
export interface SuperThreadRef {
  threadId: string
  kind: 'global' | 'btw' | 'concierge'
  repoPath?: string
}

export function ChatView({
  sessionId,
  active = true,
  superThread,
  compact = false,
}: {
  sessionId: string
  /** False when this panel is mounted but hidden (keep-mounted deck). On
   *  becoming active (true) the view snaps to the bottom if still pinned. */
  active?: boolean
  /** Present when this ChatView is embedded in the superagent panel over a
   *  HEADLESS session — routes sends through the superagent turn mutations. */
  superThread?: SuperThreadRef
  /** Narrow-dock mode (the superagent side panel): hides the search header,
   *  minimap + tl;dr. */
  compact?: boolean
}): JSX.Element {
  const {
    hub,
    trpc,
    replica,
    sessions,
    drafts,
    setSessionDraft,
    resumeAndSend,
    openFile,
    httpOrigin,
    tldrSession,
    getUserFocus,
  } = useStoreSelector(
    (s) => ({
      hub: s.hub,
      trpc: s.trpc,
      replica: s.replica,
      sessions: s.sessions,
      drafts: s.drafts,
      setSessionDraft: s.setSessionDraft,
      resumeAndSend: s.resumeAndSend,
      openFile: s.openFile,
      httpOrigin: s.httpOrigin,
      tldrSession: s.tldrSession,
      getUserFocus: s.getUserFocus,
    }),
    shallowEqual,
  )
  const session = sessions.find((s) => s.sessionId === sessionId)
  const cwd = session?.cwd ?? '/'
  // HEADLESS mode (concierge unification): a superagent thread's harness session
  // with no PTY. Sends route through superagent turn mutations, the working
  // indicator follows turn-start/turn-end frames (not PTY-derived agent state),
  // and mid-turn partial text streams into an overlay row below the transcript.
  const headless = session?.headless === true
  // True while a headless turn runs (turn-start → turn-end).
  const [turnRunning, setTurnRunning] = useState(false)
  // Streaming overlay: cumulative partial assistant text, or a status label
  // ("running Bash…"), whichever the driver last reported. Null = no overlay.
  const [overlay, setOverlay] = useState<{ text?: string; status?: string } | null>(null)
  // sendTurn rejection / turn error, surfaced inline above the composer.
  const [turnError, setTurnError] = useState<string | null>(null)
  useEffect(() => {
    setTurnRunning(false)
    setOverlay(null)
    setTurnError(null)
    if (!headless) return
    // Optional-chained: older hub fakes in tests don't implement it.
    return hub.subscribeHeadless?.(sessionId, (event: HeadlessActivityEvent) => {
      switch (event.kind) {
        case 'turn-start':
          setTurnRunning(true)
          setOverlay(null)
          setTurnError(null)
          break
        case 'turn-end':
          setTurnRunning(false)
          setOverlay(null)
          if (event.error) setTurnError(event.error)
          break
        case 'partial-text':
          setTurnRunning(true)
          setOverlay({ text: event.text })
          break
        case 'status':
          setTurnRunning(true)
          setOverlay((prev) => ({
            // Keep any streamed text visible; the status rides under it.
            ...(prev?.text !== undefined ? { text: prev.text } : {}),
            status:
              event.status === 'tool'
                ? `running ${event.label ?? 'a tool'}…`
                : event.status === 'starting'
                  ? 'starting…'
                  : 'working…',
          }))
          break
      }
    })
  }, [hub, sessionId, headless])
  // Full-screen image preview (SendUserFile / image tags), null when closed.
  const [lightbox, setLightbox] = useState<string | null>(null)
  // Whether the last user prompt is stuck to the top (scrolled up past it).
  const [showStickyUser, setShowStickyUser] = useState(false)
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
  // Agent action offer [spec:SP-c7f1]: the offer bar hides optimistically the
  // moment a button is clicked (its prompt goes out as a turn, which the server
  // then clears). Keyed by the offer's createdAt so a NEW offer re-shows. */
  const [dismissedOfferAt, setDismissedOfferAt] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // The held transcript window (an initial disk read + live-delta subscription
  // + scroll-up back-paging) and its derived render pipeline — see
  // useTranscriptWindow for the data/paging concerns this owns. Scroll DOM
  // itself (onScroll, the sticky-user header, scrollTop writes) stays here,
  // coordinated through the refs it hands back.
  const {
    blocks,
    rows,
    visibleRows,
    renderStart,
    moreAbove,
    loadingOlder,
    initialLoaded,
    offlineAsOf,
    loadOlder,
    setRenderCount,
    pinnedToBottom,
    didInitialScroll,
    prependAnchor,
  } = useTranscriptWindow({ sessionId, hub, trpc, replica, active, session, scrollerRef })
  // The single AskUserQuestion the user can answer right now: the LAST one in the
  // transcript that hasn't been answered yet (no paired tool result), and only
  // when the session is live so a digit can actually reach the native menu.
  // Every other AskUserQuestion card stays read-only with its chosen-option
  // highlight. AskUserQuestion is never folded into a tools batch (isBatchableTool
  // excludes it), so it is always its own block-row; index into `blocks` and match
  // it against each SingleRow's blockIndex when rendering.
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
  // The most recent user prompt (block index → sticky header that keeps it in
  // view while reading the answer; text → tl;dr context) and the latest answer.
  const lastUserBlockIndex = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const it = blocks[i]?.item
      if (!it || it.role !== 'user' || it.event === 'interrupt' || !it.text.trim()) continue
      // Headless: machine-authored context blocks render collapsed — they are
      // not "the user's last prompt" for the sticky header / tl;dr context.
      if (headless && MACHINE_CONTEXT_RE.test(it.text)) continue
      return i
    }
    return -1
  }, [blocks, headless])
  const lastUserText = lastUserBlockIndex >= 0 ? (blocks[lastUserBlockIndex]?.item.text ?? '') : ''
  const lastAnswerText = useMemo(() => {
    let answer = ''
    for (const b of blocks)
      if (b.item.role === 'assistant' && b.item.text.trim()) answer = b.item.text
    return answer
  }, [blocks])
  // Show the loader (not the empty-state copy) until the initial read resolves.
  // Once it has resolved with zero blocks we trust the feed is genuinely empty and
  // show the "No transcript yet" copy. Uniform across live/parked.
  const loadingTranscript = blocks.length === 0 && session !== undefined && !initialLoaded
  const matches = useMemo(() => searchBlocks(blocks, query), [blocks, query])
  const activeMatch = matches.length > 0 ? matches[matchCursor % matches.length] : undefined
  // Search runs per block (so a hit inside a collapsed batch is still found); map
  // a matched block to the row that renders it, to scroll to and auto-expand it.
  const blockToRow = useMemo(() => {
    const m = new Map<number, number>()
    rows.forEach((row, ri) => {
      if (row.kind === 'tools') for (const bi of row.blockIndices) m.set(bi, ri)
      else m.set(row.blockIndex, ri)
    })
    return m
  }, [rows])
  const activeRow = activeMatch !== undefined ? blockToRow.get(activeMatch) : undefined

  // A mobile AgentPanel reuses one ChatView instance across sessions (it isn't
  // keyed by sessionId like the desktop tabs are), so reset per-session local UI
  // state on a session switch — otherwise a stale optimistic bubble or "Sending…"
  // row from the previous session bleeds into the newly selected one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on session switch
  useEffect(() => {
    setPending([])
    setJustSent(false)
    seenUserIds.current = new Set()
    // The transcript window itself (items/older/headCursor/initialLoaded, the
    // scroll pins, and the render window/loader) resets on the same trigger
    // inside useTranscriptWindow — this effect only clears the local
    // pending/optimistic UI state that hook doesn't own.
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
      // Headless: the server prepends machine context (seed/delta blocks) to the
      // delivered turn text, so the echoed user item rarely equals the optimistic
      // bubble verbatim — any new user item means the send landed; drop them all.
      if (headless) setPending([])
      else setPending((p) => (p.length === 0 ? p : reconcilePending(p, newUserTexts)))
    }
  }, [blocks, headless])

  // Headless overlay lifecycle: the streamed partial text is a preview of the
  // assistant item that will land via the transcript tail — whenever new items
  // arrive, clear the accumulated text (turn-end clears the whole overlay).
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear on transcript growth
  useEffect(() => {
    if (!headless) return
    setOverlay((o) => (o?.text !== undefined ? (o.status ? { status: o.status } : null) : o))
  }, [blocks.length, headless])

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: pinnedToBottom is a stable ref from useTranscriptWindow, not app state
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

  const onScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinnedToBottom.current = near
    setAtBottom(near)
    recomputeStickyUser()
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

  // Sticky last-user header: keep the latest prompt pinned at the top while
  // reading the answer below it. Show it ONLY once it has scrolled out the TOP of
  // the viewport (you scrolled down toward newer content). If it's still visible,
  // or scrolled out the BOTTOM (you scrolled up toward older content), hide it.
  const recomputeStickyUser = () => {
    const el = scrollerRef.current
    if (!el || lastUserBlockIndex < 0) {
      setShowStickyUser(false)
      return
    }
    const node = el.querySelector<HTMLElement>(`[data-block="${lastUserBlockIndex}"]`)
    if (!node) {
      setShowStickyUser(false)
      return
    }
    const top = el.getBoundingClientRect().top
    setShowStickyUser(node.getBoundingClientRect().bottom <= top + 1)
  }
  // Re-evaluate stickiness when the list grows (new answer pushes the prompt up
  // while pinned to bottom) or the active prompt changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute on list/prompt change
  useEffect(() => {
    recomputeStickyUser()
  }, [blocks.length, lastUserBlockIndex, active])

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
    if (activeRow === undefined) return
    if (activeRow < renderStart) {
      // The matched row sits above the rendered window. Reveal enough trailing
      // rows to cover it, then scroll a frame later once its node has mounted (no
      // scroll-anchor — this is an explicit jump, not a position-preserving prepend).
      setRenderCount(rows.length - activeRow + RENDER_WINDOW)
      requestAnimationFrame(() => scrollToBlock(activeRow))
    } else {
      scrollToBlock(activeRow)
    }
  }, [activeRow])

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
    setPending((p) => [
      ...p,
      {
        id,
        text: fullText,
        at: Date.now(),
        state: 'sending',
        tags: tags.length > 0 ? tags : undefined,
      },
    ])
    setJustSent(true)
    try {
      // Headless superagent thread → route through the turn mutations; output
      // arrives via the transcript tail + headlessActivity frames. Rejections
      // (turn already running / terminal lock) surface inline.
      if (headless && superThread) {
        setTurnError(null)
        try {
          // Every turn carries what the user has on screen (#225), so the
          // orchestrator can resolve "this session"/"this issue" without asking.
          const focus = getUserFocus()
          if (superThread.kind === 'concierge' && superThread.repoPath) {
            await trpc.superagent.concierge.mutate({
              repoPath: superThread.repoPath,
              text: fullText,
              focus,
            })
          } else {
            await trpc.superagent.sendTurn.mutate({
              threadId: superThread.threadId,
              text: fullText,
              focus,
            })
          }
        } catch (e) {
          setTurnError(e instanceof Error ? e.message : String(e))
          throw e
        }
        return
      }
      // Live → send straight through (NOT outboxed: live chat must fail fast when
      // offline). The mutationId only makes an ambiguous retry replay-safe.
      // Parked but recoverable → wake it and let the server deliver the text once
      // the resumed CLI is ready.
      if (session?.status === 'live' || session?.status === 'starting') {
        await trpc.sessions.sendText.mutate({
          sessionId,
          text: fullText,
          mutationId: randomUUID(),
        })
      } else {
        await resumeAndSend(sessionId, fullText)
      }
    } catch {
      setPending((p) => p.map((x) => (x.id === id ? { ...x, state: 'failed' } : x)))
    }
  }

  // Agent action offer [spec:SP-c7f1]: clicking an offer button sends its
  // agent-authored prompt as a normal user turn (reusing the sendText path, so
  // the server auto-clears the offer). Optimistically hide the bar immediately.
  const sendOfferPrompt = async (prompt: string, offerAt: string) => {
    setDismissedOfferAt(offerAt)
    const id = `pending-${++pendingSeq.current}`
    setPending((p) => [...p, { id, text: prompt, at: Date.now(), state: 'sending' }])
    setJustSent(true)
    pinnedToBottom.current = true
    setAtBottom(true)
    try {
      if (session?.status === 'live' || session?.status === 'starting') {
        await trpc.sessions.sendText.mutate({ sessionId, text: prompt, mutationId: randomUUID() })
      } else {
        await resumeAndSend(sessionId, prompt)
      }
    } catch {
      setPending((p) => p.map((x) => (x.id === id ? { ...x, state: 'failed' } : x)))
      setDismissedOfferAt(null) // send failed — let the offer reappear
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
  // Headless: PTY status is meaningless — the composer is open whenever no turn
  // is running (a turn is one queued unit; the server rejects overlap anyway).
  const composerEnabled = headless ? !turnRunning : sendable || canResume
  // Durable server-held messages waiting to be typed into the agent when it's
  // back (SessionMeta.queuedMessageCount, live via the sessions subscription) —
  // the honest state behind the optimistic pending bubbles.
  const queuedCount = session?.queuedMessageCount ?? 0
  // Agent action offer [spec:SP-c7f1]: the live offer for this session, unless
  // it was just consumed by a button click (optimistic hide until the server's
  // cleared meta arrives). Not shown for headless superagent threads.
  const offer =
    !headless && session?.offer && session.offer.createdAt !== dismissedOfferAt
      ? session.offer
      : null
  // Headless: the working indicator follows turn boundaries, not PTY-derived
  // agent state (there is no PTY). The overlay row carries the detail.
  const activity = headless
    ? turnRunning
      ? { label: 'Working…', tone: 'working' as const }
      : justSent
        ? { label: 'Sending…', tone: 'working' as const }
        : null
    : chatActivity(session, justSent)

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

  // The composer's action cluster (stop / attach / voice / send). Compact
  // (superagent dock) renders it INLINE on the input row with small plain
  // icons — the mock's composer is a single ~36px-high row — while the regular
  // chat composer keeps its own bottom row with the round primary send button.
  const composerActions = (
    <div
      className={cn(
        'flex items-center',
        compact ? 'flex-none gap-0.5 self-end' : 'justify-end gap-1',
      )}
    >
      {headless && turnRunning && superThread && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            'rounded-full text-destructive hover:bg-transparent hover:text-destructive',
            compact
              ? "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5"
              : "[&_svg:not([class*='size-'])]:size-4",
          )}
          title="Stop this turn"
          onClick={() => {
            trpc.superagent.interruptTurn
              .mutate({ threadId: superThread.threadId })
              .catch((e: unknown) => setTurnError(e instanceof Error ? e.message : String(e)))
          }}
        >
          <Square size={16} aria-hidden="true" />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          'rounded-full text-muted-foreground hover:bg-transparent hover:text-foreground',
          compact
            ? "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5"
            : "[&_svg:not([class*='size-'])]:size-4",
        )}
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
            'rounded-full text-muted-foreground hover:bg-transparent hover:text-foreground',
            compact
              ? "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5"
              : "[&_svg:not([class*='size-'])]:size-4",
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
        variant={compact ? 'ghost' : 'default'}
        className={cn(
          compact
            ? "size-6 rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground disabled:bg-transparent disabled:opacity-40 [&_svg:not([class*='size-'])]:size-3.5"
            : "rounded-full bg-primary text-primary-foreground hover:bg-primary/80 disabled:bg-secondary disabled:text-muted-foreground/70 disabled:opacity-100 [&_svg:not([class*='size-'])]:size-4",
        )}
        disabled={
          !composerEnabled ||
          (!draft.trim() && attachments.length === 0) ||
          attachments.some((a) => a.state === 'uploading')
        }
        title="Send (⌘/Ctrl+Enter)"
        onClick={() => void send()}
      >
        <ArrowUp size={16} aria-hidden="true" />
      </Button>
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Search + tl;dr header — hidden in the compact superagent dock
          (engraved-column.md §2.5: bar → feed → composer, no extra chrome). */}
      {!compact && (
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
          {/* tl;dr — open this session's BTW superagent thread and ask for a concise
            summary of the agent's last answer (seeded with the answer + context). */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto flex-none gap-1 px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            title="tl;dr — summarize the last answer via the superagent"
            disabled={!lastAnswerText}
            onClick={() => void tldrSession(sessionId, lastAnswerText)}
          >
            <ScrollText size={13} aria-hidden="true" /> tl;dr
          </Button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        {/* Sticky last-user prompt: stays pinned at the top while reading the
            answer once it has scrolled out the top of the view. Click to jump. */}
        {showStickyUser && lastUserText && (
          <button
            type="button"
            onClick={() => scrollToBlock(lastUserBlockIndex)}
            title="Jump to this message"
            className="absolute top-0 right-[18px] left-0 z-[3] flex items-start gap-2 border-b border-border bg-card/95 px-5 py-1.5 text-left backdrop-blur supports-[backdrop-filter]:bg-card/80"
          >
            <span className="mt-px flex-none text-[10px] font-semibold tracking-[0.06em] text-blue-500 uppercase">
              You
            </span>
            <span className="line-clamp-2 min-w-0 flex-1 text-xs whitespace-pre-wrap text-muted-foreground">
              {lastUserText}
            </span>
          </button>
        )}
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
          {/* Top sentinel: only the bounded tail of ROWS is mounted; more exist
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
          {visibleRows.map((row, ri) => {
            // Absolute row index into `rows` so the minimap/search (activeRow) and
            // [data-block] line up with the full loaded list, not just the window.
            const idx = renderStart + ri
            return row.kind === 'tools' ? (
              <ToolBatchView
                // A tools row always folds ≥1 block, so [0] and blocks[bi] exist.
                key={`${idx}-${row.blocks[0]!.item.id}`}
                row={row}
                index={idx}
                highlighted={idx === activeRow}
                forceOpen={idx === activeRow}
                dimmed={
                  query.trim() !== '' &&
                  !row.blockIndices.some((bi) => blockMatches(blocks[bi]!, query))
                }
                sessionId={sessionId}
                cwd={cwd}
                openFile={openFile}
              />
            ) : (
              <ChatBlockView
                key={`${idx}-${row.block.item.id}`}
                block={row.block}
                index={idx}
                highlighted={idx === activeRow}
                dimmed={query.trim() !== '' && !blockMatches(row.block, query)}
                sessionId={sessionId}
                cwd={cwd}
                openFile={openFile}
                httpOrigin={httpOrigin}
                onOpenImage={setLightbox}
                // AskUserQuestion is its own block-row; light up the one that is the
                // latest unanswered question on a live session (livePendingAskIndex
                // indexes into `blocks`, matched here against the row's blockIndex).
                askLivePending={row.blockIndex === livePendingAskIndex}
                onAnswerAsk={answerAsk}
                collapseContext={headless}
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
                  {p.state === 'sending' && <span className="transcript-meta">sending…</span>}
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
          {/* Headless streaming overlay: the in-progress assistant text (or the
              driver's status label) below the last transcript row. Replaced by
              the real item when it lands via the transcript tail; cleared on
              turn-end. Native sessions never emit these frames. */}
          {headless && overlay && (
            <div className="transcript-row mx-auto w-full max-w-[960px]" data-headless-overlay>
              <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
              <div className="transcript-body">
                {overlay.text !== undefined && (
                  <div
                    className="chat-md opacity-80"
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(overlay.text) }}
                  />
                )}
                {overlay.status && (
                  <div className="mt-1 text-xs text-muted-foreground italic">{overlay.status}</div>
                )}
              </div>
            </div>
          )}
          {activity && (
            <div
              role="status"
              aria-live="polite"
              className={cn(
                // Match the shared status palette: working → the theme's live
                // hue, needs-you → warning, everything else muted.
                'mx-auto flex w-full max-w-[960px] items-center gap-2 py-3 pl-[calc(3px+12px)] text-xs',
                activity.tone === 'attention'
                  ? 'text-warning'
                  : activity.tone === 'working'
                    ? 'text-live'
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
          {/* General live timer since the agent last stopped — shown when it's
              idle (no active working/attention indicator). */}
          {!activity && session?.agentState?.since && (
            <SinceStopTimer since={session.agentState.since} />
          )}
        </div>
        {/* Minimap maps the RENDERED window (visibleRows), so its segments line
            up with the scrollable content. For a very long transcript that means
            it reflects the loaded/visible tail, not the entire on-disk history;
            scrolling up to page in older items extends what it covers. */}
        {!compact && <Minimap rows={visibleRows} scrollerRef={scrollerRef} />}
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
        // Bottom inset only when the keyboard is CLOSED. With it open (iOS), the home-
        // indicator safe area sits behind the keyboard, so keeping that padding just
        // leaves a dead gap above the keyboard under the composer. --kb-open (0/1) is
        // set from visualViewport by the shell when a soft keyboard is tracked.
        className={cn(
          'border-t border-border px-3 pt-2.5 pb-[calc(10px+(1-var(--kb-open,0))*env(safe-area-inset-bottom,0px))]',
          // The superagent dock composer mirrors the native Claude Code prompt
          // box: mono, CLI `>` prefix, flat background.
          compact ? 'bg-background px-3.5 font-mono' : 'bg-card',
        )}
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
        {/* Agent action offer bar [spec:SP-c7f1]: the agent's suggested next
            actions, shown only while an offer exists for this session. The
            message sits above compact buttons; a click sends the button's
            predefined prompt as a normal turn (and clears the offer). */}
        {offer && (
          <div className="mb-2">
            <OfferBar
              offer={offer}
              disabled={!composerEnabled}
              onAction={(prompt, offerAt) => void sendOfferPrompt(prompt, offerAt)}
            />
          </div>
        )}
        {queuedCount > 0 && (
          <div className="flex items-center gap-1.5 pb-1.5 text-[11px] text-muted-foreground">
            <Clock size={12} aria-hidden="true" />
            {queuedCount === 1 ? '1 message queued' : `${queuedCount} messages queued`} — delivers
            when the agent is back
          </div>
        )}
        {turnError !== null && (
          <div className="flex items-center gap-1.5 pb-1.5 text-[11px] text-destructive">
            {turnError}
          </div>
        )}
        {offlineAsOf !== null && (
          <div className="flex items-center gap-1.5 pb-1.5 text-[11px] text-muted-foreground">
            <CloudOff size={12} aria-hidden="true" />
            offline copy — as of {new Date(offlineAsOf).toLocaleString()}
          </div>
        )}
        <div
          className={cn(
            'relative flex flex-col gap-0.5 border bg-background focus-within:border-primary',
            compact
              ? 'rounded-lg border-[#3a3a46] px-3 py-1.5'
              : 'rounded-2xl border-input px-2.5 pt-2 pb-1.5',
          )}
        >
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
          {compact && <BlockCaret taRef={taRef} value={draft} />}
          <div className="flex items-start gap-2">
            {compact && (
              <span
                className="flex-none pt-[5px] text-[13px] leading-[1.45] text-[#6c6c78]"
                aria-hidden="true"
              >
                &gt;
              </span>
            )}
            <Textarea
              ref={taRef}
              rows={1}
              placeholder={
                headless
                  ? turnRunning
                    ? 'Working — stop the turn to interject…'
                    : compact
                      ? 'Ask Superagent to plan, delegate, or review — @ for context'
                      : 'Message the agent…'
                  : sendable
                    ? 'Message the agent…'
                    : canResume
                      ? 'Message — resumes the agent…'
                      : 'Session is not running.'
              }
              className={cn(
                'max-h-44 min-h-11 w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0.5 text-sm leading-[1.45] text-foreground transition-none outline-none [field-sizing:fixed] focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100 dark:bg-transparent dark:disabled:bg-transparent',
                compact && 'min-h-0 text-[13px] caret-transparent placeholder:text-[#4d4d59]',
              )}
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
            {compact && composerActions}
          </div>
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
          {!compact && composerActions}
        </div>
        {compact && (
          <div className="flex items-center gap-2 px-1 pt-1.5 text-[10.5px] text-[#4d4d59]">
            <span className="text-[#6c6c78]">⏵⏵ auto-delegate on</span>
            <span>(shift+tab to cycle)</span>
            <span className="ml-auto">? for shortcuts</span>
          </div>
        )}
      </div>
      {lightbox && (
        <button
          type="button"
          aria-label="Close image preview"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setLightbox(null)}
        >
          <X
            size={22}
            aria-hidden="true"
            className="absolute top-4 right-4 text-white/80 hover:text-white"
          />
          {/* biome-ignore lint/a11y/noStaticElementInteractions: stops the backdrop close */}
          <img
            src={lightbox}
            alt="Preview"
            className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </button>
      )}
    </div>
  )
}
