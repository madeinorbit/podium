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

import { type AgentStateEvent, reduceAgentState } from '@podium/harness'
import type { AgentRuntimeState, ResumeRef, SessionId, TranscriptItem } from '@podium/model'
import type { ObservationProvenance, ProviderCursor } from '@podium/protocol'
import type { QueueDrainAbandonedReason } from '@podium/protocol/daemon'
import type { AttachEndpoint, AttachRequest, SessionLease } from '../../attach.js'
import type {
  ProcessIdentity,
  SessionArchive,
  SessionBinding,
  SessionSnapshot,
} from '../../binding.js'
import type {
  ConfigureRequest,
  ScopeResources,
  SessionHealth,
  UsageSnapshot,
} from '../../capabilities.js'
import {
  type ConfigureValueChecks,
  decideConfigure,
  noWhitespaceCheck,
} from '../../configure.js'
import type { AgentSessionHandle, RuntimeDriver } from '../../driver.js'
import type { ProcessEvent } from '../../errors.js'
import {
  createRuntimeEventStream,
  type EventStreamStart,
  type RuntimeEvent,
  type RuntimeEventBody,
  type WatchLevel,
} from '../../events.js'
import { type HeadlessTurnResult, headlessInterruptMark } from '../../headless-interrupt.js'
import { sessionHealth } from '../../health.js'
import type {
  InteractionAnswer,
  InteractionAnswerOutcome,
  PendingInteraction,
} from '../../interactions.js'
import type { OnQueueAbandoned } from '../../queue-abandonment.js'
import type { ModelPolicy, SessionSpec } from '../../session-spec.js'
import type {
  AnswerOptions,
  AttachmentStager,
  Refusal,
  SendOptions,
  TurnInput,
  TurnReceipt,
} from '../../turns.js'
import { driverLocalCursor, stampRuntimeEvent } from '../terminal/envelope.js'
import { opencodeServerCapabilities } from './capabilities.js'
import { type OpencodeClient, type OpencodeClientConfig, createOpencodeClient } from './client.js'
import {
  answerAction,
  deltaItemIdForPart,
  idleToStateEvent,
  partToItems,
  permissionAsk,
  questionAsk,
  statusToStateEvent,
} from './map.js'
import {
  type OpencodeEvent,
  type OpencodeMessageInfo,
  type OpencodeQuestionInfo,
  type OpencodeSessionId,
  eventSessionId,
  eventTimeMs,
} from './protocol.js'

/**
 * WHAT OPENCODE CAN TAKE.
 *
 * The slash rule is a PROTOCOL requirement, not a house style: a prompt's model
 * is `{ providerID, modelID }` and a bare id has no provider to send it to.
 * `modelFor` handles a bare id by sending no model at all and letting opencode
 * fall back to its own default — which is right for a launch spec assembled
 * elsewhere and wrong for an explicit configure, because the operator asked for
 * a specific model and would be told it was set while every turn ran on the
 * default. So the same string that is silently ignored on a prompt is REFUSED
 * here, with the shape it needed.
 *
 * Which providers and models exist is the server's catalog, not this file's —
 * see the note on the codex checks for why a second copy would be worse than
 * none.
 */
const OPENCODE_CONFIGURE_CHECKS: ConfigureValueChecks = {
  model: (value) =>
    noWhitespaceCheck('an opencode model name')(value) ??
    (value === 'auto' || value.indexOf('/') > 0
      ? undefined
      : `opencode names a model "provider/model" (for example "anthropic/claude-sonnet-4-5"); ${JSON.stringify(value)} has no provider`),
  effort: noWhitespaceCheck('an opencode variant'),
}

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
  /** Resource truth for this session's scope — memory, tasks, and the kernel's
   *  own OOM-kill counter. `undefined` where there is no cgroup to read. */
  resources(): ScopeResources | undefined
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

  stageAttachment: AttachmentStager

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

  /**
   * TURNS THIS DRIVER ACCEPTED AND WILL NEVER DELIVER (POD-2297).
   *
   * The server family's counterpart to `TerminalInjectionPorts.onDrainAbandoned`
   * — see `../../queue-abandonment.ts` for why the promise needs one here too,
   * and the terminal port for the at-least-once and dedupe rules the host owes.
   * Optional; the daemon's adapter logs every abandonment either way.
   */
  onQueueAbandoned?: OnQueueAbandoned

  /** Report the exact configuration of a turn only after opencode completes it. */
  reportObservedConfiguration?(input: {
    sessionId: SessionId
    model: string
    effort?: string
  }): void

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
  /**
   * THE SESSION'S MODEL POLICY, because a resume that drops it CHANGES THE
   * AGENT (POD-2775, review 3).
   *
   * This family sends `model` and `variant` on EVERY prompt, from the spec the
   * handle was bound with, and an adopted session used to be bound with an
   * empty one. `POST /session` recorded a model at create time, so the server
   * still had one — but every message after the wake overrode it with opencode's
   * default, which is the same silent downgrade by a different route.
   *
   * Optional: entries written before this field existed have no policy, which
   * is exactly the old behaviour and not a parse error.
   */
  model?: ModelPolicy
  process: ProcessIdentity
  /** The event-stream high-water mark, so a reconnect resumes rather than
   *  replays and so `seq` stays monotonic across a rebind. */
  seq: number
  turnEpoch: number
  /** Highest turn epoch whose authoritative `session.idle` has been folded. */
  fencedTurnEpoch?: number
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
  /** Highest turn epoch whose authoritative `session.idle` has been folded. */
  fencedTurnEpoch: number
  seq: number
  /** opencode's own view: is a turn running right now? Fed by session.status /
   *  session.idle, never guessed. */
  busy: boolean
  /** Exact model policy accepted for the open turn, pending its completion fence. */
  activeConfiguration: { model: string; effort?: string } | undefined
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
  /**
   * THREE PROBES PROVED THE SERVER GONE, AND NOTHING WILL DRAIN THIS AGAIN
   * (POD-2297 review, 3).
   *
   * SEPARATE FROM `disposed` on purpose. Disposal is the handle owner's call and
   * the corroborated-death path deliberately does not make it — but `consume()`
   * has returned for good by then, so no later drain and no later abandonment
   * can happen either. Without this flag `send` still answered `queued` to every
   * turn that arrived afterwards, promising a delivery from a queue the driver
   * had already declared dead and reported. grok reaches the same guarantee
   * through `endpoint.alive()`; this family has no such probe on the hot path,
   * so it records the verdict it already reached.
   */
  serverGone: boolean
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
  /**
   * THE SUPERVISOR OBSERVED A KERNEL OOM KILL in this session's scope
   * (POD-2413). The fact enters through the DRIVER because only the driver
   * holds this session's cursor, observer generation and turn epoch — an event
   * without a causal envelope is not a runtime event. Not a death:
   * `OOMPolicy=continue` kills one process inside the tree and the session
   * usually keeps serving.
   */
  reportOomKill(sessionId: SessionId, scopeUnit?: string): void

  /**
   * Start a session under an id the CALLER already minted.
   *
   * WHY THIS EXISTS BESIDE `driver.create()`, which mints its own. The contract
   * has no session id on `SessionSpec` — `FakeDriver` and the terminal driver
   * both mint one — because at the contract's altitude the driver IS the thing
   * that brings a session into existence. A daemon is not at that altitude: the
   * SERVER minted the row's id before the spawn frame was ever sent, and a
   * driver that registered its handle under a different one is a driver every
   * subsequent verb fails to find. W3 solved the same problem with `register()`;
   * this is its shape for this family.
   *
   * `driver.create()` delegates here with `host.mintSessionId()`, so there is
   * one construction path and not two.
   */
  createWithId(sessionId: SessionId, spec: SessionSpec): Promise<AgentSessionHandle>
  handleFor(sessionId: SessionId): AgentSessionHandle | undefined
  bindings(): readonly AgentSessionHandle['binding'][]
  /**
   * Is this session behind this runtime RIGHT NOW?
   *
   * BACKED BY THE SAME MAP `handleFor` READS, and that is the whole point of it
   * existing here rather than being kept by a caller. A parallel liveness set is
   * a second source of truth for one fact, and the two drift in exactly one
   * direction: the set keeps saying `true` after the handle is gone. The daemon
   * reports this as `bind.runtimeContract`, so a stale `true` makes the server
   * route a parked session's sends onto a contract path where `handleFor`
   * answers `undefined` and every verb replies `not_running`.
   */
  has(sessionId: SessionId): boolean
  /** The binding journal this runtime writes to. Exposed because the DAEMON's
   *  reattach path has to ask "was this session server-driven?" before it can
   *  decide whether to look for a PTY, and the journal entry's existence is that
   *  answer. */
  readonly journal: OpencodeJournal
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
  const streamPositions = new Map<
    string,
    { seq: number; turnEpoch: number; fencedTurnEpoch: number }
  >()
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
      fencedTurnEpoch: session.fencedTurnEpoch,
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
      model: session.spec.model,
      process: session.binding.process,
      seq: session.seq,
      turnEpoch: session.turnEpoch,
      bindingVersion: session.binding.bindingVersion,
      fencedTurnEpoch: session.fencedTurnEpoch,
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
        // No opencode session id means no cursor namespace, so no identity a
        // consumer could join on. The child-session filter above makes this
        // unreachable for a delta that names a session; dropping the fragment
        // is still right for one that does not, because an unjoinable fragment
        // is an orphan preview by construction.
        const streamSessionId = session.opencodeSessionId
        if (!streamSessionId) break
        // NOT INTO A CLOSED EPOCH (POD-2293). The absorb rule stated in fragment
        // terms: a turn that has been fenced already handed the viewer its
        // durable item, so a fragment arriving after it can only revive a
        // preview that was correctly replaced. Enforced here rather than left to
        // each consumer, so the invariant holds for every one of them.
        if (session.turnEpoch <= session.fencedTurnEpoch) break
        emit(
          session,
          {
            t: 'item',
            item: {
              kind: 'delta',
              // THE JOINABLE IDENTITY, not the raw part id (POD-2293). A bare
              // `partID` joins to nothing a consumer can see: the complete item
              // carries the part id folded into a stamped cursor, never on its
              // own. `deltaItemIdForPart` derives the same value `streamItemIdOf`
              // returns for that item, which is what makes the preview clear
              // when the real text lands instead of rendering beside it.
              itemId: deltaItemIdForPart(streamSessionId, event.properties.partID),
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
        const opened = !wasBusy && session.busy
        if (opened) {
          session.turnEpoch = Math.max(session.turnEpoch, session.fencedTurnEpoch) + 1
          persist(session)
        }
        const change = statusToStateEvent(event.properties.status, at)
        if (change) emit(session, { t: 'state', change }, at)
        // Opening a turn is what `busy` means, and the epoch is what every
        // subsequent event is fenced against.
        if (opened) {
          emit(
            session,
            { t: 'turn', ev: { ev: 'started', turnEpoch: session.turnEpoch, origin: 'human' } },
            at,
          )
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
        closeTurn(session, at, describeError(event.properties.error))
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
    const need = interaction.kind === 'permission' ? 'permission' : 'question'
    const summary = interaction.kind === 'permission' ? interaction.payload.inputSummary : undefined
    emit(
      session,
      {
        t: 'state',
        change: {
          kind: 'needs_user',
          need,
          ...(summary ? { summary } : {}),
          at,
        },
      },
      at,
    )
    /**
     * AND THE PROJECTION MOVES WITH IT (POD-2023 review, must-fix).
     *
     * `emit()` stamps, logs and wakes — it does not fold. So for one release the
     * event stream said `needs_user` while `state()` and `snapshot().state` still
     * said `working`, and a blocked server session raised no attention: the badge
     * stayed "working" for as long as the human took to answer, and
     * `isAttentionPhase` never fired. Two observers of the same driver
     * disagreeing about whether a session needs a user is the exact failure the
     * causal contract exists to prevent.
     *
     * The fold lives HERE rather than in `emit()` on purpose: emit is total over
     * the event union and folding there would make it a second reducer for the
     * whole vocabulary. Only the three places that already own a phase — this
     * one, `closeTurn`, `deliver` — assign `session.state`.
     */
    session.state = {
      phase: 'needs_user',
      since: at,
      nativeSubagentCount: 0,
      need: {
        kind: need,
        // `summary` is the field the badge and the attention surfaces render —
        // the ONE field that says what the ask would do, which for a bash
        // permission is opencode's own `metadata.command`.
        ...(summary ? { summary } : {}),
      },
    }
  }

  function closeAsk(
    session: DriverSession,
    id: string,
    at: string,
    answeredBy: 'policy' | 'superagent' | 'human',
  ): void {
    if (!session.interactions.delete(id)) return
    emit(session, { t: 'interaction', ev: { ev: 'answered', id, answeredBy, at } }, at)
    /**
     * THE ASK CLOSED, SO THE PHASE MUST LEAVE `needs_user` — and it goes back to
     * what the SESSION is actually doing, not to a fixed value.
     *
     * Another ask still open means still blocked. Otherwise the turn opencode is
     * running (or is not) decides it, which `busy` already records. Leaving the
     * phase at `needs_user` here would strand a session that just got its answer;
     * hardcoding `idle` would report a running turn as finished.
     */
    if (session.interactions.size > 0) return
    session.state = {
      phase: session.busy ? 'working' : 'idle',
      since: at,
      nativeSubagentCount: 0,
    }
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
    let permissions: readonly {
      id: string
      permission: string
      patterns: readonly string[]
      metadata: Record<string, unknown>
      always: readonly string[]
      sessionID: string
    }[]
    let questions: readonly {
      id: string
      questions: readonly OpencodeQuestionInfo[]
      sessionID: string
    }[]
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
   * THE MARK A STOPPED TURN LEAVES BEHIND (POD-3090).
   *
   * Same mapping the codex fence calls, off this fence's own terminal result.
   * opencode reports a stop as `session.error` carrying `MessageAborted`, which
   * `describeError` classifies as `interrupted` and the arm below turns into the
   * `interrupted` VERDICT — so the mark is minted from the verdict, and a local
   * `interruptPending` with no provider confirmation produces the same one.
   *
   * EXACTLY ONCE IS INHERITED: `closeTurn` claims `fencedTurnEpoch` before this
   * runs, so a second terminal event for the same epoch never reaches here, and
   * the epoch is in the item id, so a replay cannot present two stops.
   */
  function publishInterruptMark(
    session: DriverSession,
    result: HeadlessTurnResult,
    at: string,
  ): void {
    const item = headlessInterruptMark({
      family: 'opencode',
      sessionId: session.sessionId,
      turnEpoch: session.turnEpoch,
      at,
      result,
    })
    if (!item) return
    emit(session, { t: 'item', item: { kind: 'complete', item } }, at)
  }

  /**
   * The turn fence.
   *
   * ABSORBING, AND ONLY THE PROVIDER CLOSES IT. `session.idle` and
   * `session.error` are opencode's terminal signals; both claim the same epoch
   * fence before emitting anything. `interrupt()` only asks opencode to stop
   * and waits for one of those provider confirmations.
   */
  function closeTurn(
    session: DriverSession,
    at: string,
    failure?: ReturnType<typeof describeError>,
  ): void {
    if (session.turnEpoch <= session.fencedTurnEpoch) return
    session.fencedTurnEpoch = session.turnEpoch
    const interrupted = session.interruptPending
    session.busy = false
    session.interruptPending = false
    const completedConfiguration = session.activeConfiguration
    session.activeConfiguration = undefined
    persist(session)

    /**
     * AN ABORT IS A VERDICT, NOT A FAULT (POD-2792).
     *
     * opencode reports a cancelled turn as `session.error` carrying
     * `MessageAborted`, and `describeError` classifies it — correctly — as
     * `interrupted`. Closing it as FAILED anyway left the operator's own stop
     * looking like a breakage: measured on the headless arm, the turn ended and
     * the session went to `phase: errored` with no error to show, while codex —
     * whose provider says `turn/completed status: interrupted` — went to `idle`
     * from the same button. The contract has a slot for exactly this and this
     * driver was already filling it from the local flag: `interrupted` is one of
     * the four turn VERDICTS, beside `done`, `question` and `approval`.
     *
     * THE PROVIDER'S WORD, NOT OURS. This does not consult `interruptPending`,
     * because an abort we did not request is still an abort: the turn was
     * cancelled and ended, which is what `interrupted` says. Inferring "failed"
     * from "we did not ask for it" would be the driver deciding a verdict the
     * catalogue says comes from the provider.
     *
     * Everything else `describeError` classifies — auth, context overflow,
     * timeouts, unclassifiable shapes — still fails the turn.
     */
    const cancelled = failure?.reason === 'interrupted'

    /**
     * THE PROJECTION IS FOLDED FROM THE CHANGE THAT IS EMITTED (POD-2811).
     *
     * `openAsk` above records why this matters and fixed it for `needs_user`:
     * emit does not fold, so a phase written by hand beside an emitted change is
     * a second reducer, and the two drift. It drifted again here, one arm later
     * — and this time the field that went missing is the one that says WHAT WENT
     * WRONG.
     *
     * MEASURED, not reasoned: a session on `opencode/laguna-s-2.1-free` (retired
     * from opencode's gateway) went `phase=errored` in 10.2s and the row read
     * `errorClass=(none) detail=(none)` for the next three minutes. The daemon's
     * badge is `handle.state()` — "the driver's own folded projection", says
     * `apps/daemon/src/runtime/opencode-driver.ts` — so `turn_failed` was emitted
     * carrying reason, disposition and opencode's own error text, and then thrown
     * away by the very next statement. Red with nothing to say is barely better
     * than silence: the operator learns something broke and never what.
     *
     * The idle arm lost its verdict the same way — `question` and `approval`
     * both rendered as a bare `done`.
     *
     * So the change is built ONCE, emitted, and reduced into the projection by
     * the SAME reducer every consumer downstream uses. That is what the grok-acp
     * driver already does (`foldState`), and a hand-written phase cannot drift
     * from an event it is derived from.
     */
    let change: AgentStateEvent
    if (failure && !cancelled) {
      emit(
        session,
        {
          t: 'turn',
          ev: {
            ev: 'failed',
            turnEpoch: session.turnEpoch,
            reason: failure.reason,
            disposition: failure.disposition,
            ...(failure.text ? { detail: failure.text } : {}),
          },
        },
        at,
      )
      change = {
        kind: 'turn_failed',
        errorClass: failure.reason,
        retryable: failure.disposition === 'retryable',
        ...(failure.text ? { detail: failure.text } : {}),
        at,
      }
    } else {
      const verdict =
        interrupted || cancelled
          ? 'interrupted'
          : session.interactions.size > 0
            ? 'question'
            : 'done'
      publishInterruptMark(session, { kind: 'completed', verdict }, at)
      emit(
        session,
        { t: 'turn', ev: { ev: 'completed', turnEpoch: session.turnEpoch, verdict } },
        at,
      )
      change = idleToStateEvent(verdict, at)
      if (!failure && completedConfiguration) {
        host.reportObservedConfiguration?.({ sessionId: session.sessionId, ...completedConfiguration })
      }
    }
    emit(session, { t: 'state', change }, at)
    session.state = reduceAgentState(session.state, change, at)

    for (const wake of [...session.idleWaiters]) wake()
    session.idleWaiters.clear()
    void drainQueue(session)
  }

  /** opencode's error union → the contract's failure vocabulary. Unknown shapes
   *  are `provider-error`/`retryable`: a failure we cannot classify is still a
   *  failure, and guessing `fatal` would end a session a retry might save. */
  function describeError(error: unknown): {
    reason:
      | 'rate-limit'
      | 'auth-expired'
      | 'context-overflow'
      | 'provider-error'
      | 'timeout'
      | 'interrupted'
    disposition: 'retryable' | 'needs-human' | 'fatal'
    text?: string
  } {
    const name =
      typeof error === 'object' && error !== null && 'name' in error
        ? String((error as { name: unknown }).name)
        : ''
    const text =
      typeof error === 'object' && error !== null ? JSON.stringify(error).slice(0, 500) : undefined
    if (name.includes('ProviderAuth'))
      return { reason: 'auth-expired', disposition: 'needs-human', ...(text ? { text } : {}) }
    if (name.includes('ContextOverflow'))
      return { reason: 'context-overflow', disposition: 'needs-human', ...(text ? { text } : {}) }
    if (name.includes('MessageAborted'))
      return { reason: 'interrupted', disposition: 'retryable', ...(text ? { text } : {}) }
    if (name.includes('MessageOutputLength'))
      return { reason: 'provider-error', disposition: 'retryable', ...(text ? { text } : {}) }
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
        await sleep(RECONNECT_DELAY_MS)
        /**
         * DID THE SERVER ACTUALLY DIE, OR WAS THE BOX BUSY? (POD-2114)
         *
         * This asked ONCE and believed the answer, and that is my own stated
         * principle broken in my own file. `../../errors.ts`: transport failures
         * are deliberately outside session semantics, because "the session may
         * be alive and adoptable even while the path to it is down. Conflating
         * the two is how ghost sessions happen."
         *
         * It produced exactly that ghost. On a loaded machine a probe can exceed
         * the client's timeout while the server is perfectly healthy — POD-2086
         * measured a session declared `exited` at 342s whose `opencode serve`
         * was still answering `/global/health` with 200 twenty minutes later,
         * scope active, holding a provider credential, with every subsequent
         * send queued forever against a session that would never drain.
         *
         * So a death now has to be CORROBORATED: several probes, spaced, all
         * failing. The cost of being slow to notice a real exit is a session
         * that looks alive for a few more seconds. The cost of being wrong the
         * other way is a leaked credentialed server and a queue that never
         * drains — and only one of those is recoverable by waiting.
         */
        if (!(await serverIsGone(session))) continue
        if (session.disposed) return
        const at = iso()
        const ev: ProcessEvent = {
          ev: 'exited',
          code: null,
          signal: null,
          classification: 'crashed',
        }
        emit(session, { t: 'process', ev }, at)
        /**
         * THE QUEUE DIED WITH THE SERVER (POD-2297).
         *
         * The session is deliberately NOT marked disposed here — that decision
         * belongs to whoever owns the handle, and the corroborated-death path
         * has always reported the process fact and stopped. But the parked turns
         * are finished either way: every remaining drain would `deliver` into a
         * server three probes have just proved gone, and each of their senders
         * holds a `queued` receipt that POD-2291 made the ledger's last word.
         * Waiting for a teardown that may never come is how they vanished.
         */
        // Ordered before the report so nothing racing this can slip a fresh
        // turn into a queue that is already being given up.
        session.serverGone = true
        abandonQueue(session, 'teardown')
        return
      }
    })()
  }

  /**
   * How long to wait before re-subscribing after the SSE socket drops, and how
   * hard to corroborate a suspected death.
   *
   * THREE PROBES OVER ~6s rather than one: a single slow answer is a fact about
   * the machine, three consecutive failures separated by seconds is a fact about
   * the server. Neither number is tuned — they are "long enough that load alone
   * does not produce three of them, short enough that a real crash surfaces
   * inside a turn".
   */
  const RECONNECT_DELAY_MS = 250
  const DEATH_PROBES = 3
  const DEATH_PROBE_GAP_MS = 2000

  /** `true` only when every probe failed. One success anywhere means the server
   *  is there and the socket, not the process, was the problem. */
  async function serverIsGone(session: DriverSession): Promise<boolean> {
    for (let attempt = 0; attempt < DEATH_PROBES; attempt++) {
      if (session.disposed) return false
      if (await session.client.health()) return false
      if (attempt < DEATH_PROBES - 1) await sleep(DEATH_PROBE_GAP_MS)
    }
    return !session.disposed
  }

  // -- sending --------------------------------------------------------------

  async function deliver(
    session: DriverSession,
    input: TurnInput,
    origin: SendOptions['origin'] = 'human',
  ): Promise<void> {
    const fileUrl = (path: string): string => {
      const url = new URL('file:///')
      url.pathname = path
      return url.href
    }
    const model = modelFor(session.spec, input)
    const effort = effortFor(session.spec, input)
    await session.client.prompt(session.opencodeSessionId, {
      parts: [
        { type: 'text', text: input.text },
        ...(input.attachments ?? []).map((attachment) => ({
          type: 'file' as const,
          mime: attachment.mediaType,
          filename: attachment.filename,
          url: fileUrl(attachment.path),
        })),
      ],
      ...(model ? { model } : {}),
      // THE OVERRIDE IS READ HERE TOO, and it used not to be. `modelFor` gave
      // `input.overrides` precedence for the model and this line read the spec
      // directly, so a caller who asked for one turn at a different effort got
      // the new model at the OLD effort — a half-applied override, silently, on
      // the one field where the difference is invisible in the transcript.
      // POD-3081 made the sticky half real, which makes the two halves of the
      // precedence rule worth stating identically.
      ...(effort ? { variant: effort } : {}),
    })
    session.activeConfiguration = model
      ? { model: `${model.providerID}/${model.modelID}`, ...(effort ? { effort } : {}) }
      : undefined
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
      fencedTurnEpoch: session.fencedTurnEpoch,
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
    emit(session, { t: 'turn', ev: { ev: 'started', turnEpoch: session.turnEpoch, origin } }, iso())
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

  /**
   * Per-turn effort override, or the session's sticky policy. The same
   * precedence as {@link modelFor}, spelled the same way on purpose: the two
   * fields travel together on every surface a user sees, and a rule that held
   * for one of them and not the other is the kind of asymmetry nobody finds by
   * reading.
   *
   * `auto` means opencode's own default, so it sends no `variant` at all rather
   * than a variant literally named "auto".
   */
  function effortFor(spec: SessionSpec, input: TurnInput): string | undefined {
    const override = input.overrides?.supported ? input.overrides.value.effort : undefined
    const raw = override ?? spec.model.effort
    return raw && raw !== 'auto' ? raw : undefined
  }

  /**
   * THE ONE CALL TO THE HOST'S PORT, AND THE ONE GUARD AROUND IT
   * (POD-2297 review, 2).
   *
   * `endSession` is the FIRST statement of `stop`/`kill`/`hibernate`, and this
   * port is not cheap: the daemon's implementation fsyncs a durable outbox, so
   * ENOSPC, EDQUOT, EIO and a reportId collision all reach here as exceptions.
   * Letting one propagate would skip `client.close()`, `endpoint.stop()` and the
   * map deletes that follow — a live `opencode serve` child with nobody holding it,
   * which is a worse failure than the one being reported — and inside
   * `dispose()` it would abandon every remaining session mid-loop.
   *
   * SWALLOWING IS SAFE HERE, and only because of where the log line lives: the
   * daemon's adapter writes its `warn` BEFORE it tries to make the report
   * durable, so a turn whose report cannot be persisted has still been said out
   * loud. Silence is what this issue closes; the durable correction is the part
   * that can fail, and the host owns saying so.
   *
   * CALLERS HAVE ALREADY GIVEN THE TURNS UP by the time they reach here, so
   * report-is-the-point-of-no-return holds however this returns.
   */
  function reportAbandoned(
    session: DriverSession,
    turns: readonly QueuedTurn[],
    reason: QueueDrainAbandonedReason,
  ): void {
    if (turns.length === 0) return
    try {
      host.onQueueAbandoned?.({ sessionId: session.sessionId, turns, reason })
    } catch {
      // Intentionally terminal: see above.
    }
  }

  /**
   * SAY WHAT THIS SESSION IS LOSING (POD-2297).
   *
   * `host.onQueueAbandoned` is the server family's `onDrainAbandoned`, and its
   * one rule is the terminal port's: THE REPORT IS THE POINT OF NO RETURN. So
   * the turns leave `session.queue` here, in the same statement that hands them
   * over — a queue that kept its copy could deliver, after a rebind, bytes the
   * ledger has already recorded as never delivered.
   */
  function abandonQueue(session: DriverSession, reason: QueueDrainAbandonedReason): void {
    if (session.queue.length === 0) return
    const turns = session.queue.splice(0, session.queue.length)
    reportAbandoned(session, turns, reason)
  }

  /** One turn, already off the queue, that will not be retried by anybody. */
  function abandonTurn(
    session: DriverSession,
    turn: QueuedTurn,
    reason: QueueDrainAbandonedReason,
  ): void {
    reportAbandoned(session, [turn], reason)
  }

  /**
   * THIS SESSION CAN NO LONGER DRAIN — the one place that becomes true, so the
   * one place its queue's fate is stated. Every caller used to be a bare
   * `session.disposed = true`, and every one of them discarded whatever was
   * parked in the queue against a caller holding a `queued` receipt.
   */
  function endSession(session: DriverSession): void {
    session.disposed = true
    abandonQueue(session, 'teardown')
    /**
     * RELEASE ANYONE WAITING ON A SESSION THAT WILL NEVER ANSWER
     * (POD-2297 review, low 2).
     *
     * A `when-ready` send parks on these waiters for up to
     * WHEN_READY_TIMEOUT_MS. Ending the session without waking them left such a
     * caller blocked on a full timeout for an answer that could not come — the
     * same state-the-fate-promptly instinct this whole issue is about, one layer
     * up. Each waiter re-evaluates its own predicate, so waking them turns a
     * ten-minute hang into the immediate refusal the caller should have had.
     */
    for (const wake of [...session.idleWaiters]) wake()
    session.idleWaiters.clear()
  }

  /**
   * REGISTER A SESSION UNDER AN ID, REPORTING WHATEVER IT DISPLACES (POD-2297).
   *
   * `sessions.set` is the OTHER way a session stops draining, and the one the
   * first round of this issue missed. Every `disposed = true` goes through
   * `endSession`, but `adopt()` does not set `disposed` at all — it builds a
   * fresh session object and puts it in the map, and when the id is already
   * there the live object is simply overwritten and garbage-collected with its
   * queue still in it.
   *
   * THAT IS A HOT PATH, NOT A CORNER. The daemon's reattach runs
   * `adoptServerDriverSession` before any live-session check and a server
   * reconnect can re-send a hundred reattaches at once, so a browser refresh
   * was enough to lose nudges parked behind a human's take-over lease — exactly
   * the loss this issue exists to end, through a door it had left open.
   *
   * THE DISPLACED OBJECT IS ENDED, NOT JUST DRAINED. `endSession` also marks it
   * disposed, which is what stops its own loops reading a session nobody can
   * reach any more. What it deliberately does NOT do is close the client or the
   * endpoint: an adopt re-binds the SAME child, and tearing down its transport
   * here would kill the process the new session is about to speak to.
   */
  function registerSession(sessionId: SessionId, session: DriverSession): void {
    const displaced = sessions.get(sessionId)
    if (displaced && displaced !== session) endSession(displaced)
    sessions.set(sessionId, session)
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
        /**
         * THE SEND ITSELF FAILED, AND THE CALLER IS LONG GONE.
         *
         * Still no turn EVENT — the turn never opened, and the contract is
         * explicit that a consumer told a turn failed believes one ran. What is
         * owed is a RECEIPT CORRECTION, which is what this is (POD-2297): the
         * process event the stream loop raises when the server is really dead
         * tells the SESSION's story, never this sender's.
         *
         * ONLY `next` IS REPORTED — the rest is still queued and may yet drain;
         * the disposal that follows a truly dead server reports those.
         */
        abandonTurn(session, next, 'delivery-failed')
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
    const stageRefusal = (reason: Refusal['reason'], detail?: string): Refusal => ({
      reason,
      ...(detail ? { detail } : {}),
    })

    const handle: AgentSessionHandle = {
      get binding() {
        return session.binding
      },

      // ---- lifecycle ----
      async stop() {
        endSession(session)
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
        endSession(session)
        handles.delete(session.sessionId)
        sessions.delete(session.sessionId)
        return { ok: true as const }
      },

      async kill() {
        endSession(session)
        session.stream.abort()
        await session.endpoint.kill()
        host.journal.clear(session.sessionId)
        streamPositions.delete(session.binding.process.key)
        handles.delete(session.sessionId)
        sessions.delete(session.sessionId)
      },

      async health(): Promise<SessionHealth> {
        return sessionHealth({
          alive: await session.client.health(),
          resources: session.endpoint.resources(),
          ...(session.binding.process.scopeUnit
            ? { scopeUnit: session.binding.process.scopeUnit }
            : {}),
        })
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
        // The server is gone and the queue that would have held this has already
        // been reported abandoned (POD-2297 review, 3). Answering `queued` here
        // would hand out the very promise this issue exists to stop making —
        // and this time nothing is left running that could ever break it aloud.
        if (session.serverGone) {
          return refuse('not_running', 'the opencode server for this session is gone')
        }
        await refreshInteractions(session)
        // ORDER MATTERS AND IS NOT ARBITRARY. An open ask blocks EVERY delivery,
        // including a queue, because the session is stopped waiting for a human
        // and a turn stacked behind that ask buries it.
        if (session.interactions.size > 0) {
          return refuse(
            'needs_user',
            `${session.interactions.size} interaction(s) awaiting an answer`,
          )
        }
        if (
          session.lease?.kind === 'human-controller' &&
          options.principal?.ref !== session.lease.holder
        ) {
          // A human holds the terminal. The contract's own note is that headless
          // drivers QUEUE rather than interleave, and this driver has a real
          // queue — so the nudge lands after the takeover ends instead of being
          // thrown away.
          session.queue.push({ input, options })
          return {
            outcome: 'queued',
            position: session.queue.length,
            deliveredAs: 'queue',
            at: iso(),
          }
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

        /**
         * THE SESSION MAY HAVE ENDED WHILE THIS SEND WAS PARKED
         * (POD-2297 review, low 3).
         *
         * `waitForIdle` above is an await, and an adopt, a stop or a kill can
         * land inside it. Without this re-check the send delivered through a
         * session nobody can reach any more and answered `accepted` carrying the
         * DEAD object's turnEpoch — an epoch no consumer can match to anything.
         * The entry guard cannot cover this: it ran before the await.
         */
        if (session.disposed || session.serverGone) return refuse('not_running')

        try {
          await deliver(session, input, options.origin)
        } catch (err) {
          return refuse('not_running', String(err))
        }
        return {
          outcome: 'accepted',
          turnEpoch: session.turnEpoch,
          /**
           * WHAT ACTUALLY HAPPENED, not what was asked for.
           *
           * Never `steer` — see `send.native` in ./capabilities.ts. But reaching
           * this line means the words went STRAIGHT to opencode and opened a
           * turn: the queue branch above did not take them. So a `steer` that
           * arrived on an idle session was delivered `when-ready`, and saying
           * `queue` would report a wait that never happened (POD-2023 review,
           * 7.4). A `steer` that DID wait was answered `queued` above and never
           * gets here.
           */
          deliveredAs: wanted === 'steer' ? 'when-ready' : wanted,
          /** The 204 from `prompt_async`. The only proof this driver declares,
           *  and the only one it needs. */
          provenBy: 'protocol-ack',
          at: iso(),
        }
      },

      async stageAttachment(source) {
        if (session.disposed) return stageRefusal('not_running')
        try {
          return await host.stageAttachment({ sessionId: session.sessionId, source })
        } catch (err) {
          return stageRefusal('staging_failed', String(err))
        }
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
        } catch (err) {
          /**
           * A TRANSPORT FAILURE IS NOT A CAPABILITY GAP (POD-2023 review, 7.3).
           *
           * `not-yet-supported` says "this driver cannot answer asks of this
           * shape", which a surface renders as a permanent limitation and a
           * caller stops retrying. A reply that failed to REACH opencode is the
           * opposite: the capability is there and the attempt should be made
           * again. The ask stays open either way — which is what keeps the
           * session visibly blocked rather than falsely resolved.
           */
          return { ok: false, reason: 'delivery-failed', detail: String(err) }
        }
        session.answered.add(interactionId)
        closeAsk(
          session,
          interactionId,
          iso(),
          options?.principal?.kind === 'agent'
            ? 'superagent'
            : options?.principal?.kind === 'system'
              ? 'policy'
              : 'human',
        )
        return { ok: true }
      },

      async interactions(): Promise<readonly PendingInteraction[]> {
        await refreshInteractions(session)
        return [...session.interactions.values()]
      },

      // ---- observation ----
      events(after: EventStreamStart): AsyncIterable<RuntimeEvent> {
        return createRuntimeEventStream(after, {
          log: session.log,
          wakers: session.wakers,
          currentSeq: () => session.seq,
          isDisposed: () => session.disposed,
        })
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
        /**
         * THE LEASE IS CHECKED BEFORE ANYTHING IS STARTED (POD-2059's finding).
         *
         * This used to set `session.lease` UNCONDITIONALLY after starting the
         * client, which broke the one thing the lease exists for. Spec §5:
         * "exactly one driver-controller or one human-controller holds it", and
         * that is what makes "the user attached and started typing" and "the
         * steward tried to nudge" impossible to interleave. Two attachers in
         * take-over mode both got "the" control lease and the second silently
         * displaced the first — while `lease.acquire()`, one screen down, was
         * refusing that exact case with `lease_held`. One verb enforcing an
         * invariant its sibling hands out for free is worse than neither doing
         * it, because callers read the refusal and believe it.
         *
         * ORDER MATTERS TOO, and that is the second half of the fix: the old
         * code spawned a client terminal and only then took the lease, so a
         * refusal — had there been one — would have left an orphaned TUI
         * attached to the session it was refused access to.
         *
         * A `peek` never touches the lease: spectators are unlimited, which is
         * the other half of §5 and the reason the check is scoped to takeover.
         */
        if (req.mode === 'takeover' && session.lease && session.lease.holder !== req.holder) {
          return {
            reason: 'lease_held',
            detail: `the control lease is held by ${session.lease.holder}`,
          }
        }
        const previousLease = session.lease
        const acquired = req.mode === 'takeover' && previousLease == null
        if (acquired) {
          session.lease = {
            holder: req.holder,
            kind: 'human-controller',
            acquiredAt: iso(),
          }
        }
        let client: Awaited<ReturnType<typeof host.attachClient>>
        try {
          client = await host.attachClient({
            sessionId: session.sessionId,
            url: session.endpoint.baseUrl,
            mode: req.mode,
          })
        } catch (err) {
          if (acquired && session.lease?.holder === req.holder) session.lease = previousLease
          throw err
        }
        if (!client) {
          if (acquired && session.lease?.holder === req.holder) session.lease = previousLease
          return {
            reason: 'unsupported',
            detail: 'this machine cannot host a client terminal for the session',
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
          if (session.lease?.holder !== holder) return
          session.lease = null
          /**
           * RELEASING THE LEASE IS A DRAIN EDGE (POD-2059's review).
           *
           * A `queue` that arrived while a human held the take-over lease was
           * parked here rather than refused — the contract's own note says
           * headless drivers queue rather than interleave, and W3's F6 is
           * explicit that the nudge lands AFTER the takeover ends. But
           * `drainQueue` only ran from `closeTurn`, so on an IDLE session the
           * queued turn waited for a turn edge that may never come: the human
           * releases, nothing is running, and the steward's nudge sits there
           * until some unrelated turn happens to complete.
           *
           * "After the takeover ends" has to mean this moment, or the promise is
           * only kept on sessions that happen to be busy.
           */
          void drainQueue(session)
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

      /**
       * STICKY MODEL AND EFFORT, out of the same field every prompt already
       * reads (POD-3081).
       *
       * `deliver()` sends `model` and `variant` on EVERY prompt from
       * `session.spec.model`, so writing the new policy there and journalling it
       * is the whole mechanism — and it is durable in the two ways that
       * distinguish it from a per-turn override: `POST /session` recorded a
       * model at create time and the journal carries the policy across a reload
       * and an adoption.
       *
       * The previous refusal cited opencode's sticky-switch ROUTES being v2-only
       * and unexercised against a live server, and that remains true — none is
       * called here. This implementation needs no route: the prompt already
       * carries the model, and what changes is which model the driver puts on
       * it. Nothing is sent to opencode by this call at all, which is also why
       * it declares `next-turn` rather than pretending an open turn moved.
       *
       * `permissionMode` refuses: opencode takes its permission config at create
       * and the driver has no live route to it.
       */
      async configure(request: ConfigureRequest) {
        const declared = capabilities.configure
        if (!declared.supported) {
          return { reason: 'unsupported' as const, detail: declared.reason }
        }
        if (session.disposed) {
          return { reason: 'not_running' as const, detail: 'this opencode session has ended' }
        }
        const decision = decideConfigure({
          declared: declared.value,
          request,
          policy: session.spec.model,
          checks: OPENCODE_CONFIGURE_CHECKS,
        })
        if (!('ok' in decision)) return decision
        session.spec = { ...session.spec, model: decision.policy }
        persist(session)
        return { ok: true as const }
      },

      async usage(): Promise<UsageSnapshot | Refusal> {
        try {
          const info = await session.client.getSession(session.opencodeSessionId)
          return {
            ...(info.tokens
              ? { inputTokens: info.tokens.input, outputTokens: info.tokens.output }
              : {}),
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

  /**
   * A FRESH SERVER FOR A CONVERSATION THAT OUTLIVED IT (POD-2775, review 1).
   *
   * Identical in every step to `resume()` — launch, then address the journalled
   * `ses_…` — and different in the one thing that matters to a wake: it runs
   * under the session's EXISTING id rather than a newly minted one, so the row,
   * the client terminal and the operator's open tab all still point at it.
   *
   * A NEW SECRET, not the journalled one. The credential in the journal belonged
   * to a process that is gone; minting a fresh one is what `resume()` does and
   * what keeps a recycled port from ever answering on a live credential.
   */
  async function relaunchFor(entry: OpencodeJournalEntry): Promise<OpencodeServerEndpoint> {
    return host.launch({
      sessionId: entry.sessionId,
      workdir: entry.workdir,
      secret: host.randomSecret(),
      username: entry.username,
    })
  }

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
      activeConfiguration: undefined,
      fencedTurnEpoch: Math.max(carried?.fencedTurnEpoch ?? 0, journalled?.fencedTurnEpoch ?? 0),
      interruptPending: false,
      interactions: new Map(),
      answered: new Set(),
      messages: new Map(),
      queue: [],
      serverGone: false,
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
    registerSession(input.sessionId, session)
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

  async function createWithId(
    sessionId: SessionId,
    spec: SessionSpec,
  ): Promise<AgentSessionHandle> {
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
  }

  const driver: RuntimeDriver = {
    id: OPENCODE_SERVER_DRIVER_ID,
    harness: 'opencode',
    family: 'server',
    capabilities: () => capabilities,

    async create(spec: SessionSpec): Promise<AgentSessionHandle> {
      return createWithId(host.mintSessionId(), spec)
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

    /**
     * COME BACK TO THIS SESSION — by rebinding if the server lived, and by
     * RESTARTING IT if it did not (POD-2775, review 1).
     *
     * This used to be the rebind alone: ask the host for a live endpoint and
     * throw when nothing answered. That is the whole story after a supervisor
     * restart, where an opencode server genuinely outlives the daemon that
     * spawned it — and it is the wrong half of the story after a HIBERNATE,
     * which kills the server on purpose. Nothing was ever going to answer, so
     * every Resume press on a parked opencode session produced the same
     * `spawnError` and the row stayed `exited` forever.
     *
     * WHAT MAKES THE RESTART SAFE IS THE JOURNAL, and it is checked first here
     * rather than inside `host.adopt` so the two refusals stay distinguishable:
     *
     *   - NO ENTRY — `kill()` clears the journal and `hibernate()` keeps it, so
     *     an absent entry means this session was retired. Nothing to come back
     *     to; throw, and the corpus's "refuses to adopt a binding whose process
     *     did not survive" keeps meaning what it says.
     *   - A DIFFERENT PROCESS KEY — the entry describes another incarnation of
     *     this session id, so resuming its conversation would attach this
     *     session to somebody else's work. Throw.
     *   - ENTRY MATCHES, NOTHING ANSWERS — the conversation is ours and the
     *     process is gone. That is a park, and `resume()` one screen up already
     *     says how this family comes back from it: start a fresh server and
     *     address the SAME `ses_…`, because the conversation is rows in a
     *     database that outlived the process. This does the same thing under the
     *     session's own id, which is the part `resume()` cannot do.
     */
    async adopt(binding: SessionBinding): Promise<AgentSessionHandle> {
      const journalled = host.journal.read(binding.sessionId)
      if (!journalled) {
        throw new Error(
          `opencode-server cannot adopt ${binding.sessionId}: no binding journal entry to rebind from`,
        )
      }
      if (journalled.process.key !== binding.process.key) {
        throw new Error(
          `opencode-server cannot adopt ${binding.sessionId}: journal names process ${journalled.process.key}, binding names ${binding.process.key}`,
        )
      }
      const endpoint = (await host.adopt(binding)) ?? (await relaunchFor(journalled))
      const handle = await attachSession({
        sessionId: binding.sessionId,
        spec: {
          harness: 'opencode',
          selection: { auth: 'api-key', platform: 'linux', available: [OPENCODE_SERVER_DRIVER_ID] },
          workdir: journalled.workdir,
          // NOT `{}` — see {@link OpencodeJournalEntry.model}.
          model: journalled.model ?? {},
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
        emit(
          session,
          { t: 'process', ev: { ev: 'adopted', bindingVersion: session.binding.bindingVersion } },
          iso(),
        )
      }
      return handle
    },
  }

  return {
    driver,
    createWithId,
    journal: host.journal,
    handleFor: (sessionId) => handles.get(sessionId),
    // ONE MAP, TWO READERS. `stop`/`hibernate`/`kill` all delete from `handles`,
    bindings: () => [...handles.values()].map((handle) => handle.binding),
    // so both answers change together by construction.
    has: (sessionId) => handles.has(sessionId),
    reportOomKill: (sessionId, scopeUnit) => {
      const session = sessions.get(sessionId)
      if (!session) return
      emit(
        session,
        { t: 'process', ev: { ev: 'oomKilled', ...(scopeUnit ? { scopeUnit } : {}) } },
        iso(),
      )
    },

    forget: (sessionId) => {
      const session = sessions.get(sessionId)
      if (!session) return
      // The HANDLE dies; the PROCESS does not. That is what a supervisor restart
      // looks like from in here, and it is what `adopt()` then has to find.
      endSession(session)
      session.stream.abort()
      sessions.delete(sessionId)
      handles.delete(sessionId)
    },
    dispose: () => {
      for (const session of sessions.values()) {
        endSession(session)
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
