/**
 * THE opencode SERVER DRIVER (POD-1761 W5 — the epic's goal; spec §2, §3, §6).
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS THE PROOF THE EPIC EXISTS FOR
 * ---------------------------------------------------------------------------
 *
 * The terminal driver had to WRAP a stack that already existed, so its honesty
 * is mostly about admitting what a PTY cannot know. This one has the opposite
 * job: opencode's server can answer everything the contract asks, so the driver's
 * work is to say so without borrowing a single one of the terminal family's
 * excuses. It claims no exemption for unverified sends and none for at-least-once
 * interactions, and the corpus checks both directions of both claims.
 *
 * ---------------------------------------------------------------------------
 * THE SPLIT: SESSION LOGIC HERE, PROCESSES IN THE DAEMON
 * ---------------------------------------------------------------------------
 *
 * Everything below is HTTP, SSE and bookkeeping — testable in-process against a
 * fake server, which is what makes this the epic's first fully deterministic
 * driver. What is NOT here is spawning: `opencode serve` under a systemd
 * transient scope, the port allocation, the binding journal on disk. That is
 * `apps/daemon/src/runtime/opencode-server.ts`, reached only through
 * {@link OpencodeRuntimeHost} — the same discipline `TerminalRuntimeHost` applies
 * one directory over, for the same reason: a driver that took the daemon's
 * composition root would be untestable and unbounded.
 *
 * ---------------------------------------------------------------------------
 * THE SECRET (spec §6)
 * ---------------------------------------------------------------------------
 *
 * A loopback port is not a private one: every local process and every local user
 * can reach it, and this one fronts a credentialed agent with filesystem and
 * shell tools. So the per-session secret is MANDATORY, it rides the child's env
 * (`OPENCODE_SERVER_PASSWORD`) and never argv — argv is world-readable in
 * `/proc` — and a client without it is refused by opencode itself with a 401.
 * That refusal is a conformance property, not a comment.
 */

import type { AgentRuntimeState, ResumeRef, SessionId, TranscriptItem } from '@podium/model'
import type { ObservationProvenance, ProviderCursor } from '@podium/protocol'
import type { AttachEndpoint, AttachRequest, SessionLease } from '../../attach.js'
import type { ProcessIdentity, SessionArchive, SessionBinding, SessionSnapshot } from '../../binding.js'
import type { ConfigureRequest, SessionHealth, UsageSnapshot } from '../../capabilities.js'
import type { AgentSessionHandle, RuntimeDriver } from '../../driver.js'
import type { ProcessEvent } from '../../errors.js'
import type { EventStreamStart, RuntimeEvent, RuntimeEventBody, WatchLevel } from '../../events.js'
import type {
  InteractionAnswer,
  InteractionAnswerOutcome,
  PendingInteraction,
} from '../../interactions.js'
import type { SessionSpec } from '../../session-spec.js'
import type { AnswerOptions, AttachmentRef, Refusal, SendOptions, TurnInput, TurnReceipt } from '../../turns.js'
import { driverLocalCursor, stampRuntimeEvent } from '../terminal/envelope.js'
import { opencodeServerCapabilities } from './capabilities.js'
import { type OpencodeClient, type OpencodeClientConfig, createOpencodeClient } from './client.js'
import { answerAction, idleToStateEvent, partToItems, permissionAsk, questionAsk, statusToStateEvent } from './map.js'
import {
  type OpencodeEvent,
  type OpencodeMessageInfo,
  type OpencodeQuestionInfo,
  type OpencodeSessionId,
  eventSessionId,
  eventTimeMs,
} from './protocol.js'

// ---------------------------------------------------------------------------
// The host port
// ---------------------------------------------------------------------------

/** One live `opencode serve` process, as the driver needs it. */
export interface OpencodeServerEndpoint {
  /** `http://127.0.0.1:<port>`. Loopback by construction — the spawn does not
   *  offer another hostname, because a server driver that could bind 0.0.0.0
   *  would put spec §6's whole argument in a config file. */
  baseUrl: string
  username: string
  /** The per-session secret. In env and in memory; never argv, never a log. */
  password: string
  /** What `adopt()` matches on. Opaque and EXACT — a prefix match here rebinds
   *  the wrong server, which is worse than not rebinding. */
  process: ProcessIdentity
  /** Graceful shutdown of the server process and its scope. */
  stop(): Promise<void>
  kill(): Promise<void>
  /** Whole-subtree RSS, where the platform can attribute it. */
  memoryBytes(): number | undefined
}

/** What the driver needs from whoever owns processes and disks. */
export interface OpencodeRuntimeHost {
  /**
   * Spawn a server for one session and RETURN ONLY WHEN IT ANSWERS.
   *
   * Readiness is the host's problem because the probe is the host's transport:
   * a handle that came back before `/global/health` answered would fail its
   * first verb for a reason that looks like a protocol bug.
   */
  launch(input: {
    sessionId: SessionId
    workdir: string
    /** The secret to place in `OPENCODE_SERVER_PASSWORD`. Minted by the driver
     *  so a host cannot accidentally reuse one across sessions. */
    secret: string
    username: string
    env?: Readonly<Record<string, string>>
  }): Promise<OpencodeServerEndpoint>

  /**
   * Re-bind a SURVIVING server after a supervisor restart, or `undefined`.
   *
   * `undefined` (not a throw) because "this binding's process is gone" is an
   * expected answer that `adopt()` turns into its own rejection with the
   * contract's wording. The host's job is the fact, not the policy.
   */
  adopt(binding: SessionBinding): Promise<OpencodeServerEndpoint | undefined>

  /**
   * Start the harness's own TUI client against this server, for `attach()`.
   *
   * `undefined` when the host has nowhere to run one. The capability still
   * declares `client`, because the ENDPOINT VARIANT this family produces does
   * not change with the host — what changes is whether this particular machine
   * can host a terminal, and that is what the refusal says.
   */
  attachClient(input: {
    sessionId: SessionId
    url: string
    mode: AttachRequest['mode']
  }): Promise<{ streamId: string; warmTtlMs: number } | undefined>

  /** Persist enough to rebind after a daemon restart: port, secret, opencode
   *  session id, scope unit. Written before the first turn, cleared on kill. */
  journal: OpencodeJournal

  now(): number
  /** 32 bytes of CSPRNG, hex. Injected so a test is deterministic and so the
   *  package takes no crypto dependency of its own. */
  randomSecret(): string
  /** THE DRIVER MINTS THE PODIUM SESSION ID, because `SessionSpec` carries none
   *  — the same division `FakeDriver` and the terminal driver already use. The
   *  host supplies it so the daemon can hand back the id the SERVER already
   *  chose for this spawn instead of inventing a second one. */
  mintSessionId(): SessionId
  /** Injected only by tests, which point the client at an in-process server. */
  makeClient?(config: OpencodeClientConfig): OpencodeClient
}

/** What survives a supervisor restart. The SECRET is in here, which is why the
 *  host is required to store it 0600 in the instance dir and nowhere else. */
export interface OpencodeJournalEntry {
  sessionId: SessionId
  opencodeSessionId: OpencodeSessionId
  baseUrl: string
  username: string
  secret: string
  workdir: string
  process: ProcessIdentity
  /** The event-stream high-water mark, so a reconnect resumes rather than
   *  replays and so `seq` stays monotonic across a rebind. */
  seq: number
  turnEpoch: number
  bindingVersion: number
}

export interface OpencodeJournal {
  read(sessionId: SessionId): OpencodeJournalEntry | undefined
  write(entry: OpencodeJournalEntry): void
  clear(sessionId: SessionId): void
}

/** How many events one session's replay buffer retains — the same bound and the
 *  same argument as the terminal driver's: it serves a RECONNECT, not history. A
 *  consumer whose cursor fell off the back re-bootstraps from `snapshot()`. */
export const OPENCODE_EVENT_LOG_LIMIT = 512

/** How long `send({delivery:'when-ready'})` waits for an open turn to end before
 *  giving up. Long, because the honest alternative to waiting is refusing, and a
 *  caller that asked for `when-ready` said it would rather wait. */
const WHEN_READY_TIMEOUT_MS = 10 * 60_000

export const OPENCODE_SERVER_DRIVER_ID = 'opencode-server'

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

interface QueuedTurn {
  input: TurnInput
  options: SendOptions
}

interface DriverSession {
  sessionId: SessionId
  spec: SessionSpec
  endpoint: OpencodeServerEndpoint
  client: OpencodeClient
  opencodeSessionId: OpencodeSessionId
  binding: SessionBinding
  observerGeneration: number
  turnEpoch: number
  seq: number
  /** opencode's own view: is a turn running right now? Fed by session.status /
   *  session.idle, never guessed. */
  busy: boolean
  /** An abort was requested and no terminal event has landed yet. The fence's
   *  verdict reads this so an interrupted turn is reported as interrupted. */
  interruptPending: boolean
  interactions: Map<string, PendingInteraction>
  /** Asks this driver saw CLOSE, so a second answer is `already-answered`
   *  rather than `unknown-interaction`. The distinction is the whole of the
   *  idempotence property: a caller retrying an answer must be told the first
   *  one landed, not that its ask never existed. */
  answered: Set<string>
  /** Message info by id, so an orphaned `message.part.updated` can be mapped.
   *  Bounded by the session's message count, which is what the transcript is. */
  messages: Map<string, OpencodeMessageInfo>
  queue: QueuedTurn[]
  lease: SessionLease | null
  draft: string
  watchers: { coarse: number; fine: number }
  log: { seq: number; event: RuntimeEvent }[]
  wakers: Set<() => void>
  state: AgentRuntimeState
  stream: AbortController
  disposed: boolean
  /** Resolvers waiting for the session to go idle — `when-ready` sends and the
   *  queue drain both park here rather than polling. */
  idleWaiters: Set<() => void>
}

export interface OpencodeRuntime {
  driver: RuntimeDriver
  handleFor(sessionId: SessionId): AgentSessionHandle | undefined
  /** Drop a session's handle and stop its stream, without touching the process.
   *  What a supervisor restart looks like from inside this process. */
  forget(sessionId: SessionId): void
  dispose(): void
}

/**
 * Build the driver over a host.
 *
 * ONE RUNTIME PER HOST, MANY SESSIONS. The `streamPositions` map outside the
 * per-session state is why: an `adopt()` inside one process must not rewind
 * `seq`, or events after a rebind would compare as older than events a consumer
 * already accepted — "a replayed stream that looks like new work", which is the
 * exact thing the monotonicity property forbids.
 */
export function createOpencodeRuntime(host: OpencodeRuntimeHost): OpencodeRuntime {
  const sessions = new Map<SessionId, DriverSession>()
  const handles = new Map<SessionId, AgentSessionHandle>()
  const streamPositions = new Map<string, { seq: number; turnEpoch: number }>()
  const capabilities = opencodeServerCapabilities()

  const iso = (ms?: number): string => new Date(ms ?? host.now()).toISOString()

  // -- the event stream -----------------------------------------------------

  function emit(
    session: DriverSession,
    body: RuntimeEventBody,
    at: string,
    provenance: ObservationProvenance = 'live',
  ): void {
    if (session.disposed) return
    session.seq += 1
    streamPositions.set(session.binding.process.key, {
      seq: session.seq,
      turnEpoch: session.turnEpoch,
    })
    const event = stampRuntimeEvent(body, at, provenance, {
      cursor: cursorFor(session, session.seq),
      observerGeneration: session.observerGeneration,
      turnEpoch: session.turnEpoch,
    })
    session.log.push({ seq: session.seq, event })
    if (session.log.length > OPENCODE_EVENT_LOG_LIMIT) {
      session.log.splice(0, session.log.length - OPENCODE_EVENT_LOG_LIMIT)
    }
    for (const wake of [...session.wakers]) wake()
    persist(session)
  }

  /**
   * THE CURSOR: opencode's session id as the segment, this stream's ordinal as
   * the position.
   *
   * opencode's own `evt_…` ids are ascending but not numeric, and its SSE stream
   * carries no ordinal at all — so the driver maintains one and persists the
   * high-water mark in the journal, exactly as the plan prescribes. The segment
   * is the opencode session id, which makes a cursor from one session
   * incomparable with another's rather than accidentally ordered against it.
   */
  const cursorFor = (session: DriverSession, seq: number): ProviderCursor => {
    if (!session.opencodeSessionId) return driverLocalCursor(session.binding.process.key, seq)
    return { segmentId: session.opencodeSessionId, components: { seq } }
  }

  const persist = (session: DriverSession): void => {
    host.journal.write({
      sessionId: session.sessionId,
      opencodeSessionId: session.opencodeSessionId,
      baseUrl: session.endpoint.baseUrl,
      username: session.endpoint.username,
      secret: session.endpoint.password,
      workdir: session.spec.workdir,
      process: session.binding.process,
      seq: session.seq,
      turnEpoch: session.turnEpoch,
      bindingVersion: session.binding.bindingVersion,
    })
  }

  // -- SSE ingestion --------------------------------------------------------

  /**
   * Fold one opencode event into the session.
   *
   * THE FIRST LINE IS THE CHILD-SESSION FILTER, and it is not defensive
   * programming: opencode runs subagents as CHILD SESSIONS with their own
   * `ses_…` ids on the SAME event bus. A driver that skipped this check would
   * watch a subagent's `session.idle` flip its parent to idle mid-turn, drain
   * the parent's queue into a running turn, and fence a turn epoch that is still
   * open. The plan names it; this is where it is enforced.
   */
  function ingest(session: DriverSession, event: OpencodeEvent): void {
    const subject = eventSessionId(event)
    if (subject !== undefined && subject !== session.opencodeSessionId) return
    const at = iso(eventTimeMs(event))

    switch (event.type) {
      case 'message.updated': {
        session.messages.set(event.properties.info.id, event.properties.info)
        break
      }
      case 'message.part.updated': {
        const info = session.messages.get(event.properties.part.messageID)
        // No message info yet means we have not seen this part's message — the
        // item's ROLE is unknowable, and an item with a guessed role is worse
        // than a missing one. The message.updated that carries it always
        // arrives; when it does, the part's next update maps.
        if (!info) break
        for (const item of partToItems(session.opencodeSessionId, info, event.properties.part)) {
          emit(session, { t: 'item', item: { kind: 'complete', item } }, at)
        }
        break
      }
      case 'message.part.delta': {
        // FINE WATCH ONLY. Token fragments are live-only by nature and exist to
        // make a viewer's chat feel live; emitting them with nobody watching is
        // the always-on token stream the two watch levels exist to avoid.
        if (session.watchers.fine <= 0) break
        if (event.properties.field !== 'text') break
        const delta = event.properties.delta
        if (!delta) break
        emit(
          session,
          {
            t: 'item',
            item: {
              kind: 'delta',
              // Keyed by the PART, which is the identity a `complete` item
              // carries in its `cursor`. See `deltaItemIdOf` in ./map.ts for
              // why the item's own `id` cannot be this key.
              itemId: event.properties.partID,
              textDelta: delta,
            },
          },
          at,
        )
        break
      }
      case 'session.status': {
        const wasBusy = session.busy
        session.busy = event.properties.status.type !== 'idle'
        const change = statusToStateEvent(event.properties.status, at)
        if (change) emit(session, { t: 'state', change }, at)
        // Opening a turn is what `busy` means, and the epoch is what every
        // subsequent event is fenced against.
        if (!wasBusy && session.busy) {
          emit(session, { t: 'turn', ev: { ev: 'started', turnEpoch: session.turnEpoch, origin: 'human' } }, at)
        }
        break
      }
      case 'session.idle': {
        closeTurn(session, at)
        break
      }
      case 'session.compacted': {
        // The re-prime boundary for `SessionSpec.instructions`. Reported through
        // the shared state vocabulary so the consumer that re-primes is the same
        // one for every family.
        emit(session, { t: 'state', change: { kind: 'compaction', phase: 'end', at } }, at)
        break
      }
      case 'session.error': {
        const detail = describeError(event.properties.error)
        emit(
          session,
          {
            t: 'turn',
            ev: {
              ev: 'failed',
              turnEpoch: session.turnEpoch,
              reason: detail.reason,
              disposition: detail.disposition,
              ...(detail.text ? { detail: detail.text } : {}),
            },
          },
          at,
        )
        emit(
          session,
          { t: 'state', change: { kind: 'turn_failed', errorClass: detail.reason, retryable: detail.disposition === 'retryable', at } },
          at,
        )
        break
      }
      case 'permission.asked': {
        openAsk(
          session,
          permissionAsk({
            id: event.properties.id,
            sessionId: session.sessionId,
            permission: event.properties.permission,
            patterns: event.properties.patterns,
            metadata: event.properties.metadata,
            always: event.properties.always,
            askedAt: at,
          }),
          at,
        )
        break
      }
      case 'question.asked': {
        openAsk(
          session,
          questionAsk({
            id: event.properties.id,
            sessionId: session.sessionId,
            questions: event.properties.questions,
            askedAt: at,
          }),
          at,
        )
        break
      }
      case 'permission.replied':
      case 'question.replied':
      case 'question.rejected': {
        // CLOSED BY THE PROVIDER'S OWN CONFIRMATION, whoever answered. A human
        // at an `opencode attach` TUI answers the same ask this driver can, and
        // the aggregate must see it close either way — an ask that stayed open
        // because Podium was not the one who answered it is a session that
        // reports itself blocked while it works.
        closeAsk(session, event.properties.requestID, at, 'human')
        break
      }
      case 'session.updated':
      case 'session.created':
      case 'server.connected':
        break
    }
  }

  function openAsk(session: DriverSession, interaction: PendingInteraction, at: string): void {
    session.interactions.set(interaction.id, interaction)
    emit(session, { t: 'interaction', ev: { ev: 'asked', interaction } }, at)
    emit(
      session,
      {
        t: 'state',
        change: {
          kind: 'needs_user',
          need: interaction.kind === 'permission' ? 'permission' : 'question',
          ...(interaction.kind === 'permission' && interaction.payload.inputSummary
            ? { summary: interaction.payload.inputSummary }
            : {}),
          at,
        },
      },
      at,
    )
  }

  function closeAsk(
    session: DriverSession,
    id: string,
    at: string,
    answeredBy: 'policy' | 'superagent' | 'human',
  ): void {
    if (!session.interactions.delete(id)) return
    emit(session, { t: 'interaction', ev: { ev: 'answered', id, answeredBy, at } }, at)
  }

  /**
   * Reconcile the open asks against the SERVER, which is the only place they
   * are actually true.
   *
   * THE SSE STREAM IS NOT ENOUGH, AND THE TWO GAPS ARE REAL. It is live-only, so
   * an ask raised while a socket was reconnecting never reaches the stream; and
   * a human at an `opencode attach` TUI can ANSWER an ask the stream told us
   * about, which the stream also reports but only if we are connected to hear
   * it. Both gaps end with a session whose blocked-ness is wrong in one
   * direction or the other, and both are closed by asking the server.
   *
   * It runs before every `send()`, every `interactions()` and every `answer()`
   * of an ask we do not recognize — three loopback GETs' worth of latency at the
   * moments where being wrong costs the most. `send()` in particular: refusing
   * `needs_user` is the mechanism by which a blocked session stays visibly
   * blocked instead of accumulating turns behind an unanswered question.
   */
  async function refreshInteractions(session: DriverSession): Promise<void> {
    let permissions: readonly { id: string; permission: string; patterns: readonly string[]; metadata: Record<string, unknown>; always: readonly string[]; sessionID: string }[]
    let questions: readonly { id: string; questions: readonly OpencodeQuestionInfo[]; sessionID: string }[]
    try {
      ;[permissions, questions] = await Promise.all([
        session.client.permissions(),
        session.client.questions(),
      ])
    } catch {
      // A server we cannot reach tells us nothing about its asks. Keeping what
      // the stream last said beats replacing it with an empty list, which would
      // report a blocked session as ready.
      return
    }
    const at = iso()
    const live = new Map<string, PendingInteraction>()
    for (const request of permissions) {
      // The CHILD-SESSION FILTER again: `/permission` is directory-scoped, not
      // session-scoped, so a subagent's ask is in this list too.
      if (request.sessionID !== session.opencodeSessionId) continue
      live.set(
        request.id,
        session.interactions.get(request.id) ??
          permissionAsk({
            id: request.id,
            sessionId: session.sessionId,
            permission: request.permission,
            patterns: request.patterns,
            metadata: request.metadata,
            always: request.always,
            askedAt: at,
          }),
      )
    }
    for (const request of questions) {
      if (request.sessionID !== session.opencodeSessionId) continue
      live.set(
        request.id,
        session.interactions.get(request.id) ??
          questionAsk({
            id: request.id,
            sessionId: session.sessionId,
            questions: request.questions,
            askedAt: at,
          }),
      )
    }
    // Anything we thought was open and the server does not list was answered
    // elsewhere — by a human at the TUI, or by opencode itself timing it out.
    // It closes here, so the aggregate never shows an ask nobody can answer.
    for (const id of [...session.interactions.keys()]) {
      if (!live.has(id)) {
        session.answered.add(id)
        closeAsk(session, id, at, 'human')
      }
    }
    for (const [id, interaction] of live) {
      if (!session.interactions.has(id)) openAsk(session, interaction, at)
    }
  }

  /**
   * The turn fence.
   *
   * ABSORBING, AND ONLY THE PROVIDER OPENS IT. `session.idle` is opencode saying
   * the turn ended; the epoch advances here and nowhere else. `interrupt()` does
   * not call this — it asks opencode to stop and waits for the same event every
   * other completion arrives on, which is what "fences only on provider
   * confirmation" means in code rather than in a comment.
   */
  function closeTurn(session: DriverSession, at: string): void {
    if (!session.busy && session.turnEpoch === 0) return
    const verdict = session.interruptPending
      ? 'interrupted'
      : session.interactions.size > 0
        ? 'question'
        : 'done'
    session.busy = false
    session.interruptPending = false
    emit(session, { t: 'turn', ev: { ev: 'completed', turnEpoch: session.turnEpoch, verdict } }, at)
    emit(session, { t: 'state', change: idleToStateEvent(verdict, at) }, at)
    session.state = { phase: 'idle', since: at, nativeSubagentCount: 0 }
    for (const wake of [...session.idleWaiters]) wake()
    session.idleWaiters.clear()
    void drainQueue(session)
  }

  /** opencode's error union → the contract's failure vocabulary. Unknown shapes
   *  are `provider-error`/`retryable`: a failure we cannot classify is still a
   *  failure, and guessing `fatal` would end a session a retry might save. */
  function describeError(error: unknown): {
    reason: 'rate-limit' | 'auth-expired' | 'context-overflow' | 'provider-error' | 'timeout' | 'interrupted'
    disposition: 'retryable' | 'needs-human' | 'fatal'
    text?: string
  } {
    const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : ''
    const text = typeof error === 'object' && error !== null ? JSON.stringify(error).slice(0, 500) : undefined
    if (name.includes('ProviderAuth')) return { reason: 'auth-expired', disposition: 'needs-human', ...(text ? { text } : {}) }
    if (name.includes('ContextOverflow')) return { reason: 'context-overflow', disposition: 'needs-human', ...(text ? { text } : {}) }
    if (name.includes('MessageAborted')) return { reason: 'interrupted', disposition: 'retryable', ...(text ? { text } : {}) }
    if (name.includes('MessageOutputLength')) return { reason: 'provider-error', disposition: 'retryable', ...(text ? { text } : {}) }
    return { reason: 'provider-error', disposition: 'retryable', ...(text ? { text } : {}) }
  }

  // -- the stream loop ------------------------------------------------------

  /**
   * Consume `/event` until the session is disposed, reconnecting on drop.
   *
   * RECONNECT DOES NOT REPLAY, and it cannot: opencode's stream delivers only
   * what happens after a subscriber connects. That is what makes the cursor
   * discipline simple here — there is nothing to fence out — and it is also the
   * gap this driver is honest about: events that occur between a drop and a
   * reconnect are LOST to the stream, and the recovery is `snapshot()`, whose
   * bootstrap re-reads state and open interactions from the server itself.
   */
  function consume(session: DriverSession): void {
    void (async () => {
      while (!session.disposed && !session.stream.signal.aborted) {
        try {
          for await (const event of session.client.events(session.stream.signal)) {
            if (session.disposed) return
            ingest(session, event)
          }
        } catch {
          // A dropped SSE socket is a transport fact, not a session failure —
          // the session may be perfectly alive behind it. The contract is
          // explicit that conflating the two is how ghost sessions happen, so
          // nothing is emitted here.
        }
        if (session.disposed || session.stream.signal.aborted) return
        await sleep(250)
        // Did the server actually die? Then say so on the PROCESS channel,
        // which is where a dead process belongs, and stop reconnecting.
        if (!(await session.client.health())) {
          if (session.disposed) return
          const at = iso()
          const ev: ProcessEvent = { ev: 'exited', code: null, signal: null, classification: 'crashed' }
          emit(session, { t: 'process', ev }, at)
          return
        }
      }
    })()
  }

  // -- sending --------------------------------------------------------------

  async function deliver(
    session: DriverSession,
    input: TurnInput,
    origin: SendOptions['origin'] = 'human',
  ): Promise<void> {
    const model = modelFor(session.spec, input)
    await session.client.prompt(session.opencodeSessionId, {
      parts: [{ type: 'text', text: input.text }],
      ...(model ? { model } : {}),
      ...(session.spec.model.effort ? { variant: session.spec.model.effort } : {}),
    })
    // The 204 IS the acceptance, and it is also the moment the turn opens as far
    // as this driver is concerned. opencode's `session.status: busy` confirms it
    // microseconds later; the epoch advances here so the receipt can name it.
    session.turnEpoch += 1
    session.busy = true
    session.state = { phase: 'working', since: iso(), nativeSubagentCount: 0 }
    /**
     * THE EPOCH IS DURABLE FROM THE MOMENT THE TURN OPENS, not from the moment
     * an event happens to be emitted.
     *
     * Both carriers are written here: the in-process stream position (keyed by
     * the PROCESS, so an `adopt()` within one daemon life cannot rewind it) and
     * the journal (so it survives the daemon itself). Leaving this to `emit()`
     * made the epoch's durability depend on an SSE frame ARRIVING, and a
     * supervisor restart in the window between the 204 and the first
     * `session.status` rebound the session at epoch 0 — a replayed stream that
     * looks like new work, which is exactly what the monotonicity property
     * forbids. Caught by the corpus's snapshot→adopt round-trip.
     */
    streamPositions.set(session.binding.process.key, {
      seq: session.seq,
      turnEpoch: session.turnEpoch,
    })
    persist(session)
    /**
     * SAY THE TURN OPENED, at the moment the 204 proves it did.
     *
     * Without this the epoch moved and the stream said nothing, so a consumer
     * learned about a new turn only when the next unrelated event happened to
     * carry the new number. The status handler still emits `started` for a turn
     * opened by SOMEONE ELSE — a human at an attached `opencode attach` TUI —
     * and the two cannot double up, because it fires only on the busy
     * transition and this path has already set `busy`.
     */
    emit(
      session,
      { t: 'turn', ev: { ev: 'started', turnEpoch: session.turnEpoch, origin } },
      iso(),
    )
  }

  /**
   * Per-turn model override, or the session's sticky policy.
   *
   * NOTE THE KEY NAME: `modelID` on a prompt, `id` on a session. opencode is
   * asymmetric here and a 400 from getting it wrong names neither field.
   */
  function modelFor(
    spec: SessionSpec,
    input: TurnInput,
  ): { providerID: string; modelID: string } | undefined {
    const override = input.overrides?.supported ? input.overrides.value.model : undefined
    const raw = override ?? spec.model.model
    if (!raw || raw === 'auto') return undefined
    const slash = raw.indexOf('/')
    // `provider/model` is how every Podium surface names an opencode model, and
    // it is what the manifest's `-m` flag already takes. A bare id has no
    // provider to send it to, so it is left to opencode's own default.
    if (slash <= 0) return undefined
    return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) }
  }

  async function drainQueue(session: DriverSession): Promise<void> {
    while (session.queue.length > 0 && !session.busy && !session.disposed) {
      // A queued turn must not jump an open ask: the session is blocked, and
      // sending into it would bury the question the user has to answer.
      if (session.interactions.size > 0) return
      const next = session.queue.shift()
      if (!next) return
      try {
        await deliver(session, next.input, next.options.origin)
      } catch {
        // The turn could not be delivered and the caller is long gone — its
        // receipt said `queued`, which was true. Dropping it silently would be
        // worse than the process event the stream loop will raise if the server
        // is actually dead, so nothing is invented here.
        return
      }
    }
  }

  const waitForIdle = (session: DriverSession, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (!session.busy) {
        resolve(true)
        return
      }
      const done = (value: boolean): void => {
        session.idleWaiters.delete(waker)
        clearTimeout(timer)
        resolve(value)
      }
      const waker = (): void => done(true)
      const timer = setTimeout(() => done(false), timeoutMs)
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      session.idleWaiters.add(waker)
    })

  // -- handle construction --------------------------------------------------

  function buildHandle(session: DriverSession): AgentSessionHandle {
    const refuse = (reason: Refusal['reason'], detail?: string): TurnReceipt => ({
      outcome: 'refused',
      refusal: { reason, ...(detail ? { detail } : {}) },
    })

    const handle: AgentSessionHandle = {
      get binding() {
        return session.binding
      },

      // ---- lifecycle ----
      async stop() {
        session.disposed = true
        session.stream.abort()
        await session.endpoint.stop()
        handles.delete(session.sessionId)
        sessions.delete(session.sessionId)
      },

      async hibernate() {
        // NEVER REFUSES, and the capability says why: `POST /session` mints
        // `ses_…` before the first turn, so a resume ref exists from the moment
        // the handle does. The server process dies, the conversation does not —
        // it is rows in a database that outlives it, which is exactly the
        // property that makes a server-family session cheap to park.
        if (!session.binding.resume) {
          return { reason: 'no_resume_ref' as const }
        }
        session.stream.abort()
        await session.endpoint.stop()
        session.disposed = true
        handles.delete(session.sessionId)
        sessions.delete(session.sessionId)
        return { ok: true as const }
      },

      async kill() {
        session.disposed = true
        session.stream.abort()
        await session.endpoint.kill()
        host.journal.clear(session.sessionId)
        streamPositions.delete(session.binding.process.key)
        handles.delete(session.sessionId)
        sessions.delete(session.sessionId)
      },

      async health(): Promise<SessionHealth> {
        const alive = await session.client.health()
        const bytes = session.endpoint.memoryBytes()
        return {
          alive,
          ...(bytes !== undefined ? { memoryBytes: bytes } : {}),
          ...(session.binding.process.scopeUnit
            ? { scopeUnit: session.binding.process.scopeUnit }
            : {}),
          // Not observed: nothing in this driver watches the cgroup's OOM
          // counter, and a hardcoded 0 would read as "this session has never
          // been OOM-killed", which is a claim rather than a measurement.
          oomEvents: 0,
        }
      },

      // ---- identity ----
      async snapshot(): Promise<SessionSnapshot> {
        return {
          binding: session.binding,
          state: session.state,
          cursor: cursorFor(session, session.seq),
          observerGeneration: session.observerGeneration,
          turnEpoch: session.turnEpoch,
          interactions: [...session.interactions.values()],
          ...(session.draft ? { draft: session.draft } : {}),
          at: iso(),
        }
      },

      async export(): Promise<SessionArchive> {
        const messages = await session.client.messages(session.opencodeSessionId)
        const resume: ResumeRef = session.binding.resume ?? {
          kind: 'opencode-session',
          value: session.opencodeSessionId,
        }
        return {
          harness: 'opencode',
          formatVersion: 1,
          resume,
          files: [
            {
              // Archive-relative, never absolute: an absolute path is a promise
              // about the DESTINATION machine the source cannot make.
              path: `opencode/${session.opencodeSessionId}/messages.json`,
              bytes: new TextEncoder().encode(JSON.stringify(messages, null, 2)),
            },
          ],
          binding: {
            sessionId: session.binding.sessionId,
            driver: session.binding.driver,
            family: session.binding.family,
            harness: session.binding.harness,
            workdir: session.binding.workdir,
            resume,
            ...(session.binding.principal ? { principal: session.binding.principal } : {}),
          },
        }
      },

      // ---- turns ----
      async send(input: TurnInput, options: SendOptions): Promise<TurnReceipt> {
        if (session.disposed) return refuse('not_running')
        await refreshInteractions(session)
        // ORDER MATTERS AND IS NOT ARBITRARY. An open ask blocks EVERY delivery,
        // including a queue, because the session is stopped waiting for a human
        // and a turn stacked behind that ask buries it.
        if (session.interactions.size > 0) {
          return refuse('needs_user', `${session.interactions.size} interaction(s) awaiting an answer`)
        }
        if (session.lease?.kind === 'human-controller' && options.principal?.ref !== session.lease.holder) {
          // A human holds the terminal. The contract's own note is that headless
          // drivers QUEUE rather than interleave, and this driver has a real
          // queue — so the nudge lands after the takeover ends instead of being
          // thrown away.
          session.queue.push({ input, options })
          return { outcome: 'queued', position: session.queue.length, deliveredAs: 'queue', at: iso() }
        }

        const wanted = options.delivery
        if (wanted === 'queue' || wanted === 'steer') {
          if (session.busy || session.queue.length > 0) {
            session.queue.push({ input, options })
            return {
              outcome: 'queued',
              position: session.queue.length,
              // THE DOWNGRADE, REPORTED. opencode has no steer verb — a prompt
              // POSTed into an open turn becomes a separate turn afterwards —
              // so `steer` is answered as what it actually was.
              deliveredAs: 'queue',
              at: iso(),
            }
          }
        }

        if (wanted === 'interrupt' && session.busy) {
          session.interruptPending = true
          try {
            await session.client.abort(session.opencodeSessionId)
          } catch (err) {
            return refuse('not_running', String(err))
          }
          // Wait for opencode's own confirmation that the turn ended before
          // typing over it. Manufacturing the fence here is exactly what
          // `fenceOnProviderConfirmation` promises not to do.
          await waitForIdle(session, WHEN_READY_TIMEOUT_MS)
        } else if (session.busy) {
          const idle = await waitForIdle(session, WHEN_READY_TIMEOUT_MS)
          if (!idle) return refuse('busy', 'a turn was still open when the ready window closed')
          if (session.interactions.size > 0) return refuse('needs_user')
        }

        try {
          await deliver(session, input, options.origin)
        } catch (err) {
          return refuse('not_running', String(err))
        }
        return {
          outcome: 'accepted',
          turnEpoch: session.turnEpoch,
          // Never `steer` — see `send.native` in ./capabilities.ts.
          deliveredAs: wanted === 'steer' ? 'queue' : wanted,
          /** The 204 from `prompt_async`. The only proof this driver declares,
           *  and the only one it needs. */
          provenBy: 'protocol-ack',
          at: iso(),
        }
      },

      async stageAttachment(): Promise<AttachmentRef> {
        // opencode's prompt takes `FilePartInput`s that reference a path on the
        // SESSION's machine, and this driver has no way to put bytes there — the
        // server is a process, not a filesystem service. Throwing names the gap;
        // returning a ref to a file that does not exist would fail one layer
        // later with nothing to read.
        throw new Error('opencode-server does not stage attachments: no upload channel is exposed')
      },

      async interrupt(): Promise<void> {
        if (session.disposed || !session.busy) return
        session.interruptPending = true
        // REQUESTS the stop. The fence arrives on `session.idle` like every other
        // turn end, which is why nothing is returned to await.
        await session.client.abort(session.opencodeSessionId).catch(() => {})
      },

      async answer(
        interactionId: string,
        answer: unknown,
        options?: AnswerOptions,
      ): Promise<InteractionAnswerOutcome> {
        if (!session.interactions.has(interactionId) && !session.answered.has(interactionId)) {
          // An ask we have not heard of is the case where reconciling pays for
          // itself: the stream may simply not have delivered it yet, and
          // answering "unknown" to an ask the server is holding open would
          // strand the session on a question a surface can see.
          await refreshInteractions(session)
        }
        const ask = session.interactions.get(interactionId)
        if (!ask) {
          // ALREADY-ANSWERED vs UNKNOWN is a real distinction and this driver can
          // draw it: an ask it saw and closed is remembered for exactly this.
          return session.answered.has(interactionId)
            ? { ok: false, reason: 'already-answered' }
            : { ok: false, reason: 'unknown-interaction' }
        }
        const action = answerAction(ask, normalizeAnswer(ask, answer))
        if (action.call === 'refuse') {
          // A refusal here leaves the ask OPEN, which is the point: the session
          // stays visibly blocked rather than reporting an answer that never
          // reached the agent.
          return { ok: false, reason: 'not-yet-supported' }
        }
        try {
          if (action.call === 'permission') {
            await session.client.replyPermission(ask.id, action.reply, action.message)
          } else if (action.call === 'question') {
            await session.client.replyQuestion(ask.id, action.answers)
          } else {
            await session.client.rejectQuestion(ask.id)
          }
        } catch {
          return { ok: false, reason: 'not-yet-supported' }
        }
        session.answered.add(interactionId)
        closeAsk(
          session,
          interactionId,
          iso(),
          options?.principal?.kind === 'agent' ? 'superagent' : options?.principal?.kind === 'system' ? 'policy' : 'human',
        )
        return { ok: true }
      },

      async interactions(): Promise<readonly PendingInteraction[]> {
        await refreshInteractions(session)
        return [...session.interactions.values()]
      },

      // ---- observation ----
      events(after: EventStreamStart): AsyncIterable<RuntimeEvent> {
        return {
          async *[Symbol.asyncIterator]() {
            // EXACTLY ONE SNAPSHOT OPENS A STREAM. `'bootstrap'` replays what is
            // already known, tagged so a consumer never applies live effects from
            // it; a cursor resumes strictly AFTER that position.
            let position =
              after === 'bootstrap'
                ? 0
                : session.log.findIndex((entry) => entry.seq > Number(after.components.seq ?? 0))
            if (position < 0) position = session.log.length
            const bootstrapUntil = after === 'bootstrap' ? session.seq : 0
            while (true) {
              while (position < session.log.length) {
                const entry = session.log[position]
                position += 1
                if (!entry) continue
                yield entry.seq <= bootstrapUntil
                  ? ({ ...entry.event, provenance: 'bootstrap' } as RuntimeEvent)
                  : entry.event
              }
              if (session.disposed) return
              await new Promise<void>((resolve) => {
                const waker = (): void => {
                  session.wakers.delete(waker)
                  resolve()
                }
                session.wakers.add(waker)
              })
            }
          },
        }
      },

      async watch(level: WatchLevel): Promise<() => void> {
        session.watchers[level] += 1
        let released = false
        return () => {
          // IDEMPOTENT. A viewer that disconnected twice must not drive the
          // refcount negative and leave a fine watch on forever — which is the
          // always-on token stream the levels exist to avoid.
          if (released) return
          released = true
          session.watchers[level] = Math.max(0, session.watchers[level] - 1)
        }
      },

      async state(): Promise<AgentRuntimeState> {
        return session.state
      },

      transcript: {
        async history(range): Promise<readonly TranscriptItem[]> {
          const messages = await session.client.messages(session.opencodeSessionId)
          const items: TranscriptItem[] = []
          for (const message of messages) {
            for (const part of message.parts) {
              items.push(...partToItems(session.opencodeSessionId, message.info, part))
            }
          }
          /**
           * `before` is the newest window — the same default the on-switch read
           * uses, and what a `history({ limit })` with no anchor means.
           *
           * THE ANCHOR IS A POSITION, NOT A STRING, because `ProviderCursor
           * .components` is `Record<string, number>` by schema: there is
           * nowhere in it to carry a transcript cursor string. opencode's parts
           * are a BOUNDED, fully-ordered list (that is the argument
           * `sliceItemsByAnchor` already makes for the sqlite source), so an
           * index into that order is a real cursor rather than a stand-in — and
           * `components.item` is where this driver puts it. A cursor from
           * another session carries a different `segmentId` and is refused
           * rather than compared, which is the whole reason the segment is on
           * the cursor at all.
           */
          if (!range.from) return items.slice(-range.limit)
          if (range.from.segmentId !== session.opencodeSessionId) return items.slice(-range.limit)
          const anchor = range.from.components.item
          if (anchor === undefined) return items.slice(-range.limit)
          return items.slice(anchor + 1, anchor + 1 + range.limit)
        },
      },

      // ---- attach and lease ----
      async attach(req: AttachRequest): Promise<AttachEndpoint | Refusal> {
        const client = await host.attachClient({
          sessionId: session.sessionId,
          url: session.endpoint.baseUrl,
          mode: req.mode,
        })
        if (!client) {
          return {
            reason: 'unsupported',
            detail: 'this machine cannot host a client terminal for the session',
          }
        }
        if (req.mode === 'takeover') {
          session.lease = {
            holder: req.holder,
            kind: 'human-controller',
            acquiredAt: iso(),
          }
        }
        return {
          // The server family's variant: opencode's OWN TUI (`opencode attach
          // <url>`) pointed at this session's server, hosted beside it rather
          // than being it.
          kind: 'client',
          placement: 'on-machine',
          stream: { id: client.streamId },
          warm: { ttlMs: client.warmTtlMs },
        }
      },

      lease: {
        async acquire(holder, kind): Promise<SessionLease | Refusal> {
          if (session.lease && session.lease.holder !== holder) {
            return { reason: 'lease_held', detail: `held by ${session.lease.holder}` }
          }
          session.lease = { holder, kind, acquiredAt: iso() }
          return session.lease
        },
        async release(holder) {
          if (session.lease?.holder === holder) session.lease = null
        },
        async state() {
          return session.lease
        },
      },

      // ---- extended ----
      draft: {
        async get() {
          return session.draft
        },
        async set(text: string) {
          session.draft = text
          return { ok: true as const }
        },
      },

      async configure(_request: ConfigureRequest) {
        return {
          reason: 'unsupported' as const,
          detail: 'model and permission mode are set at create and per turn on this driver',
        }
      },

      async usage(): Promise<UsageSnapshot | Refusal> {
        try {
          const info = await session.client.getSession(session.opencodeSessionId)
          return {
            ...(info.tokens ? { inputTokens: info.tokens.input, outputTokens: info.tokens.output } : {}),
            ...(info.cost !== undefined ? { costUsd: info.cost } : {}),
          }
        } catch (err) {
          return { reason: 'not_running', detail: String(err) }
        }
      },
    }

    return handle
  }

  /**
   * Coerce the contract's `unknown` answer into the typed vocabulary.
   *
   * THE CONFORMANCE CORPUS ANSWERS WITH SHORTHAND — `{decision:'allow'}` for a
   * permission, `{index:0}` for a question — because it is written against every
   * driver at once and predates the typed vocabulary POD-2020 landed. Rather
   * than make the corpus driver-specific, the shorthand is widened HERE, where
   * the ask's kind is known. A payload that is already typed passes through
   * untouched.
   */
  function normalizeAnswer(ask: PendingInteraction, answer: unknown): InteractionAnswer {
    const raw = (answer ?? {}) as Record<string, unknown>
    if (typeof raw.kind === 'string') return raw as unknown as InteractionAnswer
    if (ask.kind === 'permission') {
      const decision = raw.decision
      return {
        kind: 'permission',
        decision:
          decision === 'deny' || decision === 'reject'
            ? 'deny'
            : decision === 'allow-always' || decision === 'always'
              ? 'allow-always'
              : 'allow-once',
      }
    }
    if (ask.kind === 'question') {
      const index = typeof raw.index === 'number' ? raw.index : 0
      return {
        kind: 'question',
        // 1-BASED on the wire; the shorthand is 0-based, and the conversion
        // happens once here rather than at every answering surface.
        selections: ask.payload.questions.map(() => ({ optionIndices: [index + 1] })),
      }
    }
    return { kind: 'recovery', choice: 'full-resume' }
  }

  // -- driver ---------------------------------------------------------------

  async function attachSession(input: {
    sessionId: SessionId
    spec: SessionSpec
    endpoint: OpencodeServerEndpoint
    opencodeSessionId: OpencodeSessionId
    bindingVersion: number
    observerGeneration: number
  }): Promise<AgentSessionHandle> {
    const make = host.makeClient ?? createOpencodeClient
    const client = make({
      baseUrl: input.endpoint.baseUrl,
      username: input.endpoint.username,
      password: input.endpoint.password,
      directory: input.spec.workdir,
    })
    const carried = streamPositions.get(input.endpoint.process.key)
    const journalled = host.journal.read(input.sessionId)
    const session: DriverSession = {
      sessionId: input.sessionId,
      spec: input.spec,
      endpoint: input.endpoint,
      client,
      opencodeSessionId: input.opencodeSessionId,
      binding: {
        sessionId: input.sessionId,
        driver: OPENCODE_SERVER_DRIVER_ID,
        family: 'server',
        harness: 'opencode',
        workdir: input.spec.workdir,
        resume: { kind: 'opencode-session', value: input.opencodeSessionId },
        ...(input.spec.principal ? { principal: input.spec.principal } : {}),
        process: input.endpoint.process,
        bindingVersion: input.bindingVersion,
      },
      observerGeneration: input.observerGeneration,
      // MONOTONIC ACROSS A REBIND, and both sources matter: within one process
      // the in-memory position carries it, across a process restart the journal
      // does. Resetting either is how a replayed stream looks like new work.
      turnEpoch: Math.max(carried?.turnEpoch ?? 0, journalled?.turnEpoch ?? 0),
      seq: Math.max(carried?.seq ?? 0, journalled?.seq ?? 0),
      busy: false,
      interruptPending: false,
      interactions: new Map(),
      answered: new Set(),
      messages: new Map(),
      queue: [],
      lease: null,
      draft: '',
      watchers: { coarse: 0, fine: 0 },
      log: [],
      wakers: new Set(),
      state: { phase: 'idle', since: iso(), nativeSubagentCount: 0 },
      stream: new AbortController(),
      disposed: false,
      idleWaiters: new Set(),
    }
    sessions.set(input.sessionId, session)
    persist(session)
    consume(session)

    // BOOTSTRAP THE OPEN ASKS FROM THE SERVER, not from memory. A session being
    // adopted may have been blocked on a permission the whole time this process
    // was down; a handle that started with an empty interaction list would
    // report it unblocked and let the queue drain into a stopped session.
    await hydrate(session)
    // …and the open asks with it. A session adopted mid-block must come back
    // knowing it is blocked, or its queue drains into a stopped agent.
    await refreshInteractions(session)

    const handle = buildHandle(session)
    handles.set(input.sessionId, handle)
    return handle
  }

  /** Read the session's live truth once, at bind time. */
  async function hydrate(session: DriverSession): Promise<void> {
    try {
      const messages = await session.client.messages(session.opencodeSessionId)
      for (const message of messages) session.messages.set(message.info.id, message.info)
      const last = messages[messages.length - 1]
      // An assistant message with no completion time is a turn still running.
      session.busy = last?.info.role === 'assistant' && last.info.time?.completed === undefined
      session.state = {
        phase: session.busy ? 'working' : 'idle',
        since: iso(last?.info.time?.created),
        nativeSubagentCount: 0,
      }
    } catch {
      // A hydrate that fails leaves the session at its constructed defaults,
      // which are the honest "we have not observed anything yet" — the stream
      // corrects them the moment opencode says otherwise.
    }
  }

  const driver: RuntimeDriver = {
    id: OPENCODE_SERVER_DRIVER_ID,
    harness: 'opencode',
    family: 'server',
    capabilities: () => capabilities,

    async create(spec: SessionSpec): Promise<AgentSessionHandle> {
      const sessionId = host.mintSessionId()
      const secret = host.randomSecret()
      const username = 'podium'
      const endpoint = await host.launch({
        sessionId,
        workdir: spec.workdir,
        secret,
        username,
        ...(spec.env ? { env: spec.env } : {}),
      })
      const make = host.makeClient ?? createOpencodeClient
      const bootstrap = make({
        baseUrl: endpoint.baseUrl,
        username: endpoint.username,
        password: endpoint.password,
        directory: spec.workdir,
      })
      // `POST /session` BEFORE the first turn is what gives this family
      // `resumeRefTiming: 'spawn'` — and therefore a `hibernate()` that never
      // has to refuse.
      const created = await bootstrap.createSession({
        ...(spec.model.model && spec.model.model !== 'auto' && spec.model.model.includes('/')
          ? {
              model: {
                providerID: spec.model.model.slice(0, spec.model.model.indexOf('/')),
                id: spec.model.model.slice(spec.model.model.indexOf('/') + 1),
                ...(spec.model.effort ? { variant: spec.model.effort } : {}),
              },
            }
          : {}),
      })
      const handle = await attachSession({
        sessionId,
        spec,
        endpoint,
        opencodeSessionId: created.id,
        bindingVersion: 1,
        observerGeneration: 1,
      })
      if (spec.initialPrompt) {
        await handle.send({ text: spec.initialPrompt }, { origin: 'human', delivery: 'when-ready' })
      }
      return handle
    },

    async resume(ref: ResumeRef, spec: SessionSpec): Promise<AgentSessionHandle> {
      /**
       * RESUME IS A SERVER RESTART, NOT A FLAG.
       *
       * The plan says "server restart + `--session <id>`", written before the
       * live probe; `opencode serve` has no `--session` flag and needs none.
       * The conversation is rows in a database that outlived the process, so
       * resuming is: start a fresh server, then address the SAME `ses_…` over
       * the API. Recorded as a deviation on the issue.
       */
      const sessionId = host.mintSessionId()
      const secret = host.randomSecret()
      const endpoint = await host.launch({
        sessionId,
        workdir: spec.workdir,
        secret,
        username: 'podium',
        ...(spec.env ? { env: spec.env } : {}),
      })
      return attachSession({
        sessionId,
        spec,
        endpoint,
        opencodeSessionId: ref.value,
        bindingVersion: (host.journal.read(sessionId)?.bindingVersion ?? 0) + 1,
        observerGeneration: (host.journal.read(sessionId)?.bindingVersion ?? 0) + 1,
      })
    },

    async adopt(binding: SessionBinding): Promise<AgentSessionHandle> {
      const endpoint = await host.adopt(binding)
      if (!endpoint) {
        // EXACT IDENTITY OR NOTHING. Adopting a server that merely occupies the
        // same port would produce a session reporting someone else's work, which
        // is strictly worse than not adopting.
        throw new Error(
          `opencode-server cannot adopt ${binding.sessionId}: no live server matches process ${binding.process.key}`,
        )
      }
      const journalled = host.journal.read(binding.sessionId)
      if (!journalled) {
        throw new Error(
          `opencode-server cannot adopt ${binding.sessionId}: no binding journal entry to rebind from`,
        )
      }
      const handle = await attachSession({
        sessionId: binding.sessionId,
        spec: {
          harness: 'opencode',
          selection: { auth: 'api-key', platform: 'linux', available: [OPENCODE_SERVER_DRIVER_ID] },
          workdir: journalled.workdir,
          model: {},
          instructions: { supported: false, reason: 'adopted session carries its own context' },
          mcpServers: { supported: false, reason: 'adopted session carries its own config' },
        },
        endpoint,
        opencodeSessionId: journalled.opencodeSessionId,
        bindingVersion: binding.bindingVersion + 1,
        observerGeneration: binding.bindingVersion + 1,
      })
      const session = sessions.get(binding.sessionId)
      if (session) {
        // A REBIND IS A FACT A WATCHER NEEDS. The binding changed under anyone
        // holding the old one, and `adopted` is the channel that says so.
        emit(session, { t: 'process', ev: { ev: 'adopted', bindingVersion: session.binding.bindingVersion } }, iso())
      }
      return handle
    },
  }

  return {
    driver,
    handleFor: (sessionId) => handles.get(sessionId),
    forget: (sessionId) => {
      const session = sessions.get(sessionId)
      if (!session) return
      // The HANDLE dies; the PROCESS does not. That is what a supervisor restart
      // looks like from in here, and it is what `adopt()` then has to find.
      session.disposed = true
      session.stream.abort()
      sessions.delete(sessionId)
      handles.delete(sessionId)
    },
    dispose: () => {
      for (const session of sessions.values()) {
        session.disposed = true
        session.stream.abort()
      }
      sessions.clear()
      handles.clear()
      streamPositions.clear()
    },
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  })
