import type { ChatSendRoute, SuperThreadRef } from '@podium/client-core/viewmodels'
import { UNKNOWN_THREAD_REFUSAL } from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model'
import type { HeadlessActivityEvent } from '@podium/protocol'
import { useCallback, useEffect, useState } from 'react'
import type { Store, UserFocus } from '@/app/store'

/**
 * HEADLESS SUPERAGENT ROUTING (POD-405), as its own part rather than three
 * inline branches inside ChatView.
 *
 * A headless ChatView fronts a SUPERAGENT THREAD: there is no PTY, so sends go
 * to the turn mutations, the working indicator follows turn-start/turn-end
 * frames, and mid-turn partial text streams into an overlay row below the
 * transcript. All three used to be `headless && …` conditions threaded through
 * the component; here they are one object with one lifecycle.
 *
 * ---------------------------------------------------------------------------
 * SUPERAGENT THREADS ARE PER-USER (doc §3.1.6 S1/S2), AND THE REFUSAL IS FLAT
 * ---------------------------------------------------------------------------
 *
 * The superagent is a broad-scope delegation from ONE human, and its threads,
 * messages, queued inputs and pending turns are private to that human. So a
 * thread id that is not the signed-in principal's must not be addressable from
 * here — and per doc §3.1.5's consistent-error rule, refusing it must look
 * IDENTICAL to refusing an id that never existed. That decision is made in the
 * slice (`chatSendRoute`), before a mutation is composed, and this hook simply
 * cannot reach a mutation without a route. The uniform {@link
 * UNKNOWN_THREAD_REFUSAL} string is what the user sees in both cases.
 *
 * This is UX gating, not authorization: the Authority re-authorizes at apply
 * (ADR 3 D8), and a denial from it lands in `turnError` the same way.
 *
 * NO PAYLOAD CARRIES ATTRIBUTION. The turn mutations send `{ threadId | repoPath,
 * text, focus }` and nothing else — no actor, no owner, no origin. Per doc
 * §3.1.3 A3 / ADR 3 D7 both halves of the attribution pair are stamped by the
 * authority from the authenticated transport; a client that sent them would be
 * asserting an identity it is not entitled to assert.
 */

export interface HeadlessOverlay {
  /** Cumulative partial assistant text streamed mid-turn. */
  text?: string
  /** The driver's status label ("running Bash…"), which rides under the text. */
  status?: string
}

export interface UseHeadlessTurnOptions {
  sessionId: SessionId
  hub: Store['hub']
  trpc: Store['trpc']
  /** True when this session has no PTY — the whole hook is inert otherwise. */
  headless: boolean
  superThread: SuperThreadRef | undefined
  /** Query-backed state for a client that mounted after turn-start. */
  initialTurnRunning: boolean
  /** Grows as transcript items land — the streamed preview is superseded by the
   *  real item, so accumulated text clears whenever the transcript grows. */
  blockCount: number
}

export interface UseHeadlessTurnResult {
  /** True between turn-start and turn-end. Closes the composer. */
  turnRunning: boolean
  overlay: HeadlessOverlay | null
  /** A rejection or turn error, shown inline above the composer. */
  turnError: string | null
  setTurnError: (message: string | null) => void
  /** Send one turn along an already-decided route. Throws on rejection so the
   *  caller can mark its optimistic bubble failed. */
  sendTurn: (route: ChatSendRoute, text: string, focus: UserFocus) => Promise<void>
  /** Stop the running turn. Available only while one is running. */
  interrupt: () => void
}

export function useHeadlessTurn(opts: UseHeadlessTurnOptions): UseHeadlessTurnResult {
  const { sessionId, hub, trpc, headless, superThread, initialTurnRunning, blockCount } = opts

  const [turnRunning, setTurnRunning] = useState(initialTurnRunning)
  const [overlay, setOverlay] = useState<HeadlessOverlay | null>(null)
  const [turnError, setTurnError] = useState<string | null>(null)

  useEffect(() => {
    setTurnRunning(initialTurnRunning)
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
  }, [hub, sessionId, headless, initialTurnRunning])

  // Headless overlay lifecycle: the streamed partial text is a preview of the
  // assistant item that will land via the transcript tail — whenever new items
  // arrive, clear the accumulated text (turn-end clears the whole overlay).
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear on transcript growth
  useEffect(() => {
    if (!headless) return
    setOverlay((o) => (o?.text !== undefined ? (o.status ? { status: o.status } : null) : o))
  }, [blockCount, headless])

  const sendTurn = useCallback(
    async (route: ChatSendRoute, text: string, focus: UserFocus) => {
      // A refused route never reaches a mutation. Both "someone else's thread"
      // and "no such thread" arrive here as the same refusal, carrying the same
      // message — the client cannot be used to tell them apart.
      if (route.kind === 'refused') {
        setTurnError(route.reason)
        throw new Error(UNKNOWN_THREAD_REFUSAL)
      }
      setTurnError(null)
      try {
        // Every turn carries what the user has on screen (POD-225), so the
        // orchestrator can resolve "this session"/"this issue" without asking.
        if (route.kind === 'concierge') {
          await trpc.superagent.concierge.mutate({ repoPath: route.repoPath, text, focus })
        } else if (route.kind === 'superagent-turn') {
          await trpc.superagent.sendTurn.mutate({ threadId: route.threadId, text, focus })
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (message.includes('turn is already running')) setTurnRunning(true)
        setTurnError(
          message.includes('turn is already running')
            ? 'Super agent is still working on the previous message. Wait for it to finish or stop the turn before sending another.'
            : message,
        )
        throw e
      }
    },
    [trpc],
  )

  const interrupt = useCallback(() => {
    if (!superThread) return
    trpc.superagent.interruptTurn
      .mutate({ threadId: superThread.threadId })
      .catch((e: unknown) => setTurnError(e instanceof Error ? e.message : String(e)))
  }, [trpc, superThread])

  return { turnRunning, overlay, turnError, setTurnError, sendTurn, interrupt }
}
