import { randomUUID } from '@podium/client-core/id'
import type {
  ChatBlock,
  ChatSendRoute,
  ComposerState,
  SuperThreadRef,
} from '@podium/client-core/viewmodels'
import { chatSendRoute } from '@podium/client-core/viewmodels'
import type { SessionId, TranscriptItem } from '@podium/model'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Store } from '@/app/store'
import { assertSendAccepted } from '@/lib/assert-send-accepted'
import type { PendingItem, QueuedChatMessage } from './chat'
import { queuedOperatorMessages, reconcilePending } from './chat'
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

export interface UseChatSendOptions {
  sessionId: SessionId
  trpc: Store['trpc']
  resumeAndSend: Store['resumeAndSend']
  getUserFocus: Store['getUserFocus']
  issues: Store['issues']
  headless: boolean
  superThread: SuperThreadRef | undefined
  /** Narrow-dock mode: the arriving answer is labelled with the issue the turn
   *  rode in with. */
  compact: boolean
  active: boolean
  composer: Pick<ComposerState, 'sendable' | 'canResume'>
  /** The signed-in principal's own superagent threads (doc §3.1.6 S2). Undefined
   *  when the client holds no roster — then the server is the only gate. */
  ownThreadIds: ReadonlySet<string> | undefined
  blocks: readonly ChatBlock[]
  session: { agentState?: { phase?: string } | undefined } | undefined
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
  /** True briefly after a send so the working indicator appears before the agent
   *  reports for itself. */
  justSent: boolean
  /** The issue seq the last compact turn rode in with, for the answer's label. */
  ctxSeq: number | null
  /** Send composed text (already image-path-prefixed). Resolves when delivered
   *  or rejected — never throws to the caller. */
  send: (fullText: string, tags?: PendingItem['tags'], toolPaths?: string[]) => Promise<void>
  /** Send an agent-authored offer prompt as a normal turn. Throws on failure so
   *  the offer bar can un-hide itself. */
  sendOfferPrompt: (prompt: string, offerAt: string) => Promise<void>
  /** Optimistic hide of the offer bar, keyed by the offer's createdAt. */
  dismissedOfferAt: string | null
  setDismissedOfferAt: (at: string | null) => void
}

export function useChatSend(opts: UseChatSendOptions): UseChatSendResult {
  const {
    sessionId,
    trpc,
    resumeAndSend,
    getUserFocus,
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
      return
    }
    Promise.resolve()
      .then(() => trpc.messages.ledger.query({ sessionId, limit: 100 }))
      .then((rows) => setQueuedMessages(queuedOperatorMessages(rows, sessionId)))
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

  // A mobile AgentPanel reuses one ChatView instance across sessions (it isn't
  // keyed by sessionId like the desktop tabs are), so reset per-session local UI
  // state on a session switch — otherwise a stale optimistic bubble or "Sending…"
  // row from the previous session bleeds into the newly selected one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on session switch
  useEffect(() => {
    setPending(initialPending())
    setQueuedMessages([])
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
    async (text: string, onQueued: () => void) => {
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
          await headlessTurn.sendTurn(route, text, focus)
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
            mutationId: randomUUID(),
          })
          assertSendAccepted(result)
          if (result.disposition === 'queued' || result.disposition === 'accepted') onQueued()
          refreshQueuedMessages()
          return
        }
        case 'resume':
          // Parked but recoverable → wake it and let the server deliver the text
          // once the resumed CLI is ready.
          await resumeAndSend(sessionId, text)
          return
      }
    },
    [
      route,
      getUserFocus,
      compact,
      issues,
      headlessTurn,
      trpc,
      sessionId,
      refreshQueuedMessages,
      resumeAndSend,
    ],
  )

  const send = useCallback(
    async (fullText: string, tags?: PendingItem['tags'], toolPaths?: string[]) => {
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
        await deliver(fullText, () =>
          setPending((p) => p.map((x) => (x.id === id ? { ...x, state: 'queued' } : x))),
        )
      } catch {
        setPending((p) => p.map((x) => (x.id === id ? { ...x, state: 'failed' } : x)))
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
        await deliver(prompt, () =>
          setPending((p) => p.map((x) => (x.id === id ? { ...x, state: 'queued' } : x))),
        )
      } catch (cause) {
        setPending((p) => p.map((x) => (x.id === id ? { ...x, state: 'failed' } : x)))
        setDismissedOfferAt(null) // send failed — let the offer reappear
        throw cause
      }
    },
    [deliver, pinToBottom],
  )

  return {
    pending,
    queuedMessages,
    justSent,
    ctxSeq,
    send,
    sendOfferPrompt,
    dismissedOfferAt,
    setDismissedOfferAt,
  }
}
