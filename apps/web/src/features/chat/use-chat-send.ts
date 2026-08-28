import { randomUUID } from '@podium/client-core/id'
import type {
  ChatBlock,
  ChatSendRoute,
  ComposerState,
  SuperThreadRef,
} from '@podium/client-core/viewmodels'
import { chatSendRoute, OPTIMISTIC_SEND_CEILING_MS } from '@podium/client-core/viewmodels'
import { asMutationId } from '@podium/model'
import { formatAgentError } from '@podium/model/browser'
import type { SessionId, TranscriptItem } from '@podium/model/browser'
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
  pairPendingWithQueued,
  reconcileQueued,
  tailAppendedUserItems,
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
 * rarely equals the bubble verbatim) and the 30s settle-to-'sent' grace are all
 * the ones that were inline, moved intact. The optimistic-send window is the one
 * rule that has since changed: it no longer expires on a fixed 8s ceiling but
 * holds until the daemon reports on the new turn — see `agentSince` below.
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
  /** Command-time lookup: issue updates must not subscribe the transcript. */
  getIssueSeq: (issueId: string) => number | null
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
  /** `since` is the watermark the optimistic send is held against — see
   *  {@link OPTIMISTIC_SEND_CEILING_MS}; `offer.createdAt` is what a plain send
   *  retires optimistically, because the server retires it on any user turn.
   *  `agentState.error` is what a terminal provider failure is read from. */
  /** Structural rather than `Pick<SessionMeta, …>`: this hook reads four fields
   *  and its callers include fixtures that build only those, so widening to the
   *  full entity would tighten them for nothing. */
  session:
    | {
        agentState?:
          | {
              phase?: string
              since?: string
              error?: { class: string; retryable: boolean; detail?: string }
            }
          | undefined
        offer?: { createdAt: string } | null | undefined
      }
    | undefined
  headlessTurn: Pick<UseHeadlessTurnResult, 'sendTurn'>
  /** Re-pin the scroller: a send always follows its own message. */
  pinToBottom: () => void
  /** The first prompt shown optimistically while a freshly-created headless
   *  transcript catches up to the thread/session swap. */
  initialPendingText: string | undefined
  /** Tells the host that the seeded first turn now has an authoritative echo,
   *  so it no longer needs to survive ChatView surface remounts. */
  onInitialPendingSettled?: () => void
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
    getIssueSeq,
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
    onInitialPendingSettled,
  } = opts

  const initialPending = useCallback(
    (): PendingItem[] =>
      initialPendingText
        ? [
            {
              id: 'pending-first-turn',
              text: initialPendingText,
              at: Date.now(),
              state: 'sent',
              acceptsAppendedBrief: true,
            },
          ]
        : [],
    [initialPendingText],
  )
  const initialOpenSend = useCallback(
    () =>
      initialPendingText && !headless ? { seq: 0, since: null, queuedBehindTurn: false } : null,
    [headless, initialPendingText],
  )
  const [pending, setPending] = useState<PendingItem[]>(initialPending)
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const [queuedMessages, setQueuedMessages] = useState<QueuedChatMessage[]>([])
  const [failedMessages, setFailedMessages] = useState<DeadLetteredChatMessage[]>([])
  /**
   * THE OPEN SEND, AS STATE RATHER THAN A FLAG (POD-1595 review).
   *
   * `seq` is what makes a second send a genuinely NEW value. A bare boolean set
   * to `true` while already `true` is a no-op — React bails on the identical
   * value, the ceiling effect's deps never change, and its cleanup never runs —
   * so send B inherited send A's timer and the working row expired early, timed
   * from a send the operator had already followed with another. `since` is the
   * daemon observation the row is optimistic AGAINST; see the effect below.
   */
  const [openSend, setOpenSend] = useState<{
    seq: number
    since: string | null
    /** True when the send went into a turn that was ALREADY running. */
    queuedBehindTurn: boolean
  } | null>(initialOpenSend)
  const justSent = openSend !== null
  const [ctxSeq, setCtxSeq] = useState<number | null>(null)
  const [dismissedOfferAt, setDismissedOfferAt] = useState<string | null>(null)
  /** Mirrors {@link dismissedOfferAt} so a send can read it synchronously. Every
   *  write goes through {@link applyDismissedOfferAt}, including the one this
   *  hook hands out, so the two can never drift. */
  const dismissedOfferAtRef = useRef<string | null>(null)
  const applyDismissedOfferAt = useCallback((at: string | null) => {
    dismissedOfferAtRef.current = at
    setDismissedOfferAt(at)
  }, [])
  const pendingSeq = useRef(0)
  const sendSeq = useRef(0)
  // Block ids seen on the previous render — lets us detect *newly arrived* user
  // blocks so a freshly-echoed prompt reconciles its optimistic bubble.
  const seenUserIds = useRef<Set<string>>(new Set())
  // Read at send time rather than closed over: putting `session` in `send`'s
  // deps would rebuild the callback on every meta tick for two strings. Written
  // in an effect and not during render — a render may be thrown away under
  // concurrent rendering, and these must describe what is on screen.
  const latestSince = useRef<string | undefined>(undefined)
  const latestOfferAt = useRef<string | undefined>(undefined)
  const latestPhase = useRef<string | undefined>(undefined)
  useEffect(() => {
    latestSince.current = session?.agentState?.since
    latestPhase.current = session?.agentState?.phase
    latestOfferAt.current = session?.offer?.createdAt
  }, [session?.agentState?.since, session?.agentState?.phase, session?.offer?.createdAt])
  const seenUserTailId = useRef<string | null>(null)
  const userBaselineReady = useRef(false)

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
    setOpenSend(initialOpenSend())
    seenUserIds.current = new Set()
    seenUserTailId.current = null
    userBaselineReady.current = false
    // The transcript window itself resets on the same trigger inside
    // useTranscriptWindow — this effect only clears the local pending/optimistic
    // state that hook doesn't own.
  }, [sessionId])

  useEffect(() => {
    const userItems = blocks.flatMap((block) => (block.item.role === 'user' ? [block.item] : []))
    const prev = seenUserIds.current
    const previousTailId = seenUserTailId.current
    const candidates = tailAppendedUserItems(userItems, previousTailId, userBaselineReady.current)
    if (!userBaselineReady.current) {
      userBaselineReady.current = true
    }
    const newUserItems = candidates.filter((item) => !prev.has(item.id))
    for (const item of userItems) prev.add(item.id)
    seenUserTailId.current = userItems.at(-1)?.id ?? null
    if (newUserItems.length > 0) {
      const before = pendingRef.current
      const seededBefore = before.some((item) => item.id === 'pending-first-turn')
      const seededAfter = headless
        ? false
        : reconcilePending(before, newUserItems).some(
            (item) => item.id === 'pending-first-turn',
          )
      // Headless: the server prepends machine context (seed/delta blocks) to the
      // delivered turn text, so the echoed user item rarely equals the optimistic
      // bubble verbatim — any new user item means the send landed; drop them all.
      if (headless) setPending([])
      else {
        setPending((p) => (p.length === 0 ? p : reconcilePending(p, newUserItems)))
        setQueuedMessages((q) => (q.length === 0 ? q : reconcileQueued(q, newUserItems)))
      }
      if (seededBefore && !seededAfter) onInitialPendingSettled?.()
    }
  }, [blocks, headless, onInitialPendingSettled])

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
  /**
   * THE OPTIMISTIC SEND ENDS WHEN THE DAEMON SPEAKS, NOT ON A GUESS (POD-1595).
   *
   * This used to clear on `phase === 'working'` or an 8-SECOND ceiling, and the
   * ceiling was doing the work far more often than the phase was. A prompt
   * carrying three large attachments does not reach a `working` observation for
   * ten or fifteen seconds — the harness is still reading the files — so the
   * optimistic row expired at 8s into a gap, the tail fell back to the previous
   * turn's verdict (or to nothing at all), and the real working row then arrived
   * a beat later. Three states where there should have been one continuous one,
   * which is exactly the flicker this issue is about.
   *
   * `agentState.since` is the ISO stamp of the last PHASE CHANGE, so "has the
   * daemon reported anything about the turn I just sent?" is answerable exactly:
   * capture `since` at send time and watch for it to move. Any new phase moves
   * it — `working`, but equally `needs_user` for a permission ask raised three
   * seconds in — so the real state always takes the row the moment it exists,
   * and never one frame before.
   *
   * A VALUE COMPARISON AND NOT A CLOCK ONE, deliberately. `since` is stamped on
   * the machine the agent runs on and read in a browser that may be on another
   * one; comparing it against `Date.now()` would make a few seconds of clock
   * skew decide whether the row is right, in one direction or the other. Whether
   * the string CHANGED is skew-free.
   *
   * The ceiling stays as a backstop for a session that reports nothing at all
   * (an uninstrumented kind whose `busy` never rises, a hook channel that died),
   * and is raised to match the pending bubble's own 30s settle above: while the
   * bubble still says the message is going, the tail agrees with it.
   */
  const agentSince = session?.agentState?.since
  const agentPhase = session?.agentState?.phase
  useEffect(() => {
    if (openSend === null) return
    if ((agentSince ?? null) !== openSend.since) {
      // A SEND MADE INTO A RUNNING TURN IS A QUEUED ONE, and the first phase
      // change it sees is that turn ENDING — not the daemon saying anything
      // about the message still waiting behind it. Closing on it dropped the
      // tail back onto the finished turn's parting verdict ("todos open", or a
      // question the queued prompt is about to answer) underneath a prompt that
      // had not been picked up yet: precisely the stale frame this issue is
      // about, one turn boundary further along. So re-arm against the new
      // observation and spend the flag; the NEXT move is the one about us.
      // ...and only when it ended QUIETLY. `idle` is the turn finishing; every
      // other phase is the daemon saying something the operator needs more than
      // they need our receipt. A `needs_user` here is the running turn raising a
      // permission ask mid-flight — the commonest thing that happens in this
      // product — and holding "Sending" over it would re-create, for queued
      // sends, the very regression the mobile half of this change was about.
      // `errored` and `ended` likewise: the turn our message was queued behind
      // did not finish, so the news is theirs, not ours.
      if (openSend.queuedBehindTurn && agentPhase === 'idle') {
        setOpenSend({ ...openSend, since: agentSince ?? null, queuedBehindTurn: false })
        return
      }
      setOpenSend(null)
      return
    }
    // NO CEILING WHILE THE TURN WE ARE QUEUED BEHIND IS VISIBLY RUNNING. The
    // ceiling exists for a session saying NOTHING; one reporting `working` is
    // saying plenty, just about the turn ahead of ours. Counting down against it
    // closed the window unseen — the badge outranks the optimistic row while the
    // agent works, so nothing on screen changed — and then handed the turn
    // boundary back to the stale verdict. Agent turns routinely outlast 30s, so
    // this was not an edge case; it made the queued-send fix inert.
    if (openSend.queuedBehindTurn && (agentPhase === 'working' || agentPhase === 'compacting')) {
      return
    }
    const t = setTimeout(() => setOpenSend(null), OPTIMISTIC_SEND_CEILING_MS)
    return () => clearTimeout(t)
  }, [openSend, agentSince, agentPhase])

  /** Open the optimistic window, and record what the tail is optimistic AGAINST.
   *  Always a fresh value, so a second send re-arms the ceiling rather than
   *  inheriting the first one's. */
  const markSent = useCallback((): number => {
    const seq = ++sendSeq.current
    setOpenSend({
      seq,
      since: latestSince.current ?? null,
      queuedBehindTurn: latestPhase.current === 'working' || latestPhase.current === 'compacting',
    })
    return seq
  }, [])

  /**
   * Close the window opened by ONE send. A refused send is not in flight and
   * must not go on claiming the row — the refusal's own error line belongs there
   * — but it must close only its OWN claim. Sends resolve out of order: a slow
   * one rejecting on a timeout can land after a later one was accepted, and
   * clearing the window wholesale killed the live send's row and handed the tail
   * straight back to the stale verdict. That is what `seq` is for.
   */
  const clearSent = useCallback((seq: number) => {
    setOpenSend((current) => (current?.seq === seq ? null : current))
  }, [])

  /**
   * TYPING PAST AN OFFER ANSWERS IT (POD-1595).
   *
   * The offer bar had exactly one optimistic path — clicking one of its buttons
   * — and none for the far more ordinary act of ignoring the buttons and just
   * typing. But the server does not distinguish: `session-meta-ops` clears the
   * offer on ANY user turn. So the bar was left standing under the prompt that
   * had already retired it, still asking a question that was no longer open,
   * until the cleared meta came back over the wire.
   *
   * Returns the offer it hid, so a REJECTED send can put it back — the operator's
   * turn never landed, so it never answered anything.
   */
  const retireOfferOptimistically = useCallback((): string | null => {
    const at = latestOfferAt.current
    if (at === undefined) return null
    // Claim it only if THIS send is what hid it. An offer already dismissed —
    // by its own button a moment ago, say — is not ours to un-hide, and
    // reporting it as ours meant a later failure put an offer the operator had
    // already answered back on the screen.
    //
    // READ THROUGH THE REF, NOT THROUGH AN UPDATER. The first cut of this asked
    // `setDismissedOfferAt((current) => …)` and read a flag the updater set.
    // React only runs an updater eagerly when the fiber has no queued work, and
    // here it always does — `setPending` and `markSent` fire first — so the flag
    // was read before the updater ran and was false on EVERY send. Nothing was
    // ever claimed, so no failure ever restored an offer, which is the opposite
    // of the bug this was written to fix. (A side-effecting updater is also
    // impure, and StrictMode double-invokes it.)
    const claimed = dismissedOfferAtRef.current !== at
    applyDismissedOfferAt(at)
    return claimed ? at : null
  }, [applyDismissedOfferAt])

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
      deliveryId: string,
      onQueued: (position?: number) => void,
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
            setCtxSeq(focus.issueId ? getIssueSeq(focus.issueId) : null)
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
            mutationId: deliveryId,
          })
          assertSendAccepted(result)
          if (result.disposition === 'delivered') onDelivered?.()
          else if (result.disposition === 'queued' || result.disposition === 'accepted')
            onQueued(result.position)
          refreshQueuedMessages()
          return
        }
        case 'resume':
          // Parked but recoverable → wake it and let the server deliver the text
          // once the resumed CLI is ready.
          await resumeAndSend(sessionId, text, asMutationId(deliveryId))
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
      getIssueSeq,
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
      const deliveryId = `msg_${randomUUID()}`
      setPending((p) => [
        ...p,
        {
          id,
          deliveryId,
          text: fullText,
          at: Date.now(),
          state: 'sending',
          ...(tags && tags.length > 0 ? { tags } : {}),
          ...(toolPaths && toolPaths.length > 0 ? { toolPaths } : {}),
        },
      ])
      const mySend = markSent()
      const retired = retireOfferOptimistically()
      try {
        await deliver(
          fullText,
          deliveryId,
          (position) =>
            setPending((p) =>
              p.map((x) => (x.id === id ? { ...x, state: 'queued', queuePosition: position } : x)),
            ),
          attachments,
          () => setPending((p) => markPendingSendingDelivered(p, id)),
        )
      } catch (cause) {
        const failure = sendFailureText(cause)
        setPending((p) =>
          p.map((x) => (x.id === id ? { ...x, state: 'failed' as const, failure } : x)),
        )
        clearSent(mySend)
        // Only un-hide the offer THIS send hid: a dismissal made in between is
        // the operator's own and must not be undone by a failure over here.
        if (retired !== null && dismissedOfferAtRef.current === retired) {
          applyDismissedOfferAt(null)
        }
      }
    },
    [applyDismissedOfferAt, clearSent, deliver, markSent, pinToBottom, retireOfferOptimistically],
  )

  // Agent action offer [spec:SP-c7f1]: clicking an offer button sends its
  // agent-authored prompt as a normal user turn (reusing the send path, so the
  // server auto-clears the offer). Optimistically hide the bar immediately.
  const sendOfferPrompt = useCallback(
    async (prompt: string, offerAt: string) => {
      applyDismissedOfferAt(offerAt)
      const id = `pending-${++pendingSeq.current}`
      const deliveryId = `msg_${randomUUID()}`
      setPending((p) => [...p, { id, deliveryId, text: prompt, at: Date.now(), state: 'sending' }])
      const mySend = markSent()
      pinToBottom()
      try {
        await deliver(
          prompt,
          deliveryId,
          (position) =>
            setPending((p) =>
              p.map((x) => (x.id === id ? { ...x, state: 'queued', queuePosition: position } : x)),
            ),
          undefined,
          () => setPending((p) => markPendingSendingDelivered(p, id)),
        )
      } catch (cause) {
        const failure = sendFailureText(cause)
        setPending((p) =>
          p.map((x) => (x.id === id ? { ...x, state: 'failed' as const, failure } : x)),
        )
        clearSent(mySend)
        // Same guard the typed path got: un-hide only if THIS click's offer is
        // still the one hidden. A newer offer, retired by a later send that is
        // still in flight, is not ours to put back.
        if (dismissedOfferAtRef.current === offerAt) applyDismissedOfferAt(null)
        throw cause
      }
    },
    [applyDismissedOfferAt, clearSent, deliver, markSent, pinToBottom],
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
      const retracted = previous.find((message) => message.id === id)
      const linkedPending = pairPendingWithQueued(pending, previous).pending.find(
        (item) => item.durable?.id === id,
      )
      setQueuedMessages((messages) => messages.filter((message) => message.id !== id))
      if (linkedPending) {
        setPending((items) => items.filter((item) => item.id !== linkedPending.id))
      }
      try {
        await trpc.messages.cancel.mutate({ id })
      } catch {
        setQueuedMessages((current) => {
          if (current.some((message) => message.id === id)) return current
          return retracted
            ? [...current, retracted].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
            : current
        })
        if (linkedPending) {
          setPending((current) =>
            current.some((item) => item.id === linkedPending.id)
              ? current
              : [...current, linkedPending].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
          )
        }
        refreshQueuedMessages()
      }
    },
    [pending, queuedMessages, refreshQueuedMessages, trpc],
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
    setDismissedOfferAt: applyDismissedOfferAt,
  }
}
