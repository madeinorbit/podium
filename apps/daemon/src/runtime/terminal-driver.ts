/**
 * THE TERMINAL DRIVER — today's PTY stack behind the Agent Runtime contract
 * (POD-1761 W3; spec §3, §9 phase 2 daemon half).
 *
 * ---------------------------------------------------------------------------
 * THIS IS AN ADAPTER. IT REWRITES NOTHING.
 * ---------------------------------------------------------------------------
 *
 * Nineteen thousand lines of survived edge cases sit under this file: the spawn
 * path's launch-file materialization and instrumentation env, the observers'
 * causal fencing, binding-store's transition machine, the transcript tail's
 * segment rotation, composer-sync's screen scrape. NONE of it moves. What this
 * file does is give that machinery ONE DOORWAY, so that a feature asking "send
 * this text and tell me whether it landed" gets an answer with the same shape it
 * will get from `opencode-server` — and so switching a session between them is a
 * driver id, not a feature.
 *
 * If a method below starts to look like it needs a new mechanism, that is the
 * signal to go and find the existing one. Every single one exists.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE EVENTS COME FROM: THE OUTBOUND FRAME TAP
 * ---------------------------------------------------------------------------
 *
 * The obvious way to build `events()` would be to reach into `session-observers`
 * and add a callback per event kind. The better way — and the one that makes
 * this an adapter rather than a fork — is to notice that the daemon ALREADY
 * publishes everything the contract wants, as the frames it sends to the server:
 * `agentObservation` carries the whole causal envelope (cursor, observer
 * generation, turn epoch, provenance, event time) plus the phase transition;
 * `transcriptDelta` carries items; `agentExit` carries process death;
 * `sessionCwd` and `sessionGitActivity` carry workspace moves; `nativeDraft`
 * carries the composer; `agentContext` carries usage.
 *
 * So the driver TAPS that stream (see {@link TerminalRuntime.observe}) and
 * translates. Three consequences worth stating, because they are the reasons
 * this is the right seam rather than a clever one:
 *
 *   1. NOTHING IS INVENTED. Every envelope field is the observation's own. The
 *      driver never stamps observe-time, never mints a cursor for an event that
 *      has one, and never fabricates a fence.
 *   2. THE FLAG-OFF COST IS A MAP LOOKUP. An unflagged session has no record, so
 *      the tap returns on its first line.
 *   3. IT CANNOT DRIFT. A new observation kind reaches the driver the moment the
 *      observers emit it, because there is no second list of event kinds to keep
 *      in sync — only a translation of the one that already exists.
 */

import { randomUUID } from 'node:crypto'
import type {
  ActingPrincipal,
  AgentSessionHandle,
  AttachEndpoint,
  AttachmentRef,
  AttachRequest,
  ConfigureRequest,
  DriverCapabilities,
  DriverId,
  EventStreamStart,
  HookAcceptPort,
  HookAcceptWatch,
  InteractionAnswerOutcome,
  InteractionAskSpec,
  PendingInteraction,
  QueuedTurn,
  Refusal,
  RuntimeDriver,
  RuntimeEvent,
  RuntimeEventBody,
  SessionBinding as RuntimeSessionBinding,
  SendOptions,
  SessionArchive,
  SessionHealth,
  SessionLease,
  SessionSnapshot,
  SessionSpec,
  TerminalInjectionMachine,
  TimerHandle,
  TurnDelivery,
  TurnInput,
  TurnReceipt,
  WatchLevel,
} from '@podium/agent-runtime'
import {
  createTerminalInjection,
  driverLocalCursor,
  ESC,
  SUBMIT_CR_DELAY_MS,
  stampRuntimeEvent,
  terminalCapabilities,
} from '@podium/agent-runtime'

import { type AgentStateEvent, claudePromptHookFingerprint } from '@podium/harness'
import type {
  AgentKind,
  AgentRuntimeState,
  ResumeRef,
  SessionId,
  TranscriptItem,
} from '@podium/model'
import { asSessionId } from '@podium/model'
import type {
  AgentObservation,
  DaemonMessage,
  ObservationProvenance,
  ProviderCursor,
} from '@podium/protocol'
import type { SpawnControl } from '../session-observers'

/** Gap between two keystrokes typed into a native menu — comfortably above the
 *  CLI key parser's own 50ms byte-run window, so no two keys share a read.
 *  Carried over verbatim from `apps/server/src/modules/sessions/inbox.ts`. */
const MENU_KEY_DELAY_MS = 120

/**
 * How many events one session's replay buffer retains.
 *
 * SIZED FOR A RESUME, NOT FOR HISTORY. The only consumer is `events(after)`
 * catching a stream up from a cursor it holds, which in practice is a
 * reconnect's worth of events, not a session's. History is the transcript, and
 * it lives where it has always lived.
 *
 * EXPORTED FOR THE TESTS THAT PIN WHAT IT MUST NOT AFFECT. A bounded replay
 * buffer is exactly the reason no injection decision may be read out of this
 * log — a test that hardcoded the bound would stop discriminating the day the
 * bound moved.
 */
export const EVENT_LOG_LIMIT = 512

// ---------------------------------------------------------------------------
// The host — the narrow slice of the daemon a driver is allowed to reach
// ---------------------------------------------------------------------------

/**
 * Everything the terminal driver needs from the daemon, named explicitly.
 *
 * DELIBERATELY NOT `DaemonContext`. The context object is the daemon's whole
 * composition root; taking it would make the driver untestable without standing
 * up a daemon, and would let a later edit reach for anything at all. This
 * interface is the contract's own discipline applied one layer down: it names
 * what it needs, and `apps/daemon/src/host-runtime.ts` satisfies it structurally.
 */
export interface TerminalRuntimeHost {
  /** Outbound daemon frames. The driver's only path to the server. */
  send(msg: DaemonMessage): void
  /** The live PTY bridge, when this daemon holds one. */
  bridge(sessionId: SessionId): { write(dataBase64: string): void; pid: number } | undefined
  /** The observers' current folded state for a session. */
  trackedState(sessionId: SessionId): AgentRuntimeState | undefined
  /** Whether composer sync is running (Draft Sync v2) for this session. */
  draftSyncing(sessionId: SessionId): boolean
  /** The durable host label. THIS is the process identity: exactly one abduco or
   *  tmux master owns it, and `adopt()` matches on it without a prefix. */
  durableLabel(sessionId: SessionId): string
  /** The transient systemd scope bounding the label's process tree, where the
   *  platform has one. Absent is honest on macOS. */
  scopeUnit(label: string): string | undefined
  /** Does a durable master still hold this label? The ONLY thing that makes an
   *  adopt exact rather than hopeful. */
  durableHostAlive(label: string): Promise<boolean>
  /** The daemon half of the survival table — dispose the bridge, reap the host. */
  stopSession(input: { sessionId: SessionId; durableLabel: string }): void
  /** The existing spawn path. `create()`/`resume()` go through it rather than
   *  around it, which is what keeps a contract-driven session byte-identical to
   *  a server-spawned one. */
  launch(msg: SpawnControl): Promise<void>
  /** A cursor-anchored transcript slice, via the same source layer the
   *  `transcriptRead` frame uses. */
  readTranscript(
    session: { sessionId: SessionId; agentKind: AgentKind; cwd: string; resume?: ResumeRef },
    range: { anchor?: string; limit: number },
  ): Promise<readonly TranscriptItem[]>
  /** Locate the harness-native transcript for an archive, or throw with the
   *  harness's own reason when it declares none. */
  archiveTranscript(input: {
    agentKind: AgentKind
    cwd: string
    resumeValue: string
  }): Promise<{ path: string; relativeDir?: string }>
  readFileBytes(path: string): Promise<Uint8Array>
  /** Per-session memory attribution, from the breakdown the daemon already
   *  computes. Undefined where /proc is unreadable — honest, not zero. */
  memoryBytes(input: { sessionId: SessionId; label: string; pid?: number }): number | undefined
  now(): number
  setTimer(fn: () => void, delayMs: number): TimerHandle
  clearTimer(handle: TimerHandle): void
  /**
   * RE-AUTHORIZE a queued turn immediately before it is typed, if this composer
   * can. See `TerminalInjectionPorts.authorizeAtDrain`.
   *
   * ABSENT ON THE DAEMON TODAY, and honestly so: authorization is a server fact
   * (owner, delegation, revocation), the durable FIFO is the server's, and the
   * server re-authorizes at its own drain before anything reaches this machine.
   * The port exists because the driver-side queue now CARRIES the principal, so
   * whoever forwards a queue here later has a seam to decide at rather than a
   * mechanism to invent.
   */
  authorizeAtDrain?(input: {
    sessionId: SessionId
    turn: QueuedTurn
  }): { ok: true } | { ok: false; reason: string }
  onDrainRejected?(input: { sessionId: SessionId; turn: QueuedTurn; reason: string }): void
}

/** What the daemon knows about a session at the moment it is put behind the
 *  contract — everything the spawn/reattach frame already carried. */
export interface TerminalSessionRegistration {
  sessionId: SessionId
  agentKind: AgentKind
  cwd: string
  resume: ResumeRef | null
  /** The server-issued observation lease's generation, where there is one. */
  observerGeneration?: number
  bindingVersion?: number
  /** Set when this record is REPLACING one for the same session (a reattach, or
   *  an adopt after a daemon restart) rather than opening a fresh one. */
  rebind?: boolean
}

// ---------------------------------------------------------------------------
// Per-session driver state
// ---------------------------------------------------------------------------

interface LoggedEvent {
  seq: number
  event: RuntimeEvent
}

interface DriverSession {
  sessionId: SessionId
  agentKind: AgentKind
  driverId: DriverId
  cwd: string
  label: string
  resume: ResumeRef | null
  bindingVersion: number
  observerGeneration: number
  turnEpoch: number
  /** The newest cursor an observation gave us; null until one arrives. */
  providerCursor: ProviderCursor | null
  /** Driver-local event counter — the `seq` inside a driver-local cursor, and
   *  the position an `events(after)` consumer resumes from. */
  seq: number
  log: LoggedEvent[]
  wakers: Set<() => void>
  interactions: Map<string, PendingInteraction>
  answered: Set<string>
  lease: SessionLease | null
  draft: string | undefined
  contextUsedPercent: number | undefined
  injection: TerminalInjectionMachine
  /** Open waiters for a causal accept, keyed by the prompt text they watch. */
  hookWaiters: Set<{ text: string; resolve: (ok: boolean) => void }>
  /**
   * USER turns in the harness's own transcript — the submit-verify baseline, and
   * the one number a receipt's `transcript-echo` proof rests on.
   *
   * TRACKED SEPARATELY FROM `log` BECAUSE `log` IS APPEND-ONLY. A
   * `transcriptDelta` carrying `reset: true` means the harness's store was
   * REPLACED, not appended to — a re-tail, a file rewrite, a resume rolling onto
   * a new file — and the server's own buffer answers it with
   * `if (opts.reset) this.transcript = []` (`sessions/terminal.ts`). Counting out
   * of the event log instead made a reset look like the whole conversation
   * echoing at once, which credits whatever send happened to be inside its
   * verification window with an `accepted` it never earned. A false accept is
   * strictly worse than the `unverified` it displaces, so the count follows the
   * server's semantics exactly.
   */
  userTurns: number
  alive: boolean
  lastOutputAtMs: number
  /** Has the CLI finished starting? The drain types into `live` only — see
   *  `TerminalInjectionPorts.live`. */
  live: boolean
  /** This driver performed the teardown. The one thing that lets an exit be
   *  classified `killed` rather than guessed at from a code. */
  terminatedByDriver: boolean
  watchers: Map<WatchLevel, number>
  disposed: boolean
}

// ---------------------------------------------------------------------------
// Per-harness facts read off the manifest
// ---------------------------------------------------------------------------

/** What the driver needs to know about a harness, resolved once per session from
 *  `AgentManifest.runtime.terminal` (POD-2019) so nothing here is a second list
 *  of per-harness behaviour. */
export interface TerminalHarnessProfile {
  driverId: DriverId
  sendProof: DriverCapabilities['send']['proof']
  /** Claude's `UserPromptSubmit` is the only causal accept in the fleet today. */
  hookAnchoredAccept: boolean
  /** Whether this harness's CLI needs the submit-verify CR nudges. */
  needsSubmitVerification: boolean
  /** Grok's fresh TUI ignores bracketed paste until its first native turn. */
  usesRawFirstTurn: boolean
  archivable: boolean
  reportsContextPercent: boolean
}

// ---------------------------------------------------------------------------
// Observation → RuntimeEvent translation
// ---------------------------------------------------------------------------

/**
 * The phase transition an observation reports, as the normalized state
 * vocabulary.
 *
 * EVERY FIELD COMES FROM THE OBSERVATION. `needs_user`'s `need` is the state's
 * own, the completion verdict is the state's own idle verdict, and a transition
 * whose event cannot be named honestly (a subagent bookkeeping tick, whose delta
 * direction the observation does not carry) produces NO event rather than a
 * guessed one. The contract would rather be silent than plausible.
 */
export function stateEventForObservation(observation: AgentObservation): AgentStateEvent | null {
  const state = observation.state
  switch (observation.transitionKind) {
    case 'turn_opened':
      return { kind: 'prompt_submitted', at: observation.providerAt ?? undefined }
    case 'activity':
      return { kind: 'activity', at: observation.providerAt ?? undefined }
    case 'needs_user':
      return {
        kind: 'needs_user',
        need: state.need?.kind ?? 'question',
        ...(state.need?.summary ? { summary: state.need.summary } : {}),
        ...(state.need?.ask ? { ask: state.need.ask } : {}),
        at: observation.providerAt ?? undefined,
      }
    case 'compaction':
      // Direction is READ, not assumed: entering the compacting phase is the
      // start, leaving it is the end. That boundary is what re-primes the
      // instruction channel, so getting it backwards would re-prime at the wrong
      // moment — which is exactly the kind of thing a guess gets wrong quietly.
      return {
        kind: 'compaction',
        phase: observation.nextPhase === 'compacting' ? 'start' : 'end',
        at: observation.providerAt ?? undefined,
      }
    case 'turn_terminal':
      return {
        kind: 'turn_completed',
        ...(state.idle ? { verdict: state.idle } : {}),
        at: observation.providerAt ?? undefined,
      }
    case 'session_terminal':
      return { kind: 'session_ended', at: observation.providerAt ?? undefined }
    case 'snapshot':
    case 'subagent_bookkeeping':
      return null
  }
}

/** The turn event an observation reports, or null when it reports none. */
export function turnEventForObservation(observation: AgentObservation): RuntimeEventBody | null {
  switch (observation.transitionKind) {
    case 'turn_opened':
      return {
        t: 'turn',
        ev: { ev: 'started', turnEpoch: observation.turnEpoch, origin: observation.inputOrigin },
      }
    case 'turn_terminal':
      return {
        t: 'turn',
        ev: {
          ev: 'completed',
          turnEpoch: observation.turnEpoch,
          // The provider's own verdict where it has one. `done` is the fallback
          // only when the state carries no idle verdict at all — and it is the
          // reducer's own default in that case too, so the two agree.
          verdict: observation.state.idle?.kind ?? 'done',
        },
      }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

export interface TerminalRuntime {
  /** Put a session behind the contract. Idempotent for the same binding version:
   *  a reconnect re-sends reattach, and re-registering must rebind rather than
   *  open a second record. */
  register(
    registration: TerminalSessionRegistration,
    profile: TerminalHarnessProfile,
  ): AgentSessionHandle
  handleFor(sessionId: SessionId): AgentSessionHandle | undefined
  /** Is this session behind the contract right now? The flag-off fast path. */
  has(sessionId: SessionId): boolean
  /** THE EVENT SOURCE. Tap on the daemon's outbound frame stream — see the
   *  header. Returns immediately for a session that is not registered. */
  observe(msg: DaemonMessage): void
  /** The causal accept signal: a raw hook payload, before the observers fold it. */
  onHookPayload(sessionId: SessionId, payload: unknown): void
  /** A driver for one harness kind. */
  driverFor(harness: AgentKind, profile: TerminalHarnessProfile): RuntimeDriver
  clear(sessionId: SessionId): void
  dispose(): void
  /** Out-of-band nudges the conformance corpus needs and no contract verb
   *  provides. Production never calls these. */
  readonly control: TerminalRuntimeControl
}

/**
 * The corpus's control surface, implemented against the real driver.
 *
 * NOTE WHAT IS NOT HERE: anything that makes `send` answer a chosen outcome. A
 * driver with a "return unverified next time" switch would let the corpus's
 * hardest property pass without the injection ladder ever running. Inducing
 * `unverified` is the WORLD's job — withhold the echo — and the driver reaches
 * it the same way it does in production: by waiting out its window and finding
 * no proof.
 */
export interface TerminalRuntimeControl {
  /** Drop every handle without touching a process — a daemon restart. */
  restartSupervisor(): void
  askInteraction(sessionId: SessionId, interaction: PendingInteraction): void
}

export function createTerminalRuntime(host: TerminalRuntimeHost): TerminalRuntime {
  const sessions = new Map<SessionId, DriverSession>()
  /**
   * Stream position and turn epoch, per PROCESS identity.
   *
   * Survives a handle being dropped and re-adopted; dies with the daemon
   * process, exactly like the process-tree knowledge it stands for. See `emit`
   * for why an adopt must not rewind either number.
   */
  const streamPositions = new Map<string, { seq: number; turnEpoch: number }>()
  const profiles = new Map<SessionId, TerminalHarnessProfile>()
  const registrations = new Map<SessionId, TerminalSessionRegistration>()
  const handles = new Map<SessionId, AgentSessionHandle>()

  // -- event plumbing -------------------------------------------------------

  /**
   * THE CURSOR AN EVENT CARRIES: the provider's position, plus this stream's own.
   *
   * `ProviderCursor.components` is documented as a MONOTONIC VECTOR precisely so
   * that a provider with two channels does not flatten incomparable evidence into
   * one number. This driver is such a case: the observation's own components say
   * where the harness's transcript is, and `seq` says where THIS EVENT STREAM is
   * — two channels, both real, neither derivable from the other. A consumer that
   * only understands the provider's components ignores `seq`; a consumer
   * resuming `events(after)` reads it and gets exactly the events after its
   * position.
   *
   * Before any observation has arrived — a recovery prompt asked while starting,
   * a process exit during boot — there is no provider position at all, so the
   * cursor is DRIVER-LOCAL: a segment id that can never collide with a provider
   * segment, which is what makes a consumer refuse to merge the two rather than
   * silently compare them.
   */
  /**
   * The stamp for an event whose FRAME CARRIES NO EVENT TIME.
   *
   * Four kinds are in this position — process exit, cwd change, git activity and
   * a forwarded browser open. Each is derived from a daemon frame that reports
   * WHAT happened and not WHEN: `agentExit` carries a code, `sessionCwd` a path,
   * `sessionGitActivity` a list of shas, `sessionOpenUrl` a url. The observation
   * moment is therefore the only time that exists for them, and the envelope
   * requires one.
   *
   * NAMED RATHER THAN INLINED so the exception is legible as a decision. The
   * codebase's rule is that `at` is EVENT time, because observe-time stamping is
   * what makes a reattach re-date every session to "now" — and the transcript
   * path above honours it by preferring the record's own `ts`. These four have
   * nothing to prefer. The cost is bounded in the way that matters: none of them
   * is replayed on a reattach, so none can restamp a session's history. If a
   * frame later grows a real event time, it stops calling this.
   */
  const observedAt = (): string => new Date(host.now()).toISOString()

  const cursorFor = (
    session: DriverSession,
    seq: number,
    provider?: ProviderCursor,
  ): ProviderCursor => {
    const base = provider ?? session.providerCursor
    if (!base) return driverLocalCursor(session.label, seq)
    return { ...base, components: { ...base.components, seq } }
  }

  function emit(
    session: DriverSession,
    body: RuntimeEventBody,
    at: string,
    provenance: ObservationProvenance,
    cursor?: ProviderCursor,
  ): void {
    if (session.disposed) return
    session.seq += 1
    // The stream position is remembered against the PROCESS, not the handle: an
    // adopt within this daemon's life must not rewind it, or the events after a
    // rebind would compare as older than events a consumer already accepted —
    // "a replayed stream that looks like new work", which is the exact failure
    // the monotonicity rule exists to prevent. Across a daemon PROCESS restart
    // it necessarily restarts, and the consumer re-bootstraps from `snapshot()`:
    // that is what `provenance: 'bootstrap'` is for.
    streamPositions.set(session.label, {
      seq: session.seq,
      turnEpoch: session.turnEpoch,
    })
    const event = stampRuntimeEvent(body, at, provenance, {
      cursor: cursorFor(session, session.seq, cursor),
      observerGeneration: session.observerGeneration,
      turnEpoch: session.turnEpoch,
    })
    session.log.push({ seq: session.seq, event })
    // BOUNDED, and the bound is a promise about what `events(after)` can serve
    // rather than a memory tweak. `log` exists so a consumer can resume from a
    // cursor; keeping it forever would grow with every transcript item, state
    // change and interaction for the life of a session — on top of the daemon's
    // own transcript buffer — and would still not be a durability guarantee,
    // which is the argument the server-side tail already makes for its own cap.
    // A consumer whose cursor has fallen off the back re-bootstraps from
    // `snapshot()`; that is precisely what `provenance: 'bootstrap'` is for, and
    // `seq` stays monotonic across the trim so a fallen-off cursor is DETECTABLY
    // behind rather than silently mis-served.
    if (session.log.length > EVENT_LOG_LIMIT) {
      session.log.splice(0, session.log.length - EVENT_LOG_LIMIT)
    }
    for (const wake of [...session.wakers]) wake()
    host.send({ type: 'runtimeEvent', sessionId: session.sessionId, event })
  }

  // -- interactions ---------------------------------------------------------

  /**
   * Open (or re-open) the ask a `needs_user` transition reports.
   *
   * AT-LEAST-ONCE, AND THE ID SAYS SO. The identity is the observation's
   * `transitionId`, which is the best identity this family has: a re-rendered
   * menu produces a new transition and therefore a new ask, exactly as the
   * permitted-failures table warns. Consumers dedupe by fingerprint; the driver
   * does not pretend to a uniqueness it cannot deliver.
   */
  function askFromObservation(session: DriverSession, observation: AgentObservation): void {
    const profile = profiles.get(session.sessionId)
    const need = observation.state.need
    // THE PAYLOAD IS TYPED PER KIND (POD-2020 replaced the opaque record), so
    // the two arms are built separately rather than from one merged bag.
    //
    // WHAT THE DRIVER CAN AND CANNOT FILL, stated because the gaps are real:
    // `AgentRuntimeState.need` carries the tool name and a bounded detail for a
    // permission, and for a question it carries only a SUMMARY — the menu's
    // options live in the transcript, which this driver does not read. So the
    // question arm ships one option-less prompt, which is honest: the ask
    // exists, the session is blocked, and the options are not knowable here.
    // The server aggregate reads the transcript tail and fills them in.
    const kindAndPayload: InteractionAskSpec =
      need?.kind === 'permission'
        ? {
            kind: 'permission',
            payload: {
              toolName: need.ask?.toolName ?? need.summary ?? 'unknown tool',
              ...(need.ask?.detail ? { inputSummary: need.ask.detail } : {}),
              canAlwaysAllow: need.ask?.canAlwaysAllow ?? false,
            },
          }
        : {
            kind: 'question',
            payload: {
              questions: [
                {
                  question: need?.summary ?? '',
                  multiSelect: false,
                  previewLayout: false,
                  options: [],
                },
              ],
            },
          }
    const interaction: PendingInteraction = {
      id: `ask:${observation.transitionId}`,
      sessionId: session.sessionId,
      ...kindAndPayload,
      askedAt: observation.providerAt ?? observation.receivedAt,
      source: profile?.hookAnchoredAccept ? 'hook' : 'screen-classifier',
      // Even a hook-SOURCED ask is answered by typing digits into a native menu,
      // and a keystroke cannot prove which menu it acted on.
      answerable: 'keystroke-emulated',
    }
    if (session.interactions.has(interaction.id) || session.answered.has(interaction.id)) return
    session.interactions.set(interaction.id, interaction)
    emit(
      session,
      { t: 'interaction', ev: { ev: 'asked', interaction } },
      interaction.askedAt,
      observation.provenance,
      observation.providerCursor,
    )
  }

  /**
   * Close every open ask because the session left `needs_user`.
   *
   * `answeredBy: 'human'` is not a placeholder. On a terminal session an ask that
   * closed without us typing was closed by a person at the attached terminal —
   * that is the one thing a TUI session always allows, and reporting it as
   * `expired` would tell a consumer the ask went unanswered when it did not.
   */
  function closeOpenInteractions(
    session: DriverSession,
    at: string,
    provenance: ObservationProvenance,
    answeredBy: 'policy' | 'superagent' | 'human',
  ): void {
    for (const id of [...session.interactions.keys()]) {
      session.interactions.delete(id)
      session.answered.add(id)
      emit(
        session,
        { t: 'interaction', ev: { ev: 'answered', id, answeredBy, at } },
        at,
        provenance,
      )
    }
  }

  // -- the outbound-frame tap ----------------------------------------------

  function observe(msg: DaemonMessage): void {
    // `agentObservation` is keyed by `observation.podiumSessionId`, not by a
    // top-level `sessionId` — it is the one frame whose session id lives inside
    // its payload, so it is matched before the shared guard below.
    if (msg.type === 'agentObservation') {
      const observed = sessions.get(msg.observation.podiumSessionId)
      if (observed) applyObservation(observed, msg.observation)
      return
    }
    if (!('sessionId' in msg) || typeof msg.sessionId !== 'string') return
    const session = sessions.get(msg.sessionId as SessionId)
    if (!session) return
    switch (msg.type) {
      case 'transcriptDelta': {
        // REPLACE, don't accumulate, when the harness says its store was reset —
        // the same answer the server's transcript buffer gives. See
        // `DriverSession.userTurns` for what counting the other way costs.
        if (msg.reset) session.userTurns = 0
        session.userTurns += msg.items.filter((item) => item.role === 'user').length
        for (const item of msg.items) {
          emit(
            session,
            { t: 'item', item: { kind: 'complete', item } },
            // EVENT time: the transcript record's own timestamp. A record without
            // one is the only case where the driver has nothing better than the
            // observation moment, and the fallback is stated rather than hidden.
            item.ts ?? new Date(host.now()).toISOString(),
            msg.reset ? 'bootstrap' : 'live',
          )
        }
        return
      }
      case 'bind': {
        // THE SAME FACT THE SERVER FLIPS `status` ON. `Session.markLive` runs off
        // this frame and nothing else, so a driver that took its own view of
        // "started" would be a second, disagreeing answer to a question the
        // daemon already publishes. Everything before this is `starting`, which
        // is the state the queue drain must not type into.
        session.live = true
        return
      }
      case 'agentExit': {
        session.alive = false
        session.live = false
        // The process tree is gone. Its stream position dies with it for the
        // same reason `clear` drops one: a later process under this label is a
        // different conversation, and carrying a position across would fence out
        // its first events as already-seen.
        streamPositions.delete(session.label)
        emit(
          session,
          {
            t: 'process',
            ev: {
              ev: 'exited',
              code: msg.code,
              signal: null,
              // The daemon's exit frame carries a code, not a cause. `clean` for
              // 0 and `crashed` otherwise is what the code itself says; `killed`
              // and `oom` are claims the code cannot support, so they are not
              // made here — the OOM path reports itself separately.
              // A CODE IS NOT A CAUSE, with one exception we can prove: when
              // this driver performed the teardown itself, `killed` is a fact
              // rather than an inference. Otherwise the code is all there is —
              // `clean` for 0, `crashed` otherwise — and `oom` stays unclaimed
              // because nothing here can support it.
              classification: session.terminatedByDriver
                ? 'killed'
                : msg.code === 0
                  ? 'clean'
                  : 'crashed',
            },
          },
          observedAt(),
          'live',
        )
        return
      }
      case 'sessionCwd': {
        emit(
          session,
          { t: 'workspace', ev: { ev: 'cwd-changed', cwd: msg.cwd } },
          observedAt(),
          'live',
        )
        return
      }
      case 'sessionGitActivity': {
        emit(
          session,
          {
            t: 'workspace',
            ev: {
              ev: 'git-activity',
              commits: msg.commits ?? [],
              touchedFiles: msg.touched ?? [],
            },
          },
          observedAt(),
          'live',
        )
        return
      }
      case 'sessionOpenUrl': {
        emit(
          session,
          {
            t: 'open-url',
            ev: { url: msg.url, intent: msg.intent === 'login' ? 'login' : 'link' },
          },
          new Date(host.now()).toISOString(),
          'live',
        )
        return
      }
      case 'nativeDraft': {
        // Not an event: the composer is STATE, and `snapshot()`/`draft.get()` are
        // where a consumer reads it. Emitting a keystroke-rate event stream for a
        // draft is exactly the cost the two watch levels exist to avoid.
        session.draft = msg.text
        return
      }
      case 'agentContext': {
        session.contextUsedPercent = msg.percent
        return
      }
      case 'sessionResumeRef': {
        // The harness minted its native id. Captured as EARLY as the harness
        // allows, per `resumeRefTiming` — this is that moment for every terminal
        // harness, and it is what unblocks `hibernate()` and `export()`.
        session.resume = msg.resume
        return
      }
      case 'agentFrame':
      case 'agentFrameBatch': {
        // Frames are deliberately NOT contract events (§3: raw PTY output is
        // driver-private, and the frame stream appears only inside an
        // AttachEndpoint). What the driver takes from them is the one fact the
        // queue drain needs: when the terminal last said anything.
        session.lastOutputAtMs = host.now()
        return
      }
      default:
        return
    }
  }

  function applyObservation(session: DriverSession, observation: AgentObservation): void {
    // A stale generation is REJECTED, never merged — the rule the envelope's
    // `observerGeneration` exists to enforce, applied at the driver's own door.
    if (observation.observerGeneration < session.observerGeneration) return
    session.observerGeneration = observation.observerGeneration
    session.bindingVersion = Math.max(session.bindingVersion, observation.bindingVersion)
    session.providerCursor = observation.providerCursor
    // MONOTONIC. Fences are absorbing: an epoch that closed does not reopen, and
    // an epoch that went backwards would make a replayed stream read as new work.
    session.turnEpoch = Math.max(session.turnEpoch, observation.turnEpoch)

    const at = observation.providerAt ?? observation.receivedAt
    const turn = turnEventForObservation(observation)
    if (turn) emit(session, turn, at, observation.provenance, observation.providerCursor)

    const change = stateEventForObservation(observation)
    if (change) {
      emit(session, { t: 'state', change }, at, observation.provenance, observation.providerCursor)
    }

    if (observation.nextPhase === 'needs_user') askFromObservation(session, observation)
    else if (observation.priorPhase === 'needs_user') {
      closeOpenInteractions(session, at, observation.provenance, 'human')
    }
  }

  // -- the causal accept signal --------------------------------------------

  /**
   * A raw hook payload, tapped before the observers fold it.
   *
   * WHY THE RAW PAYLOAD AND NOT THE OBSERVATION. A `UserPromptSubmit` becomes a
   * `turn_opened` observation, which is delivered, acked and fenced — a pipeline
   * measured in hundreds of milliseconds on a busy daemon. A receipt that waited
   * for it would report `unverified` for sends the harness had already accepted.
   * The hook itself is the causal signal, so the accept is anchored to the hook.
   */
  function onHookPayload(sessionId: SessionId, payload: unknown): void {
    const session = sessions.get(sessionId)
    if (!session || session.hookWaiters.size === 0) return
    if (!isPromptSubmitHook(payload)) return
    // THE HARNESS'S OWN FINGERPRINT, not a comparison invented here. It handles
    // the shapes a `UserPromptSubmit` prompt actually takes — a plain string, and
    // an ARRAY of content blocks where the visible text has to be pulled out of
    // `type: 'text'` entries and `tool_result`s ignored — and it strips Claude's
    // injected context before hashing, so a prompt that arrives wrapped in a
    // system reminder still fingerprints as what the caller sent. It is also what
    // `session-observers.ts` already anchors turn epochs with, so the receipt and
    // the causal stream agree on which prompt this was by construction.
    const fingerprint = claudePromptHookFingerprint(payload)
    // FAIL CLOSED. A payload this cannot fingerprint is one we cannot attribute,
    // and crediting an arbitrary waiter for it is the exact mis-credit the
    // content match exists to prevent — worse than the alternative, because the
    // alternative is `unverified`, which is true. The keystrokes still went out.
    if (fingerprint === null) return
    for (const waiter of [...session.hookWaiters]) {
      // MATCHED BY CONTENT, not by "the next hook wins". Two sends can be in
      // flight (a queue drain overlapping a chat send), and crediting the wrong
      // one would report an accept for a turn that never landed. An unmatched
      // hook simply leaves the waiter waiting — which resolves as `unverified`,
      // the honest answer.
      if (claudePromptHookFingerprint({ prompt: waiter.text }) !== fingerprint) continue
      session.hookWaiters.delete(waiter)
      waiter.resolve(true)
      return
    }
  }

  const hookAcceptFor = (session: DriverSession): HookAcceptPort => ({
    watch(text: string): HookAcceptWatch {
      let settle: ((ok: boolean) => void) | undefined
      const accepted = new Promise<boolean>((resolve) => {
        settle = resolve
      })
      const waiter = { text, resolve: (ok: boolean) => settle?.(ok) }
      session.hookWaiters.add(waiter)
      return {
        accepted,
        cancel() {
          session.hookWaiters.delete(waiter)
        },
      }
    },
  })

  // -- session records ------------------------------------------------------

  function injectionFor(session: DriverSession): TerminalInjectionMachine {
    const profile = profiles.get(session.sessionId)
    return createTerminalInjection({
      write: (text) => {
        host.bridge(session.sessionId)?.write(Buffer.from(text, 'utf8').toString('base64'))
      },
      running: () => session.alive && host.bridge(session.sessionId) !== undefined,
      live: () => session.live && session.alive && host.bridge(session.sessionId) !== undefined,
      phase: () => host.trackedState(session.sessionId)?.phase,
      userTurnCount: () => session.userTurns,
      lastOutputAtMs: () => session.lastOutputAtMs,
      now: host.now,
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
      ...(profile?.hookAnchoredAccept ? { hookAccept: hookAcceptFor(session) } : {}),
      // READS THE SAME RESET-AWARE COUNT as the echo baseline, and for the same
      // reason: `isRawFirstTurn` in `inbox.ts` asks whether the harness's own
      // transcript has ANY user turn, so an adopted session whose driver-local
      // history happened to be empty must not be told to type raw keystrokes
      // into a grok that is long past its first turn.
      rawFirstTurn: () => (profile?.usesRawFirstTurn ?? false) && session.userTurns === 0,
      needsSubmitVerification: () => profile?.needsSubmitVerification ?? false,
      observedTurnEpoch: () => session.turnEpoch,
      ...(host.authorizeAtDrain
        ? {
            authorizeAtDrain: (turn: QueuedTurn) =>
              host.authorizeAtDrain?.({ sessionId: session.sessionId, turn }) ?? { ok: true },
            onDrainRejected: (turn: QueuedTurn, reason: string) =>
              host.onDrainRejected?.({ sessionId: session.sessionId, turn, reason }),
          }
        : {}),
    })
  }

  function openSession(
    registration: TerminalSessionRegistration,
    profile: TerminalHarnessProfile,
  ): DriverSession {
    const label = host.durableLabel(registration.sessionId)
    const existing = sessions.get(registration.sessionId)
    if (existing) {
      // A REBIND, not a second record. The observer generation and binding
      // version go UP and the conversation position does not move — which is
      // exactly the invariant the corpus pins across a supervisor restart.
      existing.observerGeneration = Math.max(
        existing.observerGeneration + 1,
        registration.observerGeneration ?? 0,
      )
      existing.bindingVersion = Math.max(
        existing.bindingVersion + 1,
        registration.bindingVersion ?? 0,
      )
      existing.alive = true
      if (registration.resume) existing.resume = registration.resume
      emit(
        existing,
        { t: 'process', ev: { ev: 'adopted', bindingVersion: existing.bindingVersion } },
        new Date(host.now()).toISOString(),
        'live',
      )
      return existing
    }
    // A rebind of a process this daemon has already observed picks its stream up
    // where it left off; a process it has never seen starts at zero.
    const carried = streamPositions.get(label)
    const session: DriverSession = {
      sessionId: registration.sessionId,
      agentKind: registration.agentKind,
      driverId: profile.driverId,
      cwd: registration.cwd,
      label,
      resume: registration.resume,
      bindingVersion: registration.bindingVersion ?? 1,
      observerGeneration: registration.observerGeneration ?? 1,
      turnEpoch: carried?.turnEpoch ?? 0,
      providerCursor: null,
      seq: carried?.seq ?? 0,
      log: [],
      wakers: new Set(),
      interactions: new Map(),
      answered: new Set(),
      lease: null,
      draft: undefined,
      contextUsedPercent: undefined,
      injection: undefined as unknown as TerminalInjectionMachine,
      hookWaiters: new Set(),
      userTurns: 0,
      alive: true,
      // STARTS FALSE EVEN ON AN ADOPT. The `bind` frame is what says the CLI is
      // up, and an adopt produces one — so the drain waits for the same evidence
      // a fresh spawn waits for rather than assuming a surviving master is ready.
      live: false,
      terminatedByDriver: false,
      lastOutputAtMs: 0,
      watchers: new Map(),
      disposed: false,
    }
    sessions.set(session.sessionId, session)
    profiles.set(session.sessionId, profile)
    session.injection = injectionFor(session)
    return session
  }

  // -- the handle -----------------------------------------------------------

  function makeHandle(session: DriverSession): AgentSessionHandle {
    const profile = profiles.get(session.sessionId)
    const refuse = (reason: Refusal['reason'], detail?: string): Refusal =>
      detail === undefined ? { reason } : { reason, detail }
    const registration = (): TerminalSessionRegistration | undefined =>
      registrations.get(session.sessionId)

    const binding = (): RuntimeSessionBinding => ({
      sessionId: session.sessionId,
      driver: session.driverId,
      family: 'terminal',
      harness: session.agentKind,
      workdir: session.cwd,
      resume: session.resume,
      process: {
        // EXACT, and opaque to the contract: the durable host label. Exactly one
        // abduco/tmux master owns it, so an adopt on it cannot land on a
        // neighbour the way a pid or a prefix could.
        key: session.label,
        ...(host.scopeUnit(session.label) ? { scopeUnit: host.scopeUnit(session.label) } : {}),
        ...(host.bridge(session.sessionId)?.pid !== undefined
          ? { pid: host.bridge(session.sessionId)?.pid }
          : {}),
      },
      bindingVersion: session.bindingVersion,
    })

    const handle: AgentSessionHandle = {
      get binding() {
        return binding()
      },

      // ---- lifecycle ----
      async stop() {
        session.alive = false
        session.terminatedByDriver = true
        // The PROCESS is gone, so its stream position goes with it: a later
        // process under the same label is a different conversation, and carrying
        // a position across would fence its first events out as already-seen.
        streamPositions.delete(session.label)
        host.stopSession({ sessionId: session.sessionId, durableLabel: session.label })
      },

      async hibernate() {
        // REFUSES WITHOUT A RESUME REF. The daemon reaps the durable host on
        // hibernate, so a session with nothing to resume from would simply be
        // gone — data loss wearing a lifecycle verb's name.
        if (!session.resume) return refuse('no_resume_ref')
        session.alive = false
        session.terminatedByDriver = true
        host.stopSession({ sessionId: session.sessionId, durableLabel: session.label })
        return { ok: true as const }
      },

      async kill() {
        session.alive = false
        session.terminatedByDriver = true
        streamPositions.delete(session.label)
        host.stopSession({ sessionId: session.sessionId, durableLabel: session.label })
      },

      async health(): Promise<SessionHealth> {
        const bridge = host.bridge(session.sessionId)
        return {
          alive: session.alive && bridge !== undefined,
          ...(host.memoryBytes({
            sessionId: session.sessionId,
            label: session.label,
            ...(bridge ? { pid: bridge.pid } : {}),
          }) !== undefined
            ? {
                memoryBytes: host.memoryBytes({
                  sessionId: session.sessionId,
                  label: session.label,
                  ...(bridge ? { pid: bridge.pid } : {}),
                }) as number,
              }
            : {}),
          ...(host.scopeUnit(session.label) ? { scopeUnit: host.scopeUnit(session.label) } : {}),
          // The daemon does not count OOM kills per session today, and a zero
          // that means "we never looked" is worse than no number — so the field
          // reports what it can prove: nothing observed.
          oomEvents: 0,
        }
      },

      // ---- identity ----
      async snapshot(): Promise<SessionSnapshot> {
        return {
          binding: binding(),
          state: host.trackedState(session.sessionId) ?? {
            phase: 'unknown',
            since: new Date(host.now()).toISOString(),
            nativeSubagentCount: 0,
          },
          cursor: cursorFor(session, session.seq),
          observerGeneration: session.observerGeneration,
          turnEpoch: session.turnEpoch,
          interactions: [...session.interactions.values()],
          ...(session.draft !== undefined ? { draft: session.draft } : {}),
          at: new Date(host.now()).toISOString(),
        }
      },

      async export(): Promise<SessionArchive> {
        if (!session.resume) {
          throw new Error('terminal driver: export before the harness minted a resume ref')
        }
        if (!profile?.archivable) {
          throw new Error(`terminal driver: ${session.agentKind} declares no handoff transcript`)
        }
        const located = await host.archiveTranscript({
          agentKind: session.agentKind,
          cwd: session.cwd,
          resumeValue: session.resume.value,
        })
        const bytes = await host.readFileBytes(located.path)
        const name = located.path.split('/').pop() ?? `${session.sessionId}.jsonl`
        return {
          harness: session.agentKind,
          formatVersion: 1,
          resume: session.resume,
          files: [
            {
              // ARCHIVE-RELATIVE. An absolute path is a promise about the
              // DESTINATION machine that the source machine cannot make.
              path: located.relativeDir ? `${located.relativeDir}/${name}` : name,
              bytes,
            },
          ],
          binding: {
            sessionId: session.sessionId,
            driver: session.driverId,
            family: 'terminal',
            harness: session.agentKind,
            workdir: session.cwd,
            resume: session.resume,
          },
        }
      },

      // ---- turns ----
      async send(input: TurnInput, options: SendOptions): Promise<TurnReceipt> {
        if (!session.alive || !host.bridge(session.sessionId)) {
          return { outcome: 'refused', refusal: refuse('not_running') }
        }
        const enqueue = (): TurnReceipt =>
          session.injection.enqueue(input.text, {
            origin: options.origin,
            id: randomUUID(),
            // CARRIED, not defaulted. A queued turn that forgot who asked for it
            // can only ever be drained as somebody else.
            ...(options.principal ? { principal: options.principal } : {}),
          })

        // ONE CONTROL LEASE — AND IT QUEUES, IT DOES NOT REFUSE. A human in
        // take-over serializes every other controller behind them, and the
        // contract's own `lease_held` says how: "headless drivers queue rather
        // than interleave — exactly what `queueText` does today". Refusing here
        // would have been a THIRD refusal reason this path does not have (the
        // plan names exactly two: not-running, and needs_user without a
        // post-ESC), and it would turn a takeover into dropped work for every
        // caller that is not a person. The queue is what makes "the user started
        // typing" and "the steward nudged" impossible to interleave; `deliveredAs`
        // reports the degradation.
        if (session.lease?.kind === 'human-controller' && options.origin !== 'human') {
          return enqueue()
        }

        // DEGRADATION IS REPORTED, NEVER SILENT. A TUI cannot append into an open
        // turn, so `steer` becomes `queue` and `deliveredAs` says so.
        const requested: TurnDelivery = options.delivery
        if (requested === 'steer' || requested === 'queue') return enqueue()

        if (requested === 'interrupt') {
          // ESC first, then the replacement prompt one CR-delay later — the exact
          // shape of `interruptText`, whose gap is what lets the CLI dismiss its
          // prompt before the paste lands.
          session.injection.interrupt()
          await new Promise<void>((resolve) => {
            host.setTimer(resolve, SUBMIT_CR_DELAY_MS)
          })
          return session.injection.deliver(input.text, {
            origin: options.origin,
            delivery: 'interrupt',
            afterEsc: true,
          })
        }

        return session.injection.deliver(input.text, {
          origin: options.origin,
          delivery: 'when-ready',
        })
      },

      async stageAttachment(_source): Promise<AttachmentRef> {
        // The upload path that lands attachment bytes on a session's machine is
        // the daemon's existing `imageUploadRequest` flow, which is server-driven
        // and already produces a path. Minting one here would create a second
        // staging root nothing cleans up.
        throw new Error(
          'terminal driver: attachments are staged by the existing upload path, not the driver',
        )
      },

      async interrupt(): Promise<void> {
        // REQUESTS a fence and nothing more. The fence arrives — or does not — as
        // a provider-confirmed `turn_terminal` observation on the causal stream.
        // A driver that emitted its own here would let a consumer believe a turn
        // ended that the agent is still running.
        session.injection.interrupt()
      },

      async answer(interactionId, answer, answerOptions): Promise<InteractionAnswerOutcome> {
        // IDEMPOTENT: a second answer is a typed error, never a second script
        // typed into a menu that is no longer there.
        if (session.answered.has(interactionId)) return { ok: false, reason: 'already-answered' }
        const interaction = session.interactions.get(interactionId)
        if (!interaction) return { ok: false, reason: 'unknown-interaction' }
        if (!session.alive || !host.bridge(session.sessionId)) {
          return { ok: false, reason: 'expired' }
        }
        const script = menuScriptFor(answer)
        // AN ANSWER THIS DRIVER CANNOT TYPE IS NOT AN ANSWER. Nothing is sent and
        // the ask stays open, because a partial script would leave the menu on a
        // row nobody chose and a closing keystroke would commit it (POD-770's
        // failure, in the one place it could recur). `unknown-interaction` is the
        // nearest true outcome the contract has today; W2's per-kind answer
        // schemas are what will let this refuse with a reason.
        if (!script) return { ok: false, reason: 'unknown-interaction' }
        // THIN BY DESIGN (the plan's word). The full ask-menu drive — preview
        // layouts, multi-select tabs, the Other row — lives in the server's
        // `answerAskUserQuestion` and belongs to W2's port. What is here is the
        // one shape every menu shares.
        //
        // ONE KEYSTROKE PER WRITE, spaced. The CLI's key parser folds a
        // multi-character chunk into a SINGLE key event whose name is the whole
        // string, so `"12"` arrives as the key "12", matches no digit, and the
        // menu does not move at all (POD-609). Every script here is one key
        // today; the spacing is kept so growing one is not a silent trap.
        script.forEach((key, at) => {
          const send = (): void =>
            host.bridge(session.sessionId)?.write(Buffer.from(key, 'utf8').toString('base64'))
          if (at === 0) send()
          else host.setTimer(send, at * MENU_KEY_DELAY_MS)
        })
        session.interactions.delete(interactionId)
        session.answered.add(interactionId)
        const at = new Date(host.now()).toISOString()
        emit(
          session,
          {
            t: 'interaction',
            ev: {
              ev: 'answered',
              id: interactionId,
              // WHO ACTUALLY ANSWERED. This driver typed the digits, so the one
              // thing this event may NOT say by default is `human` — that value
              // belongs to `closeOpenInteractions`, where it means a person at
              // the attached terminal did it themselves and we only watched. Here
              // the answer arrived through the contract, so it is the acting
              // principal's, and an absent principal is a programmatic caller
              // that did not name itself: `policy` is the honest floor, never a
              // person we cannot point to.
              answeredBy: answeredByFor(answerOptions?.principal),
              at,
            },
          },
          at,
          'live',
        )
        return { ok: true }
      },

      async interactions() {
        return [...session.interactions.values()]
      },

      // ---- observation ----
      events(after: EventStreamStart): AsyncIterable<RuntimeEvent> {
        return {
          async *[Symbol.asyncIterator]() {
            // EXACTLY ONE SNAPSHOT OPENS A STREAM. `'bootstrap'` replays what is
            // already known, tagged as such so a consumer never applies live
            // effects from it; a cursor resumes strictly AFTER that position, so
            // a rebind delivers no retroactive live events at all.
            let position =
              after === 'bootstrap'
                ? 0
                : session.log.findIndex((entry) => entry.seq > cursorSeqOf(after))
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

      async watch(level: WatchLevel) {
        // REFCOUNTED, and honest about what it buys: this family declares only
        // `coarse`, so a `fine` watch changes nothing except the count. It is
        // still counted, because a consumer must be able to ask for the level it
        // wants and read the capability to learn it did not get it.
        session.watchers.set(level, (session.watchers.get(level) ?? 0) + 1)
        let released = false
        return () => {
          if (released) return
          released = true
          session.watchers.set(level, Math.max(0, (session.watchers.get(level) ?? 1) - 1))
        }
      },

      async state(): Promise<AgentRuntimeState> {
        return (
          host.trackedState(session.sessionId) ?? {
            phase: 'unknown',
            since: new Date(host.now()).toISOString(),
            nativeSubagentCount: 0,
          }
        )
      },

      // ---- transcript ----
      transcript: {
        async history(range) {
          const reg = registration()
          return host.readTranscript(
            {
              sessionId: session.sessionId,
              agentKind: session.agentKind,
              cwd: reg?.cwd ?? session.cwd,
              ...(session.resume ? { resume: session.resume } : {}),
            },
            {
              ...(range.from?.pathHint ? { anchor: range.from.pathHint } : {}),
              limit: range.limit,
            },
          )
        },
      },

      // ---- attach & lease ----
      async attach(req: AttachRequest): Promise<AttachEndpoint | Refusal> {
        if (req.mode === 'takeover' && session.lease && session.lease.holder !== req.holder) {
          return refuse('lease_held', session.lease.holder)
        }
        if (req.mode === 'takeover') {
          session.lease = {
            holder: req.holder,
            kind: 'human-controller',
            acquiredAt: new Date(host.now()).toISOString(),
          }
        }
        // THE ENGINE TERMINAL IS THE SESSION. This is a typed DESCRIPTION of the
        // frames path that already exists — no new transport, and the frames
        // themselves stay inside this endpoint, which is the containment the
        // contract's one exception is for.
        return { kind: 'engine', stream: { id: session.sessionId } }
      },

      lease: {
        async acquire(holder, kind) {
          if (session.lease && session.lease.holder !== holder) {
            return refuse('lease_held', session.lease.holder)
          }
          session.lease = { holder, kind, acquiredAt: new Date(host.now()).toISOString() }
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
          if (!host.draftSyncing(session.sessionId)) {
            return refuse('unsupported', 'composer sync is not running for this session')
          }
          return session.draft ?? ''
        },
        async set() {
          // DECLARED, NOT BUILT. Composer injection exists (POD-859 phase 4) but
          // routing it through the contract is a later phase, and a verb that
          // silently did nothing would be worse than one that says so.
          return refuse('unsupported', 'draft injection is not routed through the contract yet')
        },
      },

      async configure(_request: ConfigureRequest) {
        return refuse('unsupported', 'a TUI takes its model and permission mode at launch')
      },

      async usage() {
        if (session.contextUsedPercent === undefined) {
          return refuse('unsupported', 'this harness has reported no context usage')
        }
        return { contextUsedPercent: session.contextUsedPercent }
      },
    }

    return handle
  }

  // -- registration + drivers ----------------------------------------------

  function register(
    registration: TerminalSessionRegistration,
    profile: TerminalHarnessProfile,
  ): AgentSessionHandle {
    registrations.set(registration.sessionId, registration)
    profiles.set(registration.sessionId, profile)
    const session = openSession(registration, profile)
    const handle = makeHandle(session)
    handles.set(registration.sessionId, handle)
    return handle
  }

  function clear(sessionId: SessionId): void {
    const session = sessions.get(sessionId)
    if (session) {
      session.disposed = true
      session.injection.dispose()
      // The PROCESS is gone — `clear` is called from the daemon's teardown path
      // and on exit — so its stream position goes with it. Retaining it would
      // leak one entry per session for the daemon's life AND would fence out the
      // first events of any later process that reused the label. Note the
      // asymmetry with `restartSupervisor`, which keeps positions on purpose:
      // there the process SURVIVES and only the handle is dropped.
      streamPositions.delete(session.label)
      for (const wake of [...session.wakers]) wake()
    }
    sessions.delete(sessionId)
    handles.delete(sessionId)
    profiles.delete(sessionId)
    registrations.delete(sessionId)
  }

  const control: TerminalRuntimeControl = {
    restartSupervisor() {
      // HANDLES DIE, PROCESSES DO NOT — a daemon restart, exactly. The records go
      // because a restarted daemon has none; the durable masters keep running,
      // which is what `adopt()` then has to find.
      for (const session of [...sessions.values()]) {
        session.disposed = true
        session.injection.dispose()
        for (const wake of [...session.wakers]) wake()
      }
      sessions.clear()
      handles.clear()
    },
    askInteraction(sessionId, interaction) {
      const session = sessions.get(sessionId)
      if (!session) return
      session.interactions.set(interaction.id, interaction)
      emit(
        session,
        { t: 'interaction', ev: { ev: 'asked', interaction } },
        interaction.askedAt,
        'live',
      )
    },
  }

  return {
    register,
    handleFor: (sessionId) => handles.get(sessionId),
    has: (sessionId) => sessions.has(sessionId),
    observe,
    onHookPayload,
    clear,
    dispose() {
      for (const sessionId of [...sessions.keys()]) clear(sessionId)
    },
    control,
    driverFor(harness: AgentKind, profile: TerminalHarnessProfile): RuntimeDriver {
      return {
        id: profile.driverId,
        harness,
        family: 'terminal',
        capabilities: () => capabilitiesFor(profile),

        async create(spec: SessionSpec): Promise<AgentSessionHandle> {
          const sessionId = asSessionId(randomUUID())
          profiles.set(sessionId, profile)
          await host.launch(spawnControlFor(sessionId, harness, spec))
          return register(
            { sessionId, agentKind: harness, cwd: spec.workdir, resume: null },
            profile,
          )
        },

        async resume(ref: ResumeRef, spec: SessionSpec): Promise<AgentSessionHandle> {
          const sessionId = asSessionId(randomUUID())
          profiles.set(sessionId, profile)
          await host.launch({ ...spawnControlFor(sessionId, harness, spec), resume: ref })
          return register(
            { sessionId, agentKind: harness, cwd: spec.workdir, resume: ref },
            profile,
          )
        },

        async adopt(bound: RuntimeSessionBinding): Promise<AgentSessionHandle> {
          // EXACT IDENTITY, and it is checked against the world rather than
          // against our own memory: the durable master either still holds this
          // label or it does not. A heuristic match here adopts the wrong
          // process, which is worse than not adopting at all.
          if (!(await host.durableHostAlive(bound.process.key))) {
            throw new Error(`terminal driver: no surviving durable host for ${bound.process.key}`)
          }
          profiles.set(bound.sessionId, profile)
          const handle = register(
            {
              sessionId: bound.sessionId,
              agentKind: harness,
              cwd: bound.workdir,
              resume: bound.resume,
              bindingVersion: bound.bindingVersion + 1,
              rebind: true,
            },
            profile,
          )
          const session = sessions.get(bound.sessionId)
          if (session) {
            // A rebind is a NEW observer generation and a NEW binding version, so
            // a stale one is rejectable. The conversation position — turn epoch,
            // cursor — does not move.
            session.observerGeneration = Math.max(
              session.observerGeneration,
              bound.bindingVersion + 1,
            )
            session.bindingVersion = bound.bindingVersion + 1
            emit(
              session,
              { t: 'process', ev: { ev: 'adopted', bindingVersion: session.bindingVersion } },
              new Date(host.now()).toISOString(),
              'live',
            )
          }
          return handle
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const capabilityCache = new WeakMap<TerminalHarnessProfile, DriverCapabilities>()

function capabilitiesFor(profile: TerminalHarnessProfile | undefined): DriverCapabilities {
  const resolved: TerminalHarnessProfile = profile ?? {
    driverId: 'generic-pty',
    sendProof: ['transcript-echo'],
    hookAnchoredAccept: false,
    needsSubmitVerification: true,
    usesRawFirstTurn: false,
    archivable: false,
    reportsContextPercent: false,
  }
  const cached = capabilityCache.get(resolved)
  if (cached) return cached
  const built = terminalCapabilities({
    driverId: resolved.driverId,
    sendProof: resolved.sendProof,
    interactionsFromHooks: resolved.hookAnchoredAccept,
    // Composer sync is a per-session flag, and the capability is a per-DRIVER
    // declaration, so the driver declares what it can do when the engine runs and
    // `draft.get()` refuses per session when it does not. Declaring it false here
    // would hide a working read behind a capability nobody would consult.
    draftReadable: true,
    reportsContextPercent: resolved.reportsContextPercent,
    archivable: resolved.archivable,
  })
  capabilityCache.set(resolved, built)
  return built
}

const cursorSeqOf = (cursor: ProviderCursor): number => Number(cursor.components.seq ?? 0)

/**
 * Who an `answered` event names, from the acting principal that answered.
 *
 * `human` requires a HUMAN — a user principal, or a person at the terminal. An
 * agent answering on a session's behalf is a `superagent`; a server job with no
 * person behind it is `policy`. The default is `policy` rather than `human`
 * because a consumer reading `human` believes somebody looked at the menu, and
 * that belief is exactly what must not be manufactured.
 */
function answeredByFor(principal: ActingPrincipal | undefined): 'policy' | 'superagent' | 'human' {
  switch (principal?.kind) {
    case 'user':
      return 'human'
    case 'agent':
      return 'superagent'
    default:
      return 'policy'
  }
}

/** Is this hook payload the causal accept — Claude's `UserPromptSubmit`? */
function isPromptSubmitHook(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const record = payload as Record<string, unknown>
  const name = record.hook_event_name ?? record.hookEventName
  return name === 'UserPromptSubmit'
}

/**
 * The keystrokes that answer a native menu.
 *
 * THIN ON PURPOSE. `SessionInbox.answerAskUserQuestion` is the real script —
 * preview layouts, multi-select tabs, the Other row, the conditional closing CR —
 * and porting it belongs to W2's interactions work, which owns the per-kind
 * answer schemas that would tell this function what it is being handed. Until
 * then it accepts the two shapes that need no schema and refuses the rest, rather
 * than typing a guess into a live menu.
 */
function menuScriptFor(answer: unknown): string[] | null {
  if (typeof answer !== 'object' || answer === null) return null
  const record = answer as Record<string, unknown>
  if (record.skip === true) return [ESC]
  const index = record.index ?? record.optionIndex
  // `index` IS ZERO-BASED — it names an OPTION, not a keystroke. The menu's own
  // digits are 1-based, and the conversion happens exactly here so that no caller
  // ever has to know the difference between "the second option" and "the key you
  // press for it". The server's `AnswerChoice.optionIndices` are the other
  // vocabulary (raw menu digits); W2 unifies them when it types the per-kind
  // answer schemas, and this is the boundary that will move.
  if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index <= 8) {
    return [String(index + 1)]
  }
  const decision = record.decision
  // A permission ask's yes/no is the same menu shape: the first option allows,
  // ESC dismisses. Anything else is a vocabulary W2 has not defined yet.
  if (decision === 'allow') return ['1']
  if (decision === 'deny') return [ESC]
  return null
}

/**
 * A `SpawnControl` for a contract-initiated session.
 *
 * NOTE WHAT IS ABSENT: `binding`. A spawn frame's binding instruction is
 * SERVER-authored — it carries the authenticated principal and the machine-access
 * verdict — and the driver is on the machine side of that line. So `create()`
 * goes through the daemon's LAUNCH path (which is what actually starts a process)
 * rather than through `handleSpawn` (which performs the binding transition first).
 * A server-initiated spawn still takes the full path; this one is for the direct
 * driving the conformance corpus and the e2e lane do.
 */
function spawnControlFor(
  sessionId: SessionId,
  agentKind: AgentKind,
  spec: SessionSpec,
): SpawnControl {
  return {
    type: 'spawn',
    sessionId,
    agentKind,
    cwd: spec.workdir,
    geometry: { cols: 120, rows: 40 },
    runtimeContract: true,
    ...(spec.model.model ? { model: spec.model.model } : {}),
    ...(spec.model.effort ? { effort: spec.model.effort } : {}),
    ...(spec.initialPrompt ? { initialPrompt: spec.initialPrompt } : {}),
    ...(spec.env ? { env: { ...spec.env } } : {}),
  } as SpawnControl
}
