import { randomUUID } from '@podium/client-core/id'
import type {
  ChatBlock,
  ChatSendRoute,
  ComposerState,
  SuperThreadRef,
} from '@podium/client-core/viewmodels'
import { chatSendRoute } from '@podium/client-core/viewmodels'
import { formatAgentError } from '@podium/model/browser'
import type { SessionId, SessionMeta, TranscriptItem } from '@podium/model/browser'
import type { RuntimeAttachmentRef } from '@podium/protocol/daemon'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Store } from '@/app/store'
import { assertSendAccepted } from '@/lib/assert-send-accepted'
import type { DeadLetteredChatMessage, PendingItem, QueuedChatMessage } from './chat'
import {
  deadLetteredOperatorMessages,
  markPendingSendingDelivered,
  markPendingSendingFailed,
  queuedOperatorMessages,
  reconcilePending,
} from './chat'
import type { UseHeadlessTurnResult } from './use-headless-turn'

/**
 * SENDING, AND THE OPTIMISTIC BUBBLES THAT RECONCILE AGAINST THE TRANSCRIPT
 * (POD-405, extracted from ChatView).
 *
 * Three things that only make sense together, so they live together:
 *
 *  - the optimistic "You" bubble a send paints immediately, and its reconciliation
 *    against the echoed user item when the transcript tail catches up;
 *  - the durable ledger rows a busy agent's accepted messages sit in, reloaded so
 *    an accepted message survives a refresh instead of existing only as a bubble;
 *  - the send itself, which routes through {@link chatSendRoute} — one decision,
 *    taken as data before any mutation is composed.
 *
 * RECONCILIATION BEHAVIOUR IS UNCHANGED. The id-diff that detects newly-arrived
 * user blocks, the FIFO consumption of duplicate prompts, the headless
 * drop-them-all rule (the server prepends machine context, so an echoed item
 * rarely equals the bubble verbatim), the 30s settle-to-'sent' grace and the 8s
 * justSent ceiling are all the ones that were inline, moved intact.
 *
 * NO PAYLOAD CARRIES ATTRIBUTION. `sendText` sends `{ sessionId, text,
 * mutationId }`; the turn mutations send `{ threadId | repoPath, text, focus }`.
 * Neither carries actor, owner or origin — per doc §3.1.3 A3 and ADR 3 D7 the
 * authority stamps both halves of the pair from the authenticated transport, and
 * a client that asserted them would be asserting an identity it does not hold.
 * `mutationId` is idempotency, not identity.
 */

function sendFailureText(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message
  if (typeof cause === 'string' && cause.trim()) return cause
  return 'The provider rejected this message.'
}

export interface UseChatSendOptions {
  sessionId: SessionId
  trpc: Store['trpc']
  resumeAndSend: Store['resumeAndSend']
  /** "None of these" — the queued write behind it (POD-1110), taken from the
   *  actions seam rather than composed here, so the dismissal is outboxed. */
  dismissOffer: Store['dismissOffer']
  /** Pins the panel to chat when a send comes from this view — see `deliver`. */
  setPanelMode: Store['setPanelMode']
  getUserFocus: Store['getUserFocus']
  /** "Ask superagent (BTW)" (POD-1069): the session waiting to be digested onto
   *  the next superagent turn, and the way to drop it once it has been. */
  attachedSessionId: Store['attachedSessionId']
  clearAttachedSession: Store['clearAttachedSession']
  issues: Store['issues']
  headless: boolean
  superThread: SuperThreadRef | undefined
  /** Narrow-dock mode: the arriving answer is labelled with the issue the turn
   *  rode in with. */
  compact: boolean
  active: boolean
  composer: Pick<ComposerState, 'sendable' | 'canResume' | 'refusalReason'>
  /** The signed-in principal's own superagent threads (doc §3.1.6 S2). Undefined
   *  when the client holds no roster — then the server is the only gate. */
  ownThreadIds: ReadonlySet<string> | undefined
  blocks: readonly ChatBlock[]
  session: Pick<SessionMeta, 'agentState'> | undefined
  headlessTurn: Pick<UseHeadlessTurnResult, 'sendTurn'>
  /** Re-pin the scroller: a send always follows its own message. */
  pinToBottom: () => void
  /** The first prompt shown optimistically while a freshly-created headless
   *  transcript catches up to the thread/session swap. */
  initialPendingText: string | undefined
}

export interface UseChatSendResult {
  pending: PendingItem[]
  queuedMessages: QueuedChatMessage[]
  failedMessages: DeadLetteredChatMessage[]
  /** True briefly after a send so the working indicator appears before the agent
   *  reports for itself. */
  justSent: boolean
  /** The issue seq the last compact turn rode in with, for the answer's label. */
  ctxSeq: number | null
  /** Send composed text plus out-of-band staged refs. Resolves when delivered
   *  or rejected — never throws to the caller. */
  send: (
    fullText: string,
    tags?: PendingItem['tags'],
    toolPaths?: string[],
    attachments?: readonly RuntimeAttachmentRef[],
  ) => Promise<void>
  /** Send an agent-authored offer prompt as a normal turn. Throws on failure so
   *  the offer bar can un-hide itself. */
  sendOfferPrompt: (prompt: string, offerAt: string) => Promise<void>
  /** Decline the offer outright: clears it for every surface and every viewer,
   *  no turn sent. QUEUED (POD-1110), so it survives an offline gap and needs no
   *  un-hide from the caller — the queued entry paints the offer away and drops
   *  its paint if the write is ever refused. */
  dismissOffer: (offerAt: string) => Promise<void>
  retractQueuedMessage: (id: string) => Promise<void>
  /** Optimistic hide of the offer bar, keyed by the offer's createdAt. */
  dismissedOfferAt: string | null
  setDismissedOfferAt: (at: string | null) => void
}

export function useChatSend(opts: UseChatSendOptions): UseChatSendResult {
  const {
    sessionId,
    trpc,
    resumeAndSend,
    dismissOffer: dismissOfferWrite,
    setPanelMode,
    getUserFocus,
    attachedSessionId,
    clearAttachedSession,
    issues,
    headless,
    superThread,
    compact,
    active,
    composer,
    ownThreadIds,
    blocks,
    session,
    headlessTurn,
    pinToBottom,
    initialPendingText,
  } = opts

  const initialPending = useCallback(
    (): PendingItem[] =>
      initialPendingText
        ? [{ id: 'pending-first-turn', text: initialPendingText, at: Date.now(), state: 'sent' }]
        : [],
    [initialPendingText],
  )
  const [pending, setPending] = useState<PendingItem[]>(initialPending)
  const [queuedMessages, setQueuedMessages] = useState<QueuedChatMessage[]>([])
  const [failedMessages, setFailedMessages] = useState<DeadLetteredChatMessage[]>([])
  const [justSent, setJustSent] = useState(false)
  const [ctxSeq, setCtxSeq] = useState<number | null>(null)
  const [dismissedOfferAt, setDismissedOfferAt] = useState<string | null>(null)
  const pendingSeq = useRef(0)
  // Block ids seen on the previous render — lets us detect *newly arrived* user
  // blocks so a freshly-echoed prompt reconciles its optimistic bubble.
  const seenUserIds = useRef<Set<string>>(new Set())

  // Busy chat sends live in the unified message ledger until the agent reaches
  // its next turn boundary. Reload those durable rows so an accepted message
  // remains visible after refresh instead of existing only as a local bubble.
  const refreshQueuedMessages = useCallback(() => {
    if (headless) {
      setQueuedMessages([])
      setFailedMessages([])
      return
    }
    Promise.resolve()
      .then(() => trpc.messages.ledger.query({ sessionId, limit: 100 }))
      .then((rows) => {
        setQueuedMessages(queuedOperatorMessages(rows, sessionId))
        setFailedMessages(deadLetteredOperatorMessages(rows, sessionId))
      })
      .catch(() => {
        // Transcript/chat remains usable if the optional delivery-ledger read is
        // temporarily unavailable. Keep the last confirmed queued snapshot.
      })
  }, [headless, sessionId, trpc])

  useEffect(() => {
    refreshQueuedMessages()
    if (headless || !active) return
    const timer = setInterval(refreshQueuedMessages, 5_000)
    return () => clearInterval(timer)
  }, [active, headless, refreshQueuedMessages])

  // A local resumeAndSend acknowledgement precedes the authority's ledger row.
  // While that narrow gap exists, poll quickly so the optimistic bubble gains
  // its durable message id (and therefore its Retract action) promptly.
  useEffect(() => {
    if (headless || !active || !pending.some((item) => item.state === 'queued')) return
    const timer = setInterval(refreshQueuedMessages, 1_000)
    return () => clearInterval(timer)
  }, [active, headless, pending, refreshQueuedMessages])

  // A mobile AgentPanel reuses one ChatView instance across sessions (it isn't
  // keyed by sessionId like the desktop tabs are), so reset per-session local UI
  // state on a session switch — otherwise a stale optimistic bubble or "Sending…"
  // row from the previous session bleeds into the newly selected one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on session switch
  useEffect(() => {
    setPending(initialPending())
    setQueuedMessages([])
    setFailedMessages([])
    setJustSent(false)
    seenUserIds.current = new Set()
    // The transcript window itself resets on the same trigger inside
    // useTranscriptWindow — this effect only clears the local pending/optimistic
    // state that hook doesn't own.
  }, [sessionId])

  useEffect(() => {
    const prev = seenUserIds.current
    const next = new Set<string>()
    const newUserItems: TranscriptItem[] = []
    for (const b of blocks) {
      if (b.item.role !== 'user') continue
      next.add(b.item.id)
      if (!prev.has(b.item.id)) newUserItems.push(b.item)
    }
    seenUserIds.current = next
    if (newUserItems.length > 0) {
      // Headless: the server prepends machine context (seed/delta blocks) to the
      // delivered turn text, so the echoed user item rarely equals the optimistic
      // bubble verbatim — any new user item means the send landed; drop them all.
      if (headless) setPending([])
      else setPending((p) => (p.length === 0 ? p : reconcilePending(p, newUserItems)))
    }
  }, [blocks, headless])

  // Once the authority's durable row arrives, let it replace the text-matched
  // optimistic bubble. The server row carries the id retraction needs; keeping
  // the local duplicate instead would leave a visible queued message that could
  // not be acted on.
  useEffect(() => {
    if (queuedMessages.length === 0) return
    setPending((current) => {
      const durableTexts = queuedMessages.map((message) => message.text.trim())
      const next = current.filter((item) => {
        if (item.state !== 'queued') return true
        const index = durableTexts.indexOf(item.text.trim())
        if (index === -1) return true
        durableTexts.splice(index, 1)
        return false
      })
      return next.length === current.length ? current : next
    })
  }, [queuedMessages])

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

  // A terminal provider failure is authoritative for an optimistic bubble that
  // is still in flight. A `sent` bubble has already crossed the send boundary;
  // rewriting it as "not delivered" would lie about a message that arrived.
  useEffect(() => {
    const error =
      session?.agentState?.phase === 'errored' && session.agentState.error?.retryable === false
        ? session.agentState.error
        : undefined
    if (!error) return
    const failure = formatAgentError(error)
    setPending((items) => markPendingSendingFailed(items, failure))
  }, [session?.agentState?.error, session?.agentState?.phase])
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

  const route = useMemo<ChatSendRoute>(
    () =>
      chatSendRoute({
        sessionId,
        headless,
        superThread,
        composer,
        ...(ownThreadIds !== undefined ? { ownThreadIds } : {}),
      }),
    [sessionId, headless, superThread, composer, ownThreadIds],
  )

  /** Deliver `text` along the decided route. Throws on rejection. */
  const deliver = useCallback(
    async (
      text: string,
      onQueued: () => void,
      attachments?: readonly RuntimeAttachmentRef[],
      onDelivered?: () => void,
    ) => {
      // THE SURFACE YOU SENT FROM IS THE SURFACE YOU STAY ON (POD-762).
      //
      // A parked session shows its transcript no matter which mode is persisted
      // — `panelSurface` returns `parked/transcript` without consulting the mode
      // at all, because a stopped process has no PTY to show. The mode is still
      // sitting there, though, and on a desktop it is `native` by default. So the
      // moment the wake landed the surface flipped from `parked` to `live` and
      // the panel swapped the conversation the operator was typing into for a
      // terminal — a view they never asked for, showing a CLI still booting.
      //
      // Sending from the chat composer IS the choice of surface, so record it as
      // one. It is a no-op whenever the panel is already in chat (`setPanelMode`
      // returns early on an unchanged value), which makes the live-session case
      // free; the parked case is the one it exists for. Headless superagent
      // threads are excluded: their "session id" is a thread, not a panel.
      if (route.kind === 'session' || route.kind === 'resume') setPanelMode(sessionId, 'chat')
      if (attachments?.length && route.kind !== 'session') {
        throw new Error('file attachments require a live agent session')
      }
      switch (route.kind) {
        case 'superagent-turn':
        case 'concierge':
        case 'refused': {
          const focus = getUserFocus()
          // Compact label context: remember which issue this turn was answered
          // with, so the arriving answer carries "· POD-x context".
          if (compact && route.kind !== 'refused') {
            setCtxSeq(
              focus.issueId
                ? ((issues ?? []).find((i) => i.id === focus.issueId)?.seq ?? null)
                : null,
            )
          }
          // THE ATTACHMENT IS SPENT BY THE TURN THAT CARRIES IT (POD-1069), and
          // only by a turn that was actually accepted. A rejected send leaves it
          // attached: the operator's question never reached the orchestrator, so
          // silently dropping the session they picked would make the retry a
          // different, weaker question than the one they asked.
          //
          // A `superagent-turn` only. The concierge intake is repo-scoped and has
          // no attachment affordance, and a `refused` route sends nothing at all.
          const attach = route.kind === 'superagent-turn' ? attachedSessionId : null
          // A superagent turn sent while one is running is QUEUED (POD-782), not
          // refused — same affordance the PTY path has had all along, so the
          // bubble says "waiting its turn" rather than sitting in a false
          // "sending" that settles to a lie 30 seconds later.
          const queued = await headlessTurn.sendTurn(route, text, focus, attach ?? undefined)
          if (attach) clearAttachedSession()
          if (queued) onQueued()
          return
        }
        case 'session': {
          // Live → send straight through (NOT outboxed: live chat must fail fast
          // when offline). The mutationId only makes an ambiguous retry replay-safe.
          // HTTP 200 with ok:false is a refused send (dead_letter / unreachable),
          // not success — surface it so offer bars can un-hide (POD-552).
          const result = await trpc.sessions.sendText.mutate({
            sessionId,
            text,
            ...(attachments?.length ? { attachments: [...attachments] } : {}),
            mutationId: randomUUID(),
          })
          assertSendAccepted(result)
          if (result.disposition === 'delivered') onDelivered?.()
          else if (result.disposition === 'queued' || result.disposition === 'accepted') onQueued()
          refreshQueuedMessages()
          return
        }
        case 'resume':
          // Parked but recoverable → wake it and let the server deliver the text
          // once the resumed CLI is ready.
          await resumeAndSend(sessionId, text)
          // QUEUED, not "sending…" (POD-762). The wake is the whole reason this
          // route exists: the text is durably enqueued the moment the mutation is
          // accepted and drains when the PTY binds, which may be a minute later.
          // Leaving the bubble in the in-flight state made a send that WORKED
          // read as one that had stalled, and after the 30s grace it settled to a
          // plain bubble with nothing said at all.
          onQueued()
          // Pull the durable ledger row in now, so the queued message is already
          // server-backed before the operator navigates away — the local bubble
          // does not survive a session switch, and the restored row is what does.
          refreshQueuedMessages()
          return
      }
    },
    [
      route,
      getUserFocus,
      attachedSessionId,
      clearAttachedSession,
      compact,
      issues,
      headlessTurn,
      trpc,
      sessionId,
      refreshQueuedMessages,
      resumeAndSend,
      setPanelMode,
    ],
  )

  const send = useCallback(
    async (
      fullText: string,
      tags?: PendingItem['tags'],
      toolPaths?: string[],
      attachments?: readonly RuntimeAttachmentRef[],
    ) => {
      pinToBottom()
      const id = `pending-${++pendingSeq.current}`
      setPending((p) => [
        ...p,
        {
          id,
          text: fullText,
          at: Date.now(),
          state: 'sending',
          ...(tags && tags.length > 0 ? { tags } : {}),
          ...(toolPaths && toolPaths.length > 0 ? { toolPaths } : {}),
        },
      ])
      setJustSent(true)
      try {
        await deliver(
          fullText,
          () => setPending((p) => p.map((x) => (x.id === id ? { ...x, state: 'queued' } : x))),
          attachments,
          () => setPending((p) => markPendingSendingDelivered(p, id)),
        )
      } catch (cause) {
        const failure = sendFailureText(cause)
        setPending((p) =>
          p.map((x) => (x.id === id ? { ...x, state: 'failed' as const, failure } : x)),
        )
      }
    },
    [deliver, pinToBottom],
  )

  // Agent action offer [spec:SP-c7f1]: clicking an offer button sends its
  // agent-authored prompt as a normal user turn (reusing the send path, so the
  // server auto-clears the offer). Optimistically hide the bar immediately.
  const sendOfferPrompt = useCallback(
    async (prompt: string, offerAt: string) => {
      setDismissedOfferAt(offerAt)
      const id = `pending-${++pendingSeq.current}`
      setPending((p) => [...p, { id, text: prompt, at: Date.now(), state: 'sending' }])
      setJustSent(true)
      pinToBottom()
      try {
        await deliver(
          prompt,
          () => setPending((p) => p.map((x) => (x.id === id ? { ...x, state: 'queued' } : x))),
          undefined,
          () => setPending((p) => markPendingSendingDelivered(p, id)),
        )
      } catch (cause) {
        const failure = sendFailureText(cause)
        setPending((p) =>
          p.map((x) => (x.id === id ? { ...x, state: 'failed' as const, failure } : x)),
        )
        setDismissedOfferAt(null) // send failed — let the offer reappear
        throw cause
      }
    },
    [deliver, pinToBottom],
  )

  /**
   * "None of these" [spec:SP-c7f1], through the OUTBOX since POD-1110.
   *
   * The write is still `sessions.dismissOffer` — it clears the offer for every
   * viewer rather than hiding it in this tab — but it is queued rather than
   * fired direct, so a dismissal made on a dropped connection is sent when the
   * connection returns instead of failing outright. It used to be the one row
   * edit in the app that failed: the bar left on the click and popped back a
   * moment later wearing "Could not dismiss this offer".
   *
   * NO OPTIMISTIC HIDE HERE ANY MORE, and none is needed: the queued entry IS
   * the optimistic apply (#263) and paints the offer away on this session, so the
   * bar leaves on the click, stays gone across a reload while the write waits,
   * and comes BACK by itself if the server ever refuses it definitively. Setting
   * `dismissedOfferAt` as well would defeat that last part — a local hide has no
   * way to learn the write was refused. It stays for the ACTION path, where the
   * hide really is local to the send.
   */
  const dismissOffer = useCallback(
    async (offerAt: string) => {
      await dismissOfferWrite(sessionId, offerAt)
    },
    [dismissOfferWrite, sessionId],
  )

  const retractQueuedMessage = useCallback(
    async (id: string) => {
      const previous = queuedMessages
      setQueuedMessages((messages) => messages.filter((message) => message.id !== id))
      try {
        await trpc.messages.cancel.mutate({ id })
      } catch {
        setQueuedMessages((current) => {
          if (current.some((message) => message.id === id)) return current
          const retracted = previous.find((message) => message.id === id)
          return retracted
            ? [...current, retracted].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
            : current
        })
        refreshQueuedMessages()
      }
    },
    [queuedMessages, refreshQueuedMessages, trpc],
  )

  return {
    pending,
    queuedMessages,
    failedMessages,
    justSent,
    ctxSeq,
    send,
    sendOfferPrompt,
    dismissOffer,
    retractQueuedMessage,
    dismissedOfferAt,
    setDismissedOfferAt,
  }
}
