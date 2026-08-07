/**
 * THE CHAT SLICE (POD-405, completing POD-330's per-feature split).
 *
 * Every view-model question the chat surface used to answer inside ChatView with
 * a `useMemo` or a `useEffect` is answered here instead, as a pure function over
 * data. The component that remains renders; it does not derive.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SLICE IS NOT A `SliceDefinition`
 * ---------------------------------------------------------------------------
 *
 * `slices/publish.ts` memoizes on SNAPSHOT IDENTITY, which is exactly right for a
 * derivation whose whole input is the replica snapshot. The chat surface's
 * dominant input is not: a transcript window is READ over tRPC and tailed over a
 * per-session subscription, and it is held by whoever mounted the view. So this
 * module takes the same shape `slices/workflows.ts` took for the same reason —
 * pure functions over their inputs, published through a source hook per platform
 * rather than through the entity publisher. The derivations survive either
 * answer; only what feeds them would change if transcripts became replicated.
 *
 * Platform-neutral: no React, no DOM, no storage. The web binds it in
 * `apps/web/src/features/chat/use-chat-surface.ts`; mobile can bind the same
 * functions unchanged.
 *
 * ---------------------------------------------------------------------------
 * WHAT MULTI-USER ADDS HERE (docs/multi-user-readiness.md)
 * ---------------------------------------------------------------------------
 *
 * 1. §3.1.6 S1/S2 — SUPERAGENT THREADS ARE PER-USER AND PRIVATE. The embedded
 *    headless chat may only address threads the signed-in principal holds. That
 *    is enforced at the ROUTE (see {@link chatSendRoute}), before a mutation is
 *    composed, and a foreign id is refused with the same answer as an id that
 *    never existed — §3.1.5's consistent-error rule, so the send path cannot
 *    become an existence oracle.
 *
 * 2. §3.1.3 A3 — ATTRIBUTION IS A PAIR, READ AND NEVER ASSERTED. Actor (which
 *    agent) and on-behalf-of (which human) are published apart, from
 *    server-stamped fields only; {@link transcriptAttribution} synthesises
 *    neither half and says so explicitly when a half is not carried yet.
 *
 * 3. §3.1 / POD-1077 — THE TRANSCRIPT RENDERS A PARTIAL WORLD. The session
 *    behind an open chat can be EVICTED without being deleted, and
 *    {@link chatSessionReference} keeps the four causes apart so the view can
 *    neither spin forever on an invisible referent nor announce a deletion that
 *    did not happen.
 *
 * 4. §3.3 / §4 — THE COMPOSER DRAFT IS PERSONAL-CLASS SHARED-SURFACE STATE.
 *    Nothing here reads or writes it. See {@link CHAT_DRAFT_CLASSIFICATION} for
 *    the classification and the reason this slice deliberately has no draft
 *    field at all.
 */
import type { SessionMeta, TranscriptItem } from '@podium/model'
import { type ChatBlock, type ChatRow, MACHINE_CONTEXT_RE } from '../chat'
import { type ReferentExit, type ReferentState, resolveReferent } from '../session-ownership'
import { type ChatActivity, chatActivity } from '../session-status'

// ---------------------------------------------------------------------------
// The composer draft: classified, and deliberately absent.
// ---------------------------------------------------------------------------

/**
 * THE COMPOSER DRAFT IS **PERSONAL CLASS**, AND ITS FUTURE HOME IS `op-stream`.
 *
 * Recorded here because getting it wrong is cheap to do and expensive to undo,
 * and because the wrong answer is the *obvious* one.
 *
 * - It is PERSONAL (doc §3.1.1): private to its owner and SHAREABLE, listed
 *   there beside sessions and issues. It inherits its parent session's owner and
 *   grants, exactly like every other child of a session.
 * - It is NOT per-user state. Doc §3.3 enumerates that family — `readAt`,
 *   snooze, pins, tab order, preferences — and deliberately EXCLUDES the draft
 *   body, calling it "genuinely shared-surface state". Re-keying it
 *   `(userId, entityId)` and routing it through POD-1076 would make it
 *   never-shared at the MODEL level and close §4's reserved path before anyone
 *   decided to close it. That is the one outcome the carve-out exists to prevent.
 * - Its future conflict class is `op-stream` (doc §4): a per-document ordered op
 *   stream sequenced by the Authority. NOT built now, and this phase must not
 *   entrench the whole-body write path that would have to be unpicked to build
 *   it. Concretely: the view holds no merge logic and no whole-body reconcile;
 *   it calls one action (`setSessionDraft`) through the POD-402 actions seam,
 *   and replacing that action's mechanism with an op stream touches no view.
 * - ADR 1 D1's CRDT rejection is NOT a reason the co-editing path is closed:
 *   that rejection is about daemon observations, and doc §4 carves this out.
 *
 * Today's single-writer behaviour is preserved unchanged.
 */
export const CHAT_DRAFT_CLASSIFICATION = {
  visibilityClass: 'personal',
  perUserStateFamily: false,
  conflictClassToday: 'field-LWW',
  conflictClassReserved: 'op-stream',
  reference: 'docs/multi-user-readiness.md §3.1.1, §3.3, §4',
} as const

// ---------------------------------------------------------------------------
// Attribution — a pair, read from server-stamped fields, never synthesised.
// ---------------------------------------------------------------------------

/**
 * Who produced one transcript row, as a PAIR (doc §3.1.3 A3).
 *
 * `actor` is which agent produced it; `onBehalfOf` is which human it acted for.
 * Both are read from server-stamped data — the transcript's own `role`, and the
 * session's server-owned identity fields. Neither is ever inferred from payload,
 * defaulted to the signed-in user, or filled in from a client guess.
 *
 * THE THIRD VALUE IS LOAD-BEARING. `onBehalfOf: null` means "no human behind
 * this" (a system act); `onBehalfOf: undefined` means "this deployment does not
 * carry the field yet". Collapsing those two is how a UI starts telling people
 * that an unattributed row was a system act. The on-behalf-of half lands on
 * `SessionMeta` with POD-1075; until it does, `undefined` is the honest answer
 * and `delegated` is likewise undefined rather than false.
 */
export interface TranscriptAttribution {
  /** 'human' for an operator turn, 'agent' for the harness, 'system' for
   *  machine-authored rows. Read from the row's own role — never guessed. */
  readonly actorKind: 'human' | 'agent' | 'system'
  /** Which agent acted: the session's curated name / harness kind, when the
   *  server carries one. Undefined for a human turn — a person is not an actor
   *  agent, and naming them here would collapse the pair into one value. */
  readonly actorId: string | undefined
  /** Which human it acted for. `null` = no human behind it; `undefined` = the
   *  field is not carried on this wire yet (POD-1075). */
  readonly onBehalfOf: string | null | undefined
  /** True when a human is recorded behind the act, false when one is recorded
   *  as absent, undefined when the wire does not carry the half. */
  readonly delegated: boolean | undefined
}

/**
 * The attribution pair for one transcript row.
 *
 * `session` supplies the actor half: it is the server's record of which harness
 * is driving this transcript. A user row's actor is the human themselves, so
 * `actorId` stays undefined rather than borrowing the agent's name.
 */
export function transcriptAttribution(
  item: TranscriptItem,
  session: SessionMeta | undefined,
): TranscriptAttribution {
  const actorKind: TranscriptAttribution['actorKind'] =
    item.role === 'user' ? 'human' : item.role === 'system' ? 'system' : 'agent'
  const onBehalfOf = sessionOnBehalfOf(session)
  return {
    actorKind,
    actorId: actorKind === 'agent' ? agentActorId(session) : undefined,
    onBehalfOf,
    delegated: onBehalfOf === undefined ? undefined : onBehalfOf !== null,
  }
}

/**
 * The three attribution pairs a transcript can show, derived ONCE per session.
 *
 * A row's pair depends on its role and on the session — nothing else — so there
 * are exactly three of them. Deriving the table rather than one object per row
 * keeps the objects referentially stable, which is what lets the memoized block
 * views keep skipping re-renders: a fresh pair per row would defeat `memo` for
 * every block in the transcript.
 */
export interface TranscriptAttributionTable {
  readonly human: TranscriptAttribution
  readonly agent: TranscriptAttribution
  readonly system: TranscriptAttribution
}

export function transcriptAttributionTable(
  session: SessionMeta | undefined,
): TranscriptAttributionTable {
  const pair = (role: TranscriptItem['role']): TranscriptAttribution =>
    transcriptAttribution({ role, id: '', text: '' } as TranscriptItem, session)
  return { human: pair('user'), agent: pair('assistant'), system: pair('system') }
}

/** Which of the three pairs a row shows. */
export function attributionForRole(
  table: TranscriptAttributionTable,
  role: TranscriptItem['role'],
): TranscriptAttribution {
  return role === 'user' ? table.human : role === 'system' ? table.system : table.agent
}

/** The agent half of the pair, from server-stamped session fields only. The
 *  curated `name` is preferred because a human may have set it (`nameSource`),
 *  and the harness kind is the fallback identity the server always carries. */
function agentActorId(session: SessionMeta | undefined): string | undefined {
  if (!session) return undefined
  return session.name ?? session.agentKind ?? undefined
}

/**
 * The on-behalf-of half, read from whatever the server stamps.
 *
 * `SessionMeta` does not carry it yet — POD-1075 owns adding it, and
 * `entities/session.ts` records the gap in its own header. Reading through this
 * one function means the field arrives in exactly one place, and until it does
 * every consumer gets `undefined` (unknown) rather than a fabricated value.
 */
function sessionOnBehalfOf(session: SessionMeta | undefined): string | null | undefined {
  if (!session) return undefined
  const carried = (session as { onBehalfOf?: string | null }).onBehalfOf
  return carried === undefined ? undefined : carried
}

// ---------------------------------------------------------------------------
// The session behind the chat, over a partial world.
// ---------------------------------------------------------------------------

/**
 * The chat's own referent: the session whose transcript is on screen.
 *
 * Four states, kept apart for the two reasons §3.1's tests enforce. `pending` is
 * the ONLY one a spinner is correct for. `not-visible` is an eviction — a share
 * revoked (POD-1077), the entity still exists, and rendering it as a deletion is
 * the defect this type exists to prevent. `removed` is a real tombstone.
 */
export interface ChatSessionReference {
  readonly state: ReferentState
  readonly id: string
  readonly value?: SessionMeta
}

export function chatSessionReference(
  sessionId: string,
  sessions: readonly SessionMeta[],
  exitOf: (id: string) => ReferentExit | undefined = () => undefined,
): ChatSessionReference {
  const resolved = resolveReferent(
    sessionId,
    (id) => sessions.find((s) => s.sessionId === id),
    exitOf,
  )
  return {
    state: resolved.state,
    id: sessionId,
    ...(resolved.value !== undefined ? { value: resolved.value } : {}),
  }
}

/**
 * What the transcript area should show, as ONE answer rather than three
 * overlapping booleans in JSX.
 *
 * - `loading`   — the initial read has not resolved. Bounded: it is only ever
 *                 returned while the referent is `pending` or `present`.
 * - `empty`     — the read resolved and the feed is genuinely empty.
 * - `ready`     — there is something to render.
 * - `gone`      — the session left the principal's view. NOT a deletion state:
 *                 the caller leaves quietly, with no toast, no tombstone and no
 *                 re-request of the vanished id. `not-visible` and `removed`
 *                 both land here and are deliberately INDISTINGUISHABLE to the
 *                 renderer (§3.1.5) — telling them apart on screen would answer
 *                 "does this exist?" for an entity the principal may not see.
 */
export type TranscriptPhase = 'loading' | 'empty' | 'ready' | 'gone'

export function transcriptPhase(input: {
  reference: ChatSessionReference
  blockCount: number
  pendingCount: number
  initialLoaded: boolean
}): TranscriptPhase {
  const { reference, blockCount, pendingCount, initialLoaded } = input
  if (reference.state === 'not-visible' || reference.state === 'removed') return 'gone'
  if (blockCount > 0 || pendingCount > 0) return 'ready'
  // The spinner is bounded by the READ, not by the referent: only `present` and
  // `pending` reach this line (both terminal states left above), and once the
  // initial read has resolved an empty feed is an empty feed, never a longer
  // wait. That is what keeps `pending` — the one state a spinner is ever correct
  // for — from becoming an unbounded one.
  return initialLoaded ? 'empty' : 'loading'
}

// ---------------------------------------------------------------------------
// Operator prompts — the sticky-continuation and minimap unit.
// ---------------------------------------------------------------------------

/**
 * A row the user typed, as opposed to narration, tool noise or a machine-authored
 * context block.
 *
 * `operatorTextOf` is injected rather than imported because the message-envelope
 * parser is a web module today; passing it keeps this file platform-neutral and
 * keeps the predicate ONE definition instead of two that drift. It returns the
 * operator-authored part of an envelope batch, or `undefined` when the text is
 * not an envelope at all.
 */
export interface OperatorPromptOptions {
  /** Headless threads prepend machine-authored seed/delta blocks to the turn;
   *  those are not prompts the user typed and must not anchor a sticky header. */
  readonly collapseMachineContext: boolean
  readonly operatorTextOf?: (text: string) => string | undefined
}

export function isOperatorPrompt(item: TranscriptItem, opts: OperatorPromptOptions): boolean {
  if (item.role !== 'user') return false
  if (item.event === 'interrupt') return false
  if (!item.text.trim()) return false
  if (opts.collapseMachineContext && MACHINE_CONTEXT_RE.test(item.text)) return false
  const operatorText = opts.operatorTextOf?.(item.text)
  return operatorText === undefined || operatorText !== ''
}

export function isOperatorPromptRow(row: ChatRow, opts: OperatorPromptOptions): boolean {
  return row.kind === 'block' && isOperatorPrompt(row.block.item, opts)
}

/** A row to mount, with its ABSOLUTE index into the full `rows` array — the index
 *  the minimap, search and `[data-block]` all key on. */
export interface RenderableRow {
  readonly row: ChatRow
  readonly index: number
}

/**
 * The rows to mount: the bounded trailing window, plus the closest operator
 * prompt ABOVE it kept mounted as a one-row continuation.
 *
 * The continuation exists so a very long answer keeps the question it answers on
 * screen without expanding the virtualized window. It participates in the same
 * native sticky behaviour as an ordinary row, which is why it is a real row here
 * rather than a floating header.
 */
export function renderableRows(input: {
  rows: readonly ChatRow[]
  visibleRows: readonly ChatRow[]
  renderStart: number
  stickyEnabled: boolean
  promptOptions: OperatorPromptOptions
}): RenderableRow[] {
  const { rows, visibleRows, renderStart, stickyEnabled, promptOptions } = input
  const out: RenderableRow[] = []
  if (stickyEnabled && renderStart > 0) {
    for (let i = renderStart - 1; i >= 0; i--) {
      const row = rows[i]
      if (row && isOperatorPromptRow(row, promptOptions)) {
        out.push({ row, index: i })
        break
      }
    }
  }
  visibleRows.forEach((row, ri) => {
    out.push({ row, index: renderStart + ri })
  })
  return out
}

// ---------------------------------------------------------------------------
// Search over the loaded transcript.
// ---------------------------------------------------------------------------

/** Case-insensitive keyword match over everything a block shows. */
export function blockMatches(block: ChatBlock, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  const hay = [
    block.item.text,
    block.item.toolName ?? '',
    block.item.toolInput ?? '',
    block.result ?? block.item.toolResult ?? '',
  ]
    .join('\n')
    .toLowerCase()
  return hay.includes(q)
}

export function searchBlocks(blocks: readonly ChatBlock[], query: string): number[] {
  if (!query.trim()) return []
  const hits: number[] = []
  blocks.forEach((b, i) => {
    if (blockMatches(b, query)) hits.push(i)
  })
  return hits
}

/**
 * Everything the search UI needs, derived once.
 *
 * Search runs per BLOCK (so a hit inside a collapsed tool batch is still found)
 * and the view scrolls to ROWS, so the block→row map is part of the answer
 * rather than a second derivation at the call site.
 */
export interface TranscriptSearchState {
  readonly matches: readonly number[]
  /** The matched BLOCK index under the cursor, or undefined when there are none. */
  readonly activeMatch: number | undefined
  /** The ROW that renders `activeMatch` — what the view scrolls to and expands. */
  readonly activeRow: number | undefined
  /** 1-based position shown next to the count, or 0 when there are no matches. */
  readonly position: number
  readonly total: number
  /** True while a query is active — the dimming gate for non-matching rows. */
  readonly filtering: boolean
}

export function transcriptSearchState(input: {
  blocks: readonly ChatBlock[]
  rows: readonly ChatRow[]
  query: string
  cursor: number
}): TranscriptSearchState {
  const { blocks, rows, query, cursor } = input
  const matches = searchBlocks(blocks, query)
  const total = matches.length
  const activeMatch = total > 0 ? matches[cursor % total] : undefined
  let activeRow: number | undefined
  if (activeMatch !== undefined) {
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri]
      if (!row) continue
      if (
        row.kind === 'tools'
          ? row.blockIndices.includes(activeMatch)
          : row.blockIndex === activeMatch
      ) {
        activeRow = ri
        break
      }
    }
  }
  return {
    matches,
    activeMatch,
    activeRow,
    position: total > 0 ? (cursor % total) + 1 : 0,
    total,
    filtering: query.trim() !== '',
  }
}

// ---------------------------------------------------------------------------
// Answerable questions and the last answer.
// ---------------------------------------------------------------------------

/**
 * The index (into `blocks`) of the ONE AskUserQuestion the user can answer right
 * now: the last unanswered one, and only while the session is live enough for a
 * digit to reach the agent's native menu. Every other card stays read-only.
 * `-1` when there is none.
 */
export function livePendingAskIndex(
  blocks: readonly ChatBlock[],
  status: SessionMeta['status'] | undefined,
): number {
  if (status !== 'live' && status !== 'starting') return -1
  let last = -1
  blocks.forEach((b, i) => {
    const isAsk =
      b.item.role === 'tool' && b.item.toolName === 'AskUserQuestion' && b.item.toolInputJson
    const answered = (b.result ?? b.item.toolResult) !== undefined
    if (isAsk && !answered) last = i
  })
  return last
}

/** The agent's most recent answer: the block index carrying the end-of-turn
 *  marker (for the compact column's context label) and the latest assistant prose
 *  (what tl;dr summarises). Both are one pass over the same list. */
export interface LastAnswer {
  readonly blockIndex: number
  readonly text: string
}

export function lastAnswer(blocks: readonly ChatBlock[]): LastAnswer {
  let blockIndex = -1
  let text = ''
  blocks.forEach((b, i) => {
    if (b.item.role !== 'assistant') return
    if (b.item.answer) blockIndex = i
    if (b.item.text.trim()) text = b.item.text
  })
  return { blockIndex, text }
}

// ---------------------------------------------------------------------------
// The composer, and where a send actually goes.
// ---------------------------------------------------------------------------

export interface ComposerState {
  /** The composer takes input. */
  readonly enabled: boolean
  /** The session can take text straight through. */
  readonly sendable: boolean
  /** Parked but recoverable — submitting wakes it and the text is delivered. */
  readonly canResume: boolean
  readonly placeholder: string
}

export function composerState(input: {
  session: SessionMeta | undefined
  headless: boolean
  turnRunning: boolean
  compact: boolean
}): ComposerState {
  const { session, headless, turnRunning, compact } = input
  const sendable = session?.status === 'live' || session?.status === 'starting'
  const canResume =
    session?.status === 'hibernated' ||
    (session?.status === 'exited' && session?.resumable === true)
  // Headless: PTY status is meaningless — the composer is open whenever no turn
  // is running (a turn is one queued unit; the server rejects overlap anyway).
  const enabled = headless ? !turnRunning : sendable || canResume
  const placeholder = headless
    ? turnRunning
      ? 'Working — stop to interject…'
      : compact
        ? // The fresh-thread box says this too. It is ONE box either side of the
          // first turn, so its statement of scope must not change under the
          // operator at the moment they start using it (POD-516 R3).
          'Ask across all tasks…'
        : 'Message the agent…'
    : sendable
      ? 'Message the agent…'
      : canResume
        ? 'Message — resumes the agent…'
        : 'Session is not running.'
  return { enabled, sendable, canResume, placeholder }
}

/** The superagent thread an embedded (headless) chat fronts. */
export interface SuperThreadRef {
  readonly threadId: string
  readonly kind: 'global' | 'btw' | 'concierge'
  readonly repoPath?: string
}

/**
 * Where a composed send goes — decided ONCE, as data, before any mutation is
 * composed.
 *
 * `refused` is the multi-user arm and it is the reason this is a route rather
 * than an `if` inside the send handler. Per doc §3.1.6 S2 superagent threads are
 * per-user and private; per §3.1.5 acting on one you cannot see must fail
 * IDENTICALLY to acting on an id that never existed. Both cases produce the same
 * `refused` with the same reason string, so the client cannot be used to ask
 * "does this thread exist?". The Authority re-decides at apply either way — this
 * is UX gating, not authorization.
 */
export type ChatSendRoute =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'resume'; readonly sessionId: string }
  | { readonly kind: 'superagent-turn'; readonly threadId: string }
  | { readonly kind: 'concierge'; readonly repoPath: string }
  | { readonly kind: 'refused'; readonly reason: string }

/** The one refusal string every unreachable-thread path uses. A second wording
 *  anywhere would re-open the oracle this exists to close. */
export const UNKNOWN_THREAD_REFUSAL = 'That conversation is not available.'

export function chatSendRoute(input: {
  sessionId: string
  headless: boolean
  superThread: SuperThreadRef | undefined
  composer: Pick<ComposerState, 'sendable' | 'canResume'>
  /** The signed-in principal's OWN thread ids. A thread absent from this set is
   *  either someone else's or nonexistent, and the route may not tell them
   *  apart. Undefined = the client holds no roster (older peers), in which case
   *  the server remains the only gate and the route does not pretend otherwise. */
  ownThreadIds?: ReadonlySet<string>
}): ChatSendRoute {
  const { sessionId, headless, superThread, composer, ownThreadIds } = input
  if (headless && superThread) {
    if (ownThreadIds !== undefined && !ownThreadIds.has(superThread.threadId)) {
      return { kind: 'refused', reason: UNKNOWN_THREAD_REFUSAL }
    }
    if (superThread.kind === 'concierge' && superThread.repoPath) {
      return { kind: 'concierge', repoPath: superThread.repoPath }
    }
    return { kind: 'superagent-turn', threadId: superThread.threadId }
  }
  if (composer.sendable) return { kind: 'session', sessionId }
  if (composer.canResume) return { kind: 'resume', sessionId }
  return { kind: 'refused', reason: 'Session is not running.' }
}

// ---------------------------------------------------------------------------
// Queued messages, the offer bar, and the working indicator.
// ---------------------------------------------------------------------------

/** What the "N messages queued" line counts, and which restored rows still need
 *  rendering after optimistic bubbles have claimed their duplicates. */
export interface QueuedState<Q> {
  readonly restored: readonly Q[]
  readonly total: number
}

export function queuedState<
  Q extends { text: string },
  P extends { text: string; state: string },
>(input: {
  session: SessionMeta | undefined
  queuedMessages: readonly Q[]
  pending: readonly P[]
}): QueuedState<Q> {
  const { session, queuedMessages, pending } = input
  // Duplicate prompt text is consumed FIFO so two identical queued sends still
  // render twice after a refresh and only once each before it.
  const optimistic = pending.filter((p) => p.state !== 'failed').map((p) => p.text.trim())
  const restored = queuedMessages.filter((q) => {
    const i = optimistic.indexOf(q.text.trim())
    if (i === -1) return true
    optimistic.splice(i, 1)
    return false
  })
  return { restored, total: (session?.queuedMessageCount ?? 0) + queuedMessages.length }
}

/** The live offer for this session, unless a button click just consumed it
 *  (optimistic hide until the server's cleared meta arrives). Headless superagent
 *  threads never show one. */
export function visibleOffer(input: {
  session: SessionMeta | undefined
  headless: boolean
  dismissedOfferAt: string | null
}): SessionMeta['offer'] | null {
  const { session, headless, dismissedOfferAt } = input
  if (headless || !session?.offer) return null
  return session.offer.createdAt === dismissedOfferAt ? null : session.offer
}

/**
 * The working indicator.
 *
 * Headless follows TURN BOUNDARIES rather than PTY-derived agent state, because
 * there is no PTY: the streamed overlay row carries the detail and this is only
 * the one-line badge above the composer.
 */
export function chatActivityState(input: {
  session: SessionMeta | undefined
  headless: boolean
  turnRunning: boolean
  justSent: boolean
}): ChatActivity | null {
  const { session, headless, turnRunning, justSent } = input
  if (!headless) return chatActivity(session, justSent)
  if (turnRunning) return { label: 'Working…', tone: 'working' }
  if (justSent) return { label: 'Sending…', tone: 'working' }
  return null
}
