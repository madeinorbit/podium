import { machinePathBasename } from '@podium/model'
import {
  type BoundaryContextOperation,
  type BoundaryContextRequest,
  createBoundaryContext,
  prepareTerminalInstrumentation,
  reportInstrumentationDegradation,
  withDeliveryQueue,
} from '../../host.js'
import type { SessionDriverSlots } from '../session-slots.js'
import type {
  TerminalDriverReport,
  TerminalHostPorts,
  TerminalReattachControl,
  TerminalTransport,
} from './host-ports.js'
import { respondToMailBoundary } from './mail-boundary.js'
/**
 * THE TERMINAL DRIVER — today's PTY stack behind the Agent Runtime contract
 * (POD-1761 W3; spec §3, §9 phase 2 terminal family, moved into the harness
 * package in POD-4785).
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
import { isDeepStrictEqual } from 'node:util'
import { createLogger } from '@podium/logger'
import type {
  AgentKind,
  AgentRuntimeState,
  HarnessRef,
  ResumeRef,
  SessionId,
  TranscriptItem,
} from '@podium/model'
import { asSessionId, isProofOnlyItem, transcriptItemRefOf } from '@podium/model'
import type { AgentObservation, ObservationProvenance, ProviderCursor } from '@podium/protocol'
import { type DaemonMessage, isRuntimeFineEvent, type RuntimeHistoryPage } from '@podium/protocol/daemon'
import type {
  AgentStateEvent,
  TerminalAcceptCorrelation,
  TerminalAcceptCorrelations,
  TerminalEchoCorrelation,
  TranscriptTimestampFidelity,
} from '../../../index.js'
import { canonicalDriverId, podiumFrameId } from '../../../index.js'
import { harnessCapabilitiesFor, isCommandWrapperText, isGenericClaudeTitle, isTransientTitle, stripSpinnerFrame } from '../../../metadata.js'
import { decodeCursor } from '../../../store/cursor-codec.js'
import type {
  AcceptPort,
  AcceptSeen,
  ActingPrincipal,
  AgentSessionHandle,
  AttachEndpoint,
  AttachRequest,
  ConfigureRequest,
  Disproof,
  DriverCapabilities,
  DriverId,
  EventStreamStart,
  InteractionAnswerOutcome,
  InteractionAskSpec,
  PendingInteraction,
  QuestionPrompt,
  QuestionSelection,
  QueueDrainAbandonedReason,
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
  SessionMetadataChange,
  SessionMetadataObservation,
  SessionSnapshot,
  SessionSpec,
  TerminalInjectionMachine,
  TimerHandle,
  TurnDelivery,
  TurnInput,
  TurnReceipt,
  WatchLevel,
} from '../../host.js'
import {
  createRuntimeEventStream,
  createTerminalInjection,
  DriverRefusalError,
  driverLocalCursor,
  ESC,
  RAW_FIRST_TURN_ATTACHMENT_REFUSAL,
  SUBMIT_CR_DELAY_MS,
  sessionHealth,
  stampRuntimeEvent,
  terminalCapabilities,
} from '../../host.js'

const log = createLogger('harness:terminal-driver')

/** Gap between two keystrokes typed into a native menu — comfortably above the
 *  CLI key parser's own 50ms byte-run window, so no two keys share a read.
 *  Carried over verbatim from `apps/server/src/modules/sessions/inbox.ts`. */
const MENU_KEY_DELAY_MS = 120

/** Gap before the closing commit on a multi-question or multi-select menu —
 *  the review step needs a frame to settle before the CR lands. Verbatim from
 *  the same keystroke path. */
const MENU_CONFIRM_DELAY_MS = 240

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

/**
 * How many frames one not-yet-registered session may hold (POD-2107).
 *
 * The window is one `await` wide — a launch or a `processAlive` probe — so a
 * healthy one holds a handful of frames at most. The cap is a backstop against a
 * create that never resolves turning a per-session buffer into a leak, and it is
 * generous rather than tight because the frames it protects are the session's
 * FIRST: `bind`, the opening transcript records, an early exit. Overflow drops
 * the newest and says so, which is the same order of preference the replay
 * buffer above uses — the oldest frames are the ones the session cannot
 * reconstruct.
 */
const PENDING_FRAME_LIMIT = 256

/** How many of the newest history items the exit check reads (POD-4887). A
 *  send whose start lies further back is left unproven, never disproved. */
const EXIT_HISTORY_READ_LIMIT = 500

/** POD-4834: idle submit hooks arrive at +33..358 ms (Grok +42..270).
 * One second allows local hook transport jitter, while excluding the measured
 * +6..10 s busy/dequeue hooks. A hook still needs a matching saved id. */
export const SUBMIT_HOOK_LINK_WINDOW_MS = 1_000
const LATER_PROMPT_LIMIT = 4
const PROOF_WATCH_MS = 30 * 60_000

// ---------------------------------------------------------------------------
// The host port — TerminalHostPorts in ./host-ports.ts (POD-4785)
// ---------------------------------------------------------------------------

/** Refusing a foreign identity or stale lease must never reap the current owner. */
export class TerminalRecoveryRefusal extends Error {}

/** What the host hands about a session at the moment it is put behind the
 *  contract — everything the spawn/reattach frame already carried. */
export interface TerminalSessionRegistration {
  sessionId: SessionId
  agentKind: AgentKind
  cwd: string
  resume: ResumeRef | null
  /** The live terminal the host hands at bind, refreshed via `setTerminal`. */
  terminal?: TerminalTransport
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

/**
 * How far into the harness's transcript the driver has seen (POD-4838).
 *
 * `unknown` until a delta says anything; `empty` when the store's last re-read
 * held no items at all, so everything after it is new; otherwise the segment
 * (the cursor's `fileId`) and the furthest offset/sub-item seen in it. Offsets are the
 * producer's own order key — a byte offset for JSONL, `time_created` for
 * OpenCode — and compare only within one segment.
 */
type TranscriptPosition =
  | { kind: 'unknown' }
  | { kind: 'empty' }
  | { kind: 'at'; fileId: string; offset: number; sub: number }

/**
 * One open accept watch: the prompt text it credits, how to tell it, and where
 * the send started — the transcript position and the clock when the watch was
 * armed, before the first byte went out. Only the history channel reads
 * `start`; see `echoIsAfterStart`.
 */
type AcceptWaiter = {
  text: string
  resolve: (seen: AcceptSeen) => void
  start: { atMs: number; position: TranscriptPosition }
  /** The history moved past this prompt without it (POD-4840): see
   *  `AcceptWatch.passed`. Idempotent. */
  pass: () => void
  /** The harness queued this prompt without recording it (POD-4905): see
   *  `AcceptWatch.held`. Idempotent. */
  hold: () => void
  /** The program's own evidence says this prompt is not in its conversation
   *  (POD-4887): see `AcceptWatch.disproved`. Idempotent; the first wins. */
  disprove: (disproof: Disproof) => void
  /** The id of the podium message this text is, when it is wrapped: the only
   *  thing that confirms it (spec §5.1). Null for a person's own words. */
  frameId: string | null
  /** The foreign-write count when this send's typing started (spec §5.3):
   *  the counter's own mark for a send with an id, else read when the watch
   *  was armed — the same instant, before the first byte. */
  typingMark: () => number | undefined
  /** Order credit is decided on the FIRST prompt entry after the start, and
   *  on the first queue record: set once each has been read. */
  orderSpent: boolean
  queueSpent: boolean
  held: boolean
  turnId?: string
  submittedAtMs?: number
  hookRefs?: HarnessRef
  /** Live-only witness: these native entries were seen before this typing.
   * A rewrite or coarse timestamp cannot make them new. Never persisted. */
  beforeTypingIds: ReadonlySet<string>
  /** Every prompt entry after the start (dedupe for re-reads, and links history
   * that arrives before its hook). The pass budget counts only unexplained
   * entries; see unexplainedSeen. */
  seenPrompts: Map<string, TranscriptItem>
  /** How many seen entries were NOT provably another Podium send (POD-5436):
   *  only these count toward LATER_PROMPT_LIMIT. Every entry is still recorded
   *  in seenPrompts, so a re-read dedupes instead of spending order again. */
  unexplainedSeen: number
  cancel: () => void
}

interface DriverSession {
  resumeConfidence?: 'exact' | 'heuristic'
  identityGeneration?: number
  sessionId: SessionId
  agentKind: AgentKind
  driverId: DriverId
  cwd: string
  /** The handed terminal; undefined while detached (a parked surface reads as detached). */
  terminal: TerminalTransport | undefined
  resume: ResumeRef | null
  bindingVersion: number
  observerGeneration: number
  state?: AgentRuntimeState
  stateGeneration?: number
  lastEmittedCursor?: ProviderCursor
  turnEpoch: number
  /** Highest epoch whose terminal observation has already been folded. */
  fencedTurnEpoch: number
  /** Whether the driver has emitted `turn/started` for the current epoch
   *  without yet emitting its close (POD-4828). A lone `turn_completed` for
   *  an epoch never opened (Grok's first prompt typed by the spawn races the
   *  observer attach, so its `prompt_submitted` lands in bootstrap history
   *  silently and only the close arrives live) synthesizes the missing open —
   *  otherwise the server's turn-epoch-jump gate rejects the close, the
   *  checkpoint never advances, and every later delivery is rejected behind
   *  it while the queue waits on an epoch that was never opened. */
  epochOpen: boolean
  /** The newest cursor an observation gave us; null until one arrives. */
  providerCursor: ProviderCursor | null
  publishedCursor: ProviderCursor | null
  /** Driver-local event counter — the `seq` inside a driver-local cursor, and
   *  the position an `events(after)` consumer resumes from. */
  seq: number
  log: LoggedEvent[]
  wakers: Set<() => void>
  interactions: Map<string, PendingInteraction>
  interactionOwners: Map<string, {
    terminal: TerminalTransport | undefined
    generation: number
    bindingVersion: number
  }>
  answerScript?: { cancel(detail: string): void }
  answered: Set<string>
  /** The open ask a screen-classified wait opened, if any (POD-4632). */
  screenAskId?: string
  lease: SessionLease | null
  draft: string | undefined
  metadata: Map<SessionMetadataChange['kind'], SessionMetadataObservation>
  contextUsedPercent: number | undefined
  observedStatePhase: AgentRuntimeState['phase'] | undefined
  transcriptVersions: Map<string, string>
  /** Identities observed in this process, retained across transcript rewrites. */
  transcriptIds: Set<string>
  injection: TerminalInjectionMachine
  /** Open waiters for native submit hooks, keyed by the prompt text they watch.
   *  A hook supplies a link to saved history; alone it never proves a send. */
  hookWaiters: Set<AcceptWaiter>
  /** Open waiters for the send's record in the history — the proof. See
   *  `creditEchoWaiters`. */
  echoWaiters: Set<AcceptWaiter>
  /** Deltas arriving while restart recovery reads back to its time floor. */
  restoringProofItems?: TranscriptItem[]
  /** The furthest transcript position a delta has shown; each watch copies it
   *  when armed. See {@link TranscriptPosition}. */
  transcriptPosition: TranscriptPosition
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
  liveAtMs?: number
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
  /** Manifest readiness policy, carried into the public send capability. */
  composerReadiness: import('../../../index.js').HarnessComposerReadiness
  instrumentationRequired: boolean
  driverId: DriverId
  sendProof: DriverCapabilities['send']['proof']
  /** Manifest-owned content matchers; absence means no proof on that channel. */
  acceptCorrelation?: TerminalAcceptCorrelations
  /** Native permission/question hooks, independent of submit receipt hooks. */
  interactionsFromHooks?: boolean
  /** Whether transcript entries say when they were written — the echo proof's
   *  floor across segments. Manifest-owned; see `TranscriptTimestampFidelity`. */
  transcriptTimestamps: TranscriptTimestampFidelity
  /** N4 holds for this program (POD-4887): see `TerminalRuntimeSpec`. */
  exitLosesUnrecorded?: boolean
  /** Provider-poll agentState owns lifecycle and epochs; causal observations are ignored. */
  lifecycleFromState?: boolean
  /** Whether this harness's CLI needs the submit-verify CR nudges. */
  needsSubmitVerification: boolean
  /** Grok's fresh TUI ignores bracketed paste until its first native turn. */
  usesRawFirstTurn: boolean
  archivable: boolean
  reportsContextPercent: boolean
  /**
   * THE MANIFEST'S INTERRUPT KEY, AS BYTES (POD-3981).
   *
   * Read from `harnessInterrupt(kind)` in `terminalProfileFor`, never a
   * constant here: there is no universal abort key, and the injection machine
   * writes exactly these bytes. Every terminal harness ships esc today, so
   * every profile in the tree reads `'\x1b'` — the field exists for the day
   * one of them does not.
   */
  interruptBytes: string
  /**
   * Whether pressing the key while NO turn is running exits the CLI. The
   * injection machine withholds the key while idle when true — the contract
   * half of the legacy `abortKeyFor` guard.
   */
  interruptQuitsWhenIdle: boolean
}

// ---------------------------------------------------------------------------
// Observation → RuntimeEvent translation
// ---------------------------------------------------------------------------

/** An observation already contains the folded state, including identity and
 * phase details that cannot be reconstructed from its transition label. This
 * is a snapshot, never an invented task delta or turn acceptance. */
export function stateEventForObservation(
  observation: AgentObservation,
): Extract<AgentStateEvent, { kind: 'state_snapshot' }> {
  return {
    kind: 'state_snapshot',
    state: observation.state,
    at: observation.providerAt ??
      (observation.provenance === 'bootstrap' ? observation.state.since : observation.receivedAt),
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

export interface TerminalStateObservation {
  sessionId: SessionId
  state: AgentRuntimeState
  observerGeneration: number
  bindingVersion: number
  bootstrap?: boolean
}

type TerminalObservation = DaemonMessage | ({ type: 'terminalState' } & TerminalStateObservation)

export interface TerminalRuntime {
  /** Undefined means this session has no driver-owned context channel. */
  boundaryContextFor(sessionId: SessionId): BoundaryContextOperation | undefined

  recoverWithId(msg: TerminalReattachControl, profile: TerminalHarnessProfile): Promise<AgentSessionHandle>
  observeDraft(sessionId: SessionId, text: string): void
  /** Put a session behind the contract. Idempotent for the same binding version:
   *  a reconnect re-sends reattach, and re-registering must rebind rather than
   *  open a second record. */
  register(
    registration: TerminalSessionRegistration,
    profile: TerminalHarnessProfile,
  ): AgentSessionHandle
  handleFor(sessionId: SessionId): AgentSessionHandle | undefined
  bindings(): readonly RuntimeSessionBinding[]
  /** Is this session behind the contract right now? The flag-off fast path. */
  has(sessionId: SessionId): boolean
  /** Refresh the handed terminal — reattach hands one, steal/park replaces it —
   *  without a lookup. A parked or missing terminal reads as detached. */
  setTerminal(sessionId: SessionId, terminal: TerminalTransport | undefined): void
  /** THE EVENT SOURCE. Tap on the daemon's outbound frame stream — see the
   *  header. Returns immediately for a session that is not registered. */
  observe(msg: TerminalObservation): void
  observeState(observation: TerminalStateObservation): void
  /** The causal accept signal: a raw hook payload, before the observers fold it. */
  onHookPayload(sessionId: SessionId, payload: unknown): void
  respondToHook(sessionId: SessionId, payload: unknown, signal?: AbortSignal): Promise<string | null>
  /**
   * THE SUPERVISOR OBSERVED A KERNEL OOM KILL in this session's scope
   * (POD-2413).
   *
   * The fact enters through the DRIVER rather than being sent to the server
   * directly, because a runtime event without a causal envelope is not a
   * runtime event: only the driver holds this session's cursor, observer
   * generation and turn epoch, and the gate rejects anything that arrives
   * without them. The supervisor knows WHAT happened; the driver is what can
   * say it in the stream's own language.
   *
   * Not a death. `OOMPolicy=continue` means the kernel killed one process
   * inside the tree — often a build or a test run the agent started — and the
   * session usually keeps serving. Whether it died is `exited`'s business.
   */
  reportOomKill(sessionId: SessionId, scopeUnit?: string): void

  /** Creation under a server-assigned identity, from the contract's spec: the
   *  same path `driver.create()`/`resume()` take with an id they minted. */
  createWithId(
    sessionId: SessionId,
    spec: SessionSpec,
    profile: TerminalHarnessProfile,
    resume?: ResumeRef,
  ): Promise<AgentSessionHandle>

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

/**
 * Build the terminal driver over a session registry (POD-4512): the ONE live
 * driver handle per session lives ON the DaemonSession entry, not in a
 * per-session index here. The driver-internal `sessions` map below keeps the
 * mechanism (the DriverSession record); the entry owns the handle.
 */
export function createTerminalRuntime(
  host: TerminalHostPorts,
  primeSource:
    | ((sessionId: SessionId) => Promise<{ ok: boolean; result?: unknown }>)
    | undefined,
  slots: SessionDriverSlots,
): TerminalRuntime {
  const contexts = new Map<SessionId, ReturnType<typeof createBoundaryContext>>()
  function boundaryContextFor(sessionId: SessionId): BoundaryContextOperation | undefined {
    if (!primeSource || !profiles.get(sessionId)?.instrumentationRequired) return undefined
    let context = contexts.get(sessionId)
    if (!context) {
      context = createBoundaryContext(() => primeSource(sessionId))
      contexts.set(sessionId, context)
    }
    const owner = context
    return async (request) => {
      if (contexts.get(sessionId) !== owner) return null
      const result = await owner.respond(request)
      return contexts.get(sessionId) === owner ? result : null
    }
  }

  const sessions = new Map<SessionId, DriverSession>()
  /**
   * Stream position and turn epoch, per PROCESS identity.
   *
   * Survives a handle being dropped and re-adopted; dies with the daemon
   * process, exactly like the process-tree knowledge it stands for. See `emit`
   * for why an adopt must not rewind either number.
   */
  const streamPositions = new Map<
    SessionId,
    { seq: number; turnEpoch: number; fencedTurnEpoch: number }
  >()
  const profiles = new Map<SessionId, TerminalHarnessProfile>()
  const registrations = new Map<SessionId, TerminalSessionRegistration>()
  // NO HANDLE INDEX HERE (POD-4512): the entry owns the handle; the reads and
  // writes below go through this driver's own view of the entries' slots, so a
  // lookup never answers with — and a teardown never empties — a slot another
  // driver has bound (POD-4610).
  /** Forget one entry's driver handle without touching the handle itself. */
  const forgetDriver = (sessionId: SessionId): void => slots.release(sessionId)
  /**
   * FRAMES FOR A SESSION THIS DRIVER HAS CLAIMED BUT NOT YET REGISTERED (POD-2107).
   *
   * `observe()` matches a frame against `sessions`, and `create()`/`resume()`/
   * `adopt()` each register one AWAIT after they commit to a session id. A frame
   * naming that id in between used to be discarded, and the frame that matters
   * most in that window is `bind` — the one fact that flips `live`, which is the
   * one thing the queue drain waits for. A dropped bind therefore left `live`
   * false for the life of the session, and the ready-poll drain abandoned every
   * queued turn at its 25s deadline WITHOUT typing and WITHOUT an event, while
   * the sender held a receipt that said `queued`. That is the POD-549-class
   * silent loss the durable queue exists to prevent.
   *
   * WHY BUFFER RATHER THAN REGISTER FIRST. Registering before the await would
   * close the same window, but it puts a session record in the map for a process
   * that may never exist: `create()` would leave a phantom behind when
   * `host.launch` throws, and `adopt()` MUST NOT hold a record when
   * `processAlive` says no — refusing is its whole contract, and a phantom
   * would then answer `not_running` to everything until something called
   * `clear()`. Buffering keeps registration exactly where it is and only changes
   * what happens to frames that arrive early: they are replayed, in arrival
   * order, through the same `observe()` the daemon would have called.
   *
   * IT DOES NOT SET `live` OPTIMISTICALLY, which is the trap this fix has to
   * avoid. The buffered `bind` is the same evidence a punctual one is; it is
   * merely delivered late. Typing into a still-painting CLI is the no-op
   * `DriverSession.live` exists to prevent, and nothing here fabricates it.
   *
   * KEYED ON CLAIMED IDS ONLY, so an unknown session id is still dropped on the
   * floor as before — this map holds one entry per in-flight create/adopt, never
   * one per frame the daemon sends about somebody else's session.
   */
  const pendingFrames = new Map<SessionId, TerminalObservation[]>()

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
    if (!base) return driverLocalCursor(session.sessionId, seq)
    const previous = session.lastEmittedCursor ?? session.publishedCursor
    const predecessor =
      previous &&
      previous.segmentId !== base.segmentId &&
      previous.segmentId === driverLocalCursor(session.sessionId, 0).segmentId
        ? { predecessorSegmentId: previous.segmentId }
        : {}
    return { ...base, ...predecessor, components: { ...base.components, seq } }
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
    streamPositions.set(session.sessionId, {
      seq: session.seq,
      turnEpoch: session.turnEpoch,
      fencedTurnEpoch: session.fencedTurnEpoch,
    })
    const event = stampRuntimeEvent(body, at, provenance, {
      cursor: cursorFor(session, session.seq, cursor),
      observerGeneration: session.observerGeneration,
      turnEpoch: session.turnEpoch,
    })
    session.lastEmittedCursor = event.cursor
    session.publishedCursor = event.cursor
    if (event.t === 'metadata') session.metadata.set(event.change.kind, event)
    session.log.push({ seq: session.seq, event })
    const timingBinding = slots.get(session.sessionId)?.binding
    if (timingBinding) host.traceRuntimeEvent?.(timingBinding, event)
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
    if (isRuntimeFineEvent(event)) {
      host.send({ type: 'runtimeFineEvent', sessionId: session.sessionId, event })
    } else {
      host.send({ type: 'runtimeEvent', sessionId: session.sessionId, event })
    }
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
    const kindAndPayload = askSpecFor(observation.state.need)
    const interaction: PendingInteraction = {
      id: `ask:${observation.transitionId}`,
      sessionId: session.sessionId,
      ...kindAndPayload,
      askedAt: observation.providerAt ?? observation.receivedAt,
      source: profile?.interactionsFromHooks ? 'hook' : 'screen-classifier',
      // Even a hook-SOURCED ask is answered by typing digits into a native menu,
      // and a keystroke cannot prove which menu it acted on.
      answerable: 'keystroke-emulated',
    }
    if (session.interactions.has(interaction.id) || session.answered.has(interaction.id)) return
    closeOpenInteractions(session, interaction.askedAt, observation.provenance, null)
    openAsk(session, interaction, observation.provenance, observation.providerCursor)
    if (interaction.kind === 'question' && interaction.payload.questions.every((q) => q.options.length === 0)) {
      const generation = session.observerGeneration
      const terminal = terminalFor(session)
      void host.readHistory({ sessionId: session.sessionId, agentKind: session.agentKind,
        cwd: session.cwd, ...(session.resume ? { resume: session.resume } : {}) }, { limit: 50 })
        .then((page) => {
          const items = page.items
          if (session.disposed || session.answerScript || session.observerGeneration !== generation ||
              terminalFor(session) !== terminal || session.interactions.get(interaction.id) !== interaction) return
          const item = [...items].reverse().find((i) => i.role === 'tool' && i.toolName === 'AskUserQuestion' && i.toolInputJson)
          if (!item?.toolInputJson) return
          const parsed = JSON.parse(item.toolInputJson) as { questions?: NonNullable<NonNullable<AgentRuntimeState['need']>['interview']>['questions'] }
          if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return
          // A historical tool call cannot enrich a different on-screen prompt.
          const summary = interaction.payload.questions[0]?.question
          if (!summary || !parsed.questions.some((q) => q.question === summary)) return
          const questions = interviewPrompts({ kind: 'question', summary, interview: { questions: parsed.questions } })
          if (!questions) return
          const enriched: PendingInteraction = { ...interaction, payload: { v: 1, questions } }
          session.interactions.set(interaction.id, enriched)
          emit(session, { t: 'interaction', ev: { ev: 'asked', interaction: enriched } }, interaction.askedAt, observation.provenance)
        }).catch(() => { /* The observed menu remains authoritative when enrichment fails. */ })
    }
  }

  /**
   * A WAIT ONLY THE SCREEN SAW (POD-4632).
   *
   * Asks otherwise open from the causal stream, and the server leaves a
   * driver-routed session's asks to the driver. A dialog the CLI draws before
   * any hook or transcript exists — Claude's first-run folder trust — reaches
   * the driver only as a tracked `needs_user` state from the screen classifier,
   * so without this it was a state with no ask behind it: nothing in Chat, and
   * a session that read as idle. Only the classifier channel opens one; a
   * hook-reported wait belongs to the causal stream that already asks for it.
   *
   * The identity is the wait's `since`, so a re-published identical wait is the
   * same ask and a new wait is a new one.
   */
  function syncScreenAsk(
    session: DriverSession,
    state: AgentRuntimeState,
    provenance: ObservationProvenance,
  ): void {
    if (state.phase !== 'needs_user') {
      closeScreenAsk(session, state.stateObservedAt ?? state.since, provenance)
      return
    }
    if (state.stateSource !== 'classifier') return
    const id = `ask:screen:${state.since}`
    if (session.interactions.has(id) || session.answered.has(id)) return
    const interaction: PendingInteraction = {
      id,
      sessionId: session.sessionId,
      ...askSpecFor(state.need),
      askedAt: state.since,
      source: 'screen-classifier',
      answerable: 'keystroke-emulated',
    }
    closeOpenInteractions(session, interaction.askedAt, provenance, null)
    openAsk(session, interaction, provenance)
    session.screenAskId = id
  }

  /** Close a screen-opened ask once the session left that wait. Nobody typed
   *  through the contract, so a person at the terminal answered it. */
  function closeScreenAsk(
    session: DriverSession,
    at: string,
    provenance: ObservationProvenance,
  ): void {
    const id = session.screenAskId
    if (id === undefined) return
    session.screenAskId = undefined
    if (!session.interactions.has(id)) return
    session.interactions.delete(id)
    session.interactionOwners.delete(id)
    session.answered.add(id)
    emit(
      session,
      { t: 'interaction', ev: { ev: 'answered', id, answeredBy: 'human', at } },
      at,
      provenance,
    )
  }

  function openAsk(
    session: DriverSession,
    interaction: PendingInteraction,
    provenance: ObservationProvenance,
    cursor?: ProviderCursor,
  ): void {
    session.interactions.set(interaction.id, interaction)
    session.interactionOwners.set(interaction.id, {
      terminal: terminalFor(session),
      generation: session.observerGeneration,
      bindingVersion: session.bindingVersion,
    })
    emit(
      session,
      { t: 'interaction', ev: { ev: 'asked', interaction } },
      interaction.askedAt,
      provenance,
      cursor,
    )
  }

  function askSpecFor(need: AgentRuntimeState['need']): InteractionAskSpec {
    // THE PAYLOAD IS TYPED PER KIND (POD-2020 replaced the opaque record), so
    // the two arms are built separately rather than from one merged bag.
    //
    // WHAT THE DRIVER CAN AND CANNOT FILL, stated because the gaps are real:
    // `AgentRuntimeState.need` carries the tool name and a bounded detail for a
    // permission. For a question it carries a summary, AND — when the reporting
    // channel saw the tool input — the interview: every question and option,
    // which becomes the ask's prompts with the flags answering needs. When the
    // channel carried no interview the arm ships one option-less prompt, which
    // is honest: the ask exists, the session is blocked, and the options are
    // not knowable here. The server aggregate reads the transcript tail and
    // fills them in.
    return need?.kind === 'permission'
      ? {
          kind: 'permission',
          payload: {
            v: 1,
            toolName: need.ask?.toolName ?? need.summary ?? 'unknown tool',
            ...(need.ask?.detail ? { inputSummary: need.ask.detail } : {}),
            canAlwaysAllow: need.ask?.canAlwaysAllow ?? false,
          },
        }
      : {
          kind: 'question',
          payload: {
            v: 1,
            // THE OBSERVED MENU, when the channel carried one. `need.interview`
            // is the tool input's own questions — the same shape the server's
            // synthesis normalizes — so the ask ships the flags (`multiSelect`,
            // `previewLayout`, `otherIndex`) its own answering needs. Absent =
            // the honest option-less prompt this always shipped.
            questions: interviewPrompts(need) ?? [
              {
                question: need?.summary ?? '',
                multiSelect: false,
                previewLayout: false,
                options: [],
              },
            ],
          },
        }
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
    answeredBy: 'policy' | 'superagent' | 'human' | null,
  ): void {
    session.answerScript?.cancel('the menu was resolved or replaced')
    for (const id of [...session.interactions.keys()]) {
      session.interactions.delete(id)
      session.interactionOwners.delete(id)
      session.answered.add(id)
      emit(
        session,
        { t: 'interaction', ev: answeredBy === null ? { ev: 'expired', id, at } : { ev: 'answered', id, answeredBy, at } },
        at,
        provenance,
      )
    }
  }

  // -- the outbound-frame tap ----------------------------------------------

  /**
   * Hold one frame for a session id this driver has claimed but not registered.
   *
   * A NO-OP FOR EVERY OTHER ID, which is what keeps this cheap and bounded: the
   * daemon's outbound sink carries every session on the machine past this tap,
   * and only the one or two ids with a create/adopt in flight have an entry to
   * push onto. See {@link pendingFrames}.
   */
  function holdUntilRegistered(sessionId: SessionId, msg: TerminalObservation): void {
    const held = pendingFrames.get(sessionId)
    if (!held) return
    if (held.length >= PENDING_FRAME_LIMIT) {
      // SAID, NOT SWALLOWED. Dropping a frame here is the very failure this
      // buffer exists to end, so the one case where it still happens is the one
      // case that gets a line in the log.
      log.warn('dropped a frame for a session whose registration never arrived', {
        sessionId,
        type: msg.type,
        held: held.length,
      })
      return
    }
    held.push(msg)
  }

  /**
   * Claim a session id for the length of one create/resume/adopt, so frames
   * naming it are held rather than dropped until `register()` replays them.
   *
   * The `finally` is for the paths that never reach `register()` — a launch that
   * throws, an adopt whose durable host is gone. `register()` removes the entry
   * itself on the success path, so this only ever cleans up after a failure.
   */
  async function claiming<T>(sessionId: SessionId, open: () => Promise<T>): Promise<T> {
    pendingFrames.set(sessionId, [])
    try {
      return await open()
    } finally {
      pendingFrames.delete(sessionId)
    }
  }

  /** One identity gate for ordinary tail deltas and lifecycle reconciliation. */
  function emitTranscriptItems(
    session: DriverSession,
    items: readonly TranscriptItem[],
    provenance: ObservationProvenance,
  ): void {
    for (const item of items) {
      const identity = item.cursor ?? item.id
      const version = JSON.stringify(item)
      if (session.transcriptVersions.get(identity) === version) continue
      session.transcriptVersions.set(identity, version)
      emit(
        session,
        { t: 'item', item: { kind: 'complete', item } },
        item.ts ?? new Date(host.now()).toISOString(),
        provenance,
      )
    }
  }

  function observeDraft(sessionId: SessionId, text: string): void {
    const session = sessions.get(sessionId)
    if (!session || session.disposed || session.draft === text) return
    session.draft = text
    emit(session, { t: 'draft', text }, observedAt(), 'live')
  }

  function observeMetadata(session: DriverSession, change: SessionMetadataChange, at?: string): void {
    const prior = session.metadata.get(change.kind)
    if (change.kind === 'title') {
      if (isCommandWrapperText(change.title)) return
      const title = stripSpinnerFrame(change.title)
      if (isTransientTitle(title)) return
      if (isGenericClaudeTitle(title) && prior?.change.kind === 'title' &&
          !isGenericClaudeTitle(prior.change.title)) return
      change = { ...change, title }
    }
    // Omitted effort is not a reset. Keep the latest pair in the snapshot even
    // when the next assistant record names only its model.
    if (change.kind === 'model' && change.effort === undefined && prior?.change.kind === 'model') {
      change = { ...change, ...(prior.change.effort !== undefined ? { effort: prior.change.effort } : {}) }
    }
    if (JSON.stringify(prior?.change) === JSON.stringify(change)) return
    // Prefer the native record's time. OSC and native callbacks without a
    // timestamp have only a sighting time; snapshot/reconnect preserves it.
    emit(session, { t: 'metadata', change }, at ?? observedAt(), 'live')
  }

  function observe(msg: TerminalObservation): void {
    if (msg.type === 'terminalState') {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        holdUntilRegistered(msg.sessionId, msg)
        return
      }
      if (
        msg.observerGeneration !== session.observerGeneration ||
        msg.bindingVersion !== session.bindingVersion
      )
        return
      const bootstrap =
        msg.bootstrap === true ||
        (session.observerGeneration > 1 && session.stateGeneration !== session.observerGeneration)
      if (!bootstrap) applyStateLifecycle(session, msg.state)
      else session.observedStatePhase = msg.state.phase
      publishState(
        session,
        msg.state,
        msg.state.stateObservedAt ?? msg.state.since,
        bootstrap ? 'bootstrap' : 'live',
      )
      syncScreenAsk(session, msg.state, bootstrap ? 'bootstrap' : 'live')
      return
    }
    const claimedId =
      msg.type === 'agentObservation'
        ? msg.observation.podiumSessionId
        : 'sessionId' in msg
          ? (msg.sessionId as SessionId)
          : undefined
    if (claimedId && pendingFrames.has(claimedId)) {
      holdUntilRegistered(claimedId, msg)
      return
    }
    // `agentObservation` is keyed by `observation.podiumSessionId`, not by a
    // top-level `sessionId` — it is the one frame whose session id lives inside
    // its payload, so it is matched before the shared guard below.
    if (msg.type === 'agentObservation') {
      const observed = sessions.get(msg.observation.podiumSessionId)
      if (observed) applyObservation(observed, msg.observation)
      else holdUntilRegistered(msg.observation.podiumSessionId, msg)
      return
    }
    if (!('sessionId' in msg) || typeof msg.sessionId !== 'string') return
    const session = sessions.get(msg.sessionId as SessionId)
    if (!session) {
      holdUntilRegistered(msg.sessionId as SessionId, msg)
      return
    }
    switch (msg.type) {
      case 'transcriptDelta': {
        // REPLACE, don't accumulate, when the harness says its store was reset —
        // the same answer the server's transcript buffer gives. See
        // `DriverSession.userTurns` for what counting the other way costs.
        if (msg.reset) session.userTurns = 0
        session.userTurns += msg.items.filter((item) => item.role === 'user').length
        // THE COUNT NO LONGER PROVES A SEND (POD-4055). It still answers
        // `rawFirstTurn`, which is a question about the CONVERSATION's position
        // and not about any one delivery. Delivery is proven by content, below.
        // Credit BEFORE the position moves: each watch compares against where
        // the transcript stood when it was armed, not where this delta leaves it.
        creditEchoWaiters(session, msg.items)
        for (const item of msg.items) {
          // Proof-only records may have no native item id. Their exact cursor
          // still identifies a replay; an empty id cannot identify every receipt.
          const identity = item.id || item.cursor
          if (identity) session.transcriptIds.add(identity)
        }
        session.restoringProofItems?.push(...msg.items.filter((item) => item.role === 'user'))
        // A re-read keeps the time floor and deduplicates entries; restarting
        // or rewriting the store does not itself exhaust a proof watch.
        session.transcriptPosition = advancePosition(
          msg.reset ? (msg.items.length === 0 ? { kind: 'empty' } : { kind: 'unknown' }) : session.transcriptPosition,
          msg.items,
        )
        // The conversation only: proof-only queue records stay here (POD-4905).
        const shown = msg.items.filter((item) => !isProofOnlyItem(item))
        if (msg.reset) {
          session.transcriptVersions.clear()
          for (const item of shown) {
            session.transcriptVersions.set(item.cursor ?? item.id, JSON.stringify(item))
          }
          emit(
            session,
            {
              t: 'transcript-reset',
              items: shown,
              ...(msg.tail !== undefined ? { tail: msg.tail } : {}),
            },
            shown.at(-1)?.ts ?? observedAt(),
            'bootstrap',
          )
        } else {
          emitTranscriptItems(session, shown, 'live')
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
        session.liveAtMs = host.now()
        return
      }
      case 'agentExit': {
        session.answerScript?.cancel('the process ended')
        session.alive = false
        session.live = false
        void settleExited(session)
        // The process tree is gone. Its stream position dies with it for the
        // same reason `clear` drops one: a later process under this session is a
        // different conversation, and carrying a position across would fence out
        // its first events as already-seen.
        streamPositions.delete(session.sessionId)
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
        // Track the worktree root the daemon resolved: the snapshot's
        // binding.workdir must stay current for reconnect, and the contract
        // event must carry the full native facts (kind/branch/repoRoot/
        // explicit) so the server's contract-only projection can update the
        // row and adopt the issue worktree without the legacy frame.
        session.cwd = msg.cwd
        emit(
          session,
          {
            t: 'workspace',
            ev: {
              ev: 'cwd-changed',
              cwd: msg.cwd,
              ...(msg.kind ? { kind: msg.kind } : {}),
              ...(msg.branch ? { branch: msg.branch } : {}),
              ...(msg.repoRoot ? { repoRoot: msg.repoRoot } : {}),
              ...(msg.explicit ? { explicit: true } : {}),
            },
          },
          observedAt(),
          'live',
        )
        return
      }
      case 'sessionGitActivity': {
        // Late attribution travels here: git-capture's async rev-parse/rev-list
        // can resolve after the turn completed or the next turn started. The
        // event carries the session's identity, not a turn's — the server
        // admits workspace git-activity lifecycle-independently, attributes to
        // the session's issue, and never reopens the turn. Empty (baseline
        // registration) still projects so the issue leaves fallback mode.
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
        // Full native identity, not URL-only: requestId preserves callback/
        // dismissal routing and reconnect idempotence, callbackTarget preserves
        // the loopback paste-back capability, expiresAt preserves expiry, and
        // intent preserves login-versus-link affordance. The daemon's
        // BrowserOpenManager still owns the pending capability and executes
        // the callback; this event is how the server's gateway learns it
        // without the legacy frame.
        emit(
          session,
          {
            t: 'open-url',
            ev: {
              url: msg.url,
              intent: msg.intent === 'login' ? 'login' : 'link',
              requestId: msg.requestId,
              ...(msg.callbackTarget ? { callbackTarget: msg.callbackTarget } : {}),
              expiresAt: msg.expiresAt,
            },
          },
          new Date(host.now()).toISOString(),
          'live',
        )
        return
      }
      case 'nativeDraft': {
        observeDraft(session.sessionId, msg.text)
        return
      }
      case 'agentState':
        // Legacy transport is no longer a driver input.
        return
      case 'title': {
        const source = msg.source ?? 'native'
        if (source === 'osc' && harnessCapabilitiesFor(session.agentKind)?.oscTitle === false) return
        observeMetadata(session, { kind: 'title', source, title: msg.title })
        return
      }
      case 'agentColor': {
        observeMetadata(session, { kind: 'color', source: 'transcript', color: msg.color }, msg.at)
        return
      }
      case 'agentModel': {
        observeMetadata(session, { kind: 'model', source: msg.source ?? 'transcript', model: msg.model,
          ...(msg.effort !== undefined ? { effort: msg.effort } : {}) }, msg.at)
        return
      }
      case 'agentContext': {
        session.contextUsedPercent = msg.percent
        observeMetadata(session, { kind: 'context', source: 'transcript', percent: msg.percent }, msg.at)
        return
      }
      case 'sessionResumeRef': {
        // The harness minted its native id. Captured as EARLY as the harness
        // allows, per `resumeRefTiming` — this is that moment for every terminal
        // harness, and it is what unblocks `hibernate()` and `export()`.
        if (
          (msg.observerGeneration !== undefined && msg.observerGeneration !== session.observerGeneration) ||
          (msg.bindingVersion !== undefined && msg.bindingVersion !== session.bindingVersion)
        ) return
        if (msg.confidence !== 'exact' && session.resumeConfidence === 'exact') return
        if (!msg.receipt && session.resume?.kind === msg.resume.kind &&
            session.resume.value === msg.resume.value &&
            session.resumeConfidence === (msg.confidence ?? 'heuristic')) return
        session.resume = msg.resume
        session.resumeConfidence = msg.confidence ?? 'heuristic'
        const identityBootstrap = session.observerGeneration > 1 &&
          session.identityGeneration !== session.observerGeneration &&
          session.stateGeneration !== session.observerGeneration
        session.identityGeneration = session.observerGeneration
        emit(session, {
          t: 'binding', resume: msg.resume,
          confidence: msg.confidence ?? 'heuristic',
          bindingVersion: session.bindingVersion,
          ...(msg.ackRequested ? { ackRequested: true } : {}),
          ...(msg.receipt ? { receipt: msg.receipt } : {}),
        }, observedAt(), identityBootstrap ? 'bootstrap' : 'live')
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

  const activeTurnPhase = (phase: AgentRuntimeState['phase'] | undefined): boolean =>
    phase === 'working' || phase === 'compacting' || phase === 'needs_user'

  function applyStateLifecycle(session: DriverSession, state: AgentRuntimeState): void {
    if (!profiles.get(session.sessionId)?.lifecycleFromState || state.stateSource !== 'poll') return
    const prior = session.observedStatePhase
    session.observedStatePhase = state.phase
    const at = state.since
    if (activeTurnPhase(state.phase) && !activeTurnPhase(prior)) {
      session.turnEpoch += 1
      session.epochOpen = true
      emit(
        session,
        { t: 'turn', ev: { ev: 'started', turnEpoch: session.turnEpoch, origin: 'human' } },
        at,
        'live',
      )
      return
    }
    if (state.phase === 'idle' && activeTurnPhase(prior)) {
      session.fencedTurnEpoch = Math.max(session.fencedTurnEpoch, session.turnEpoch)
      session.epochOpen = false
      emit(
        session,
        {
          t: 'turn',
          ev: {
            ev: 'completed',
            turnEpoch: session.turnEpoch,
            verdict: state.idle?.kind ?? 'done',
          },
        },
        at,
        'live',
      )
    }
  }

  function publishState(
    session: DriverSession,
    state: AgentRuntimeState,
    at: string,
    provenance: ObservationProvenance,
    cursor?: ProviderCursor,
  ): void {
    if (
      !cursor &&
      session.stateGeneration === session.observerGeneration &&
      isDeepStrictEqual(session.state, state)
    )
      return
    // A CLOSED EPOCH DOES NOT REOPEN VIA POLL EITHER (POD-4804). A live
    // `working`/`compacting` snapshot stamped in a fenced epoch is exactly what
    // the server rejects as `terminal-epoch-closed` — and folding it here is
    // what flipped the driver back to working with no turn open. Suppress the
    // fold and the emit; bootstrap restores stay exempt. `needs_user` is left
    // to the ask path (the server admits those snapshots), and idle/errored
    // still land.
    if (
      provenance !== 'bootstrap' &&
      session.fencedTurnEpoch >= session.turnEpoch &&
      session.turnEpoch > 0 &&
      (state.phase === 'working' || state.phase === 'compacting')
    ) {
      return
    }
    session.state = state
    session.stateGeneration = session.observerGeneration
    emit(
      session,
      { t: 'state', change: { kind: 'state_snapshot', state, at } },
      at,
      provenance,
      cursor,
    )
  }

  function applyObservation(session: DriverSession, observation: AgentObservation): void {
    // A stale generation is REJECTED, never merged — the rule the envelope's
    // `observerGeneration` exists to enforce, applied at the driver's own door.
    if (
      observation.observerGeneration < session.observerGeneration ||
      observation.bindingVersion < session.bindingVersion ||
      (session.resume && observation.providerSessionId !== session.resume.value)
    )
      return
    if (session.observerGeneration !== observation.observerGeneration ||
        session.bindingVersion < observation.bindingVersion) {
      session.answerScript?.cancel('observer ownership changed')
    }
    session.observerGeneration = observation.observerGeneration
    session.bindingVersion = Math.max(session.bindingVersion, observation.bindingVersion)
    session.providerCursor = observation.providerCursor
    const lifecycleFromState = profiles.get(session.sessionId)?.lifecycleFromState === true
    let alreadyFenced = false
    // The driver's epoch BEFORE this observation folds (POD-4828). A lone
    // close synthesizes its open only when the driver already knows the epoch
    // — seen silently via a bootstrap snapshot (history folded with no live
    // callbacks) but never opened live. A close for an epoch the driver never
    // saw (conformance lone closes, fresh turns) stays a close alone.
    const priorTurnEpoch = session.turnEpoch
    if (!lifecycleFromState) {
      alreadyFenced =
        observation.transitionKind === 'turn_terminal' &&
        observation.turnEpoch <= session.fencedTurnEpoch
      // A CLOSED EPOCH DOES NOT REOPEN (POD-4804). The server's gate rejects a
      // live `working` snapshot in a closed epoch as `terminal-epoch-closed`
      // (and F18 shows the daemon sending exactly those after Grok's first
      // turn); worse, folding one here flips the driver's own phase back to
      // working with no turn open to ever end it, so the delivery queue holds
      // follow-ups for the outer 30 min ceiling while the status reads working.
      // Suppress every non-bootstrap observation in a fenced epoch outright:
      // a duplicate close (alreadyFenced above), a late activity that would
      // restamp working, or a stale open for an epoch that already closed.
      // A genuinely new turn carries `turnEpoch > fencedTurnEpoch` and passes.
      if (
        !alreadyFenced &&
        observation.provenance !== 'bootstrap' &&
        observation.turnEpoch <= session.fencedTurnEpoch
      ) {
        return
      }
      // MONOTONIC. Fences are absorbing: an epoch that closed does not reopen, and
      // an epoch that went backwards would make a replayed stream read as new work.
      session.turnEpoch = Math.max(session.turnEpoch, observation.turnEpoch)
      if (observation.transitionKind === 'turn_terminal') {
        session.fencedTurnEpoch = Math.max(session.fencedTurnEpoch, observation.turnEpoch)
      }
    }
    // The lone-close net below decides before the fenced return, so its own
    // absorbing guard (!alreadyFenced) is what keeps a closed epoch closed —
    // and what the ARM removes to prove it. Everything else still returns here.
    const at = observation.providerAt ??
      (observation.provenance === 'bootstrap' ? observation.state.since : observation.receivedAt)
    // A LONE CLOSE OPENS FIRST (POD-4828), decided BEFORE the fenced return
    // so its own guard is what keeps a closed epoch closed (and what the ARM
    // below removes to prove it). The close proves its turn ran, but the open
    // never arrived live: Grok's spawn-typed first prompt races the observer
    // attach (its hook is buffered pre-bootstrap and its file record lands in
    // history — when the record wins the race the fold opens silently and the
    // replay dedupes, so only the close arrives live). Without the open the
    // server's turn-epoch-jump gate rejects the close, the checkpoint stalls,
    // and every later delivery is rejected behind it. Synthesize the missing
    // open at the close's own instant and epoch, immediately before the
    // close. Order is what the gate reads; the turn did run, so nothing here
    // is invented. Fires ONLY for an epoch the driver already knows
    // (priorTurnEpoch): a bootstrap snapshot carried it, but no live open
    // did — a close for a never-seen epoch (conformance lone closes, fresh
    // turns) stays a close alone, exactly as before. Poll-owned lifecycles
    // never take this branch (their edges always open before they close).
    if (
      !lifecycleFromState &&
      observation.transitionKind === 'turn_terminal' &&
      observation.provenance === 'live' &&
      !session.epochOpen &&
      // Absorbing fence (POD-4804): never fire for an epoch at or below the
      // fence. A duplicate or late close of an already-closed epoch stays
      // silent instead of reopening it with a synthesized started.
      !alreadyFenced &&
      observation.turnEpoch === priorTurnEpoch
    ) {
      session.epochOpen = true
      emit(
        session,
        {
          t: 'turn',
          ev: { ev: 'started', turnEpoch: observation.turnEpoch, origin: observation.inputOrigin },
        },
        at,
        observation.provenance,
        observation.providerCursor,
      )
    }
    if (alreadyFenced) return
    const transcriptFence = {
      observerGeneration: session.observerGeneration,
      bindingVersion: session.bindingVersion,
    }

    // Poll state owns lifecycle and epochs for this harness. The observation
    // envelope still carries cursor, generation, asks, transcript items and
    // state events, so only its lifecycle mutation and turn event are skipped.
    // (`at` is computed above, ahead of the lone-close net, so both emissions
    // share the close's own instant.)
    const turn = lifecycleFromState ? null : turnEventForObservation(observation)
    if (turn) {
      if (observation.transitionKind === 'turn_opened') session.epochOpen = true
      if (observation.transitionKind === 'turn_terminal') session.epochOpen = false
      emit(session, turn, at, observation.provenance, observation.providerCursor)
    }

    const change = stateEventForObservation(observation)
    session.state = change.state
    session.stateGeneration = session.observerGeneration
    emit(session, { t: 'state', change }, at, observation.provenance, observation.providerCursor)

    // This boundary is the current causal envelope, after generation/binding adoption.
    // Driver-private screen state does not authorize transcript reconciliation.
    if (observation.transitionKind === 'turn_terminal') {
      void reconcileTranscript(session, transcriptFence)
    }

    if (observation.nextPhase === 'needs_user') askFromObservation(session, observation)
    else if (observation.priorPhase === 'needs_user') {
      closeOpenInteractions(session, at, observation.provenance, 'human')
    } else {
      // The causal stream's prior phase never saw a screen-only wait, so the
      // first transition out of it (the held prompt starting) closes that ask.
      closeScreenAsk(session, at, observation.provenance)
    }
  }

  async function reconcileTranscript(
    session: DriverSession,
    fence: { observerGeneration: number; bindingVersion: number },
  ): Promise<void> {
    const registration = registrations.get(session.sessionId)
    if (!registration) return
    try {
      const items = (
        await host.readHistory(
          {
            sessionId: session.sessionId,
            agentKind: session.agentKind,
            cwd: registration.cwd,
            ...(session.resume ? { resume: session.resume } : {}),
          },
          { limit: 2000 },
        )
      ).items
      if (
        sessions.get(session.sessionId) !== session ||
        session.disposed ||
        session.observerGeneration !== fence.observerGeneration ||
        session.bindingVersion !== fence.bindingVersion
      )
        return
      emitTranscriptItems(session, items, 'live')
    } catch (error) {
      log.warn('terminal transcript completion reconcile failed', {
        err: error,
        sessionId: session.sessionId,
      })
    }
  }

  // -- the native submit link ----------------------------------------------

  /**
   * Bind a raw submit hook to our own Enter and text before the observers fold
   * it. Only a later saved prompt carrying that id makes it receipt proof.
   */
  function onHookPayload(sessionId: SessionId, payload: unknown): void {
    const session = sessions.get(sessionId)
    if (!session) return
    const correlation = profiles.get(sessionId)?.acceptCorrelation?.hook
    if (!correlation?.accepts(payload)) return
    // Never a receipt (POD-4905): the hook may carry the program's own id for
    // the prompt (POD-4841), which a send the history proves may keep —
    // whether that id can be the send's is the injection machine's call.
    const harnessRef = correlation.harnessRef?.(payload)
    const waiter = creditAcceptWaiter(
      session.hookWaiters, correlation, payload, harnessRef ? { harnessRef } : {},
      (waiter) => waiter.submittedAtMs !== undefined && host.now() >= waiter.submittedAtMs &&
        host.now() - waiter.submittedAtMs <= SUBMIT_HOOK_LINK_WINDOW_MS,
    )
    if (!waiter || !harnessRef) return
    const echoes = [...session.echoWaiters].filter((echo) =>
      echo.turnId === waiter.turnId && echo.text === waiter.text,
    )
    if (echoes.length !== 1) return
    const echo = echoes[0]!
    echo.hookRefs = harnessRef
    if (host.now() >= echo.start.atMs + PROOF_WATCH_MS) return
    const recorded = [...echo.seenPrompts.values()].find((item) =>
      item.harnessRef?.some((ref) => harnessRef.some((hook) => ref.kind === hook.kind && ref.id === hook.id)))
    if (recorded) confirmRecorded(session, echo, recorded)
  }

  /**
   * Both channels credit at most one waiter per observation, by CONTENT.
   * Two sends can be in flight (a queue drain overlapping a chat send); "the
   * next observation wins" would report an accept for a turn that never landed.
   * Unmatched waiters stay open and resolve as `unverified`, the honest answer.
   */
  function creditAcceptWaiter<Observation>(
    waiters: DriverSession['hookWaiters'],
    correlation: TerminalAcceptCorrelation<Observation>,
    observation: Observation,
    seen: AcceptSeen,
    eligible: (waiter: AcceptWaiter) => boolean = () => true,
  ): AcceptWaiter | undefined {
    if (waiters.size === 0) return undefined
    const fingerprint = correlation.fingerprint(observation)
    // FAIL CLOSED. An unattributable payload cannot credit an arbitrary waiter,
    // including one whose own fingerprint is null. The keystrokes still went
    // out; `unverified` is true and a mis-credit would be worse.
    if (fingerprint === null) return undefined
    const candidates = [...waiters].filter((waiter) => eligible(waiter) &&
      (correlation.textMatches
        ? correlation.textMatches(waiter.text, observation)
        : correlation.fingerprintText(waiter.text) === fingerprint))
    if (candidates.length !== 1) return undefined
    const waiter = candidates[0]!
    waiters.delete(waiter)
    waiter.resolve(seen)
    return waiter
  }

  /**
   * THE HISTORY PROVES A SEND (spec §5.1–§5.3, POD-4905). For each prompt
   * entry the harness wrote after a send started:
   *
   *   - A WRAPPED message is credited by the entry's own frame id and nothing
   *     else — other text in the entry, or a foreign write, changes nothing.
   *   - ORDER PLUS TEXT: the first prompt at/after typing started, equal within
   *     the program's measured tolerance, with no other open send sharing it.
   *     Foreign writes and writer leases remain diagnostics, not vetoes.
   *   - HOOK PLUS HISTORY: our Enter and text bind a timely submit hook; a
   *     recorded prompt after the time floor carries that hook's native id.
   *     Its recorded text may differ. The hook alone proves nothing.
   *
   * A proof-only `queued` record (Claude's `enqueue`) is judged by the same
   * two rules and only HOLDS a send: `accepted`, not delivered.
   */
  function creditEchoWaiters(session: DriverSession, items: readonly TranscriptItem[]): void {
    const profile = profiles.get(session.sessionId)
    const correlation = profile?.acceptCorrelation?.['transcript-echo']
    if (!correlation || session.echoWaiters.size === 0) return
    const timestamps = profile?.transcriptTimestamps ?? 'absent'
    for (const item of items) {
      if (item.dropped === true) {
        creditDrop(session, correlation, item, timestamps)
        continue
      }
      const queued = item.queued === true
      if (!queued && !correlation.accepts(item)) continue
      const after = [...session.echoWaiters].filter((waiter) =>
        host.now() < waiter.start.atMs + PROOF_WATCH_MS && echoIsAfterStart(item, waiter.start, timestamps) &&
        !waiter.beforeTypingIds.has(item.id || item.cursor || '') &&
        !waiter.seenPrompts.has(item.id),
      )
      if (after.length === 0) continue
      const typed = queued ? item.text : correlation.typedText(item)
      const linked = !queued && item.harnessRef?.length
        ? after.filter((waiter) => waiter.hookRefs?.some((hook) =>
          item.harnessRef!.some((ref) => ref.kind === hook.kind && ref.id === hook.id)))
        : []
      // This entry spends every unwrapped watch's first-entry order, including
      // when its native id supplies the proof for a different watch.
      const ordered = creditOne(session, correlation, typed, after, queued)
      const credited = linked.length === 1 ? linked[0] : ordered
      if (queued) {
        if (credited) credited.hold()
        continue
      }
      if (credited) {
        confirmRecorded(session, credited, item)
      }
      // Every other watch this prompt came after has been passed by it
      // (POD-4840). Under the same floor as the credit: an older record a
      // re-read carries passes nothing. Entries provably belonging to another
      // Podium send are not evidence the history moved past this watch
      // (POD-5436): a Podium frame id for a different message, or an entry
      // credited to another open watch. Every entry is still recorded in
      // seenPrompts, so a re-read dedupes instead of spending order again;
      // only unexplained entries count toward the limit. The 30-minute bound
      // still applies.
      const itemFrameId = podiumFrameId(typed)
      for (const waiter of after) {
        waiter.seenPrompts.set(item.id, item)
        if (waiter === credited) continue
        if (itemFrameId !== null && itemFrameId !== waiter.frameId) continue
        if (credited !== undefined) continue
        waiter.unexplainedSeen += 1
        if (waiter.unexplainedSeen >= LATER_PROMPT_LIMIT) {
          waiter.pass()
          waiter.cancel()
          if (waiter.turnId) removeProofWatch(session, waiter.turnId)
        }
      }
    }
  }

  function confirmRecorded(session: DriverSession, waiter: AcceptWaiter, item: TranscriptItem): void {
    waiter.cancel()
    const transcriptItem = transcriptItemRefOf(item)
    waiter.resolve({ ...(transcriptItem ? { transcriptItem } : {}),
      ...(item.harnessRef?.length ? { harnessRef: item.harnessRef } : {}) })
    if (waiter.turnId) removeProofWatch(session, waiter.turnId)
  }

  /**
   * THE PROGRAM RECORDED THAT IT DROPPED A PROMPT (POD-4887; spec §6.1 N2b):
   * Claude's `dropped_by_hook` queue record, or its "blocked by hook" record
   * for an idle prompt. It proves the prompt is not in the conversation, so
   * it is bound as strictly as a record: a wrapped message by its frame id; a
   * queued one to the one send its `enqueue` held with the same words; an
   * idle one by order plus text, like the prompt entry it stands in for.
   * Anything less binds nothing, and that send may still end `unknown`.
   */
  function creditDrop(
    session: DriverSession,
    correlation: TerminalEchoCorrelation,
    item: TranscriptItem,
    timestamps: TranscriptTimestampFidelity,
  ): void {
    const after = [...session.echoWaiters].filter((waiter) =>
      host.now() < waiter.start.atMs + PROOF_WATCH_MS && echoIsAfterStart(item, waiter.start, timestamps) &&
      !waiter.beforeTypingIds.has(item.id || item.cursor || ''),
    )
    if (after.length === 0) return
    const frameId = podiumFrameId(item.text)
    const matches = correlation.textMatches
    const heldTwins = frameId || !matches
      ? []
      : after.filter((waiter) => waiter.held && !waiter.frameId && matches(waiter.text, item.text))
    const dropped = frameId
      ? after.find((waiter) => waiter.frameId === frameId)
      : heldTwins.length > 0
        ? heldTwins.length === 1
          ? heldTwins[0]
          : undefined
        : creditOne(session, correlation, item.text, after, false)
    if (heldTwins.length > 1) {
      log.warn('drop not attributed: more than one held send has the same text', {
        sessionId: session.sessionId,
      })
    }
    if (!dropped) return
    dropped.cancel()
    dropped.disprove({ proof: 'dropped-by-agent', reason: 'the agent program dropped it (a hook blocked it)' })
    if (dropped.turnId) removeProofWatch(session, dropped.turnId)
  }

  /**
   * THE PROGRAM EXITED (POD-4887; spec §6.1 N4). Where nothing it holds
   * survives its exit (`exitLosesUnrecorded`, run per program), a send its
   * history lacks is not in its conversation. The history is read to the end
   * AFTER the exit, from the store, not the live tail (stopped at the exit,
   * possibly short of the last records): a record found there proves the send
   * as ever; a send it lacks is disproved — but only when the read reaches
   * back past that send's start, so nothing unread can hold its record. A
   * read that fails proves nothing.
   */
  async function settleExited(session: DriverSession): Promise<void> {
    const profile = profiles.get(session.sessionId)
    if (!profile?.exitLosesUnrecorded || session.echoWaiters.size === 0) return
    const registration = registrations.get(session.sessionId)
    if (!registration) return
    const open = [...session.echoWaiters]
    let page: RuntimeHistoryPage
    try {
      page = await host.readHistory(
        {
          sessionId: session.sessionId,
          agentKind: session.agentKind,
          cwd: registration.cwd,
          ...(session.resume ? { resume: session.resume } : {}),
        },
        { limit: EXIT_HISTORY_READ_LIMIT },
      )
    } catch (error) {
      log.warn('the history read after an exit failed: no send is disproved', {
        sessionId: session.sessionId,
        err: error,
      })
      return
    }
    const readable = page.items.filter((item) => !isProofOnlyItem(item))
    creditEchoWaiters(session, readable)
    const timestamps = profile.transcriptTimestamps
    const oldest = readable[0]
    for (const waiter of open) {
      if (!session.echoWaiters.has(waiter)) continue
      const reachesStart =
        !page.hasMore || (oldest !== undefined && !echoIsAfterStart(oldest, waiter.start, timestamps))
      if (!reachesStart) continue
      waiter.cancel()
      waiter.disprove({
        proof: 'agent-exited',
        reason: 'the agent program exited without recording it',
      })
      if (waiter.turnId) removeProofWatch(session, waiter.turnId)
    }
  }

  /** The one waiter `typed` (a prompt entry, or a queue record) is, or none. */
  function creditOne(
    session: DriverSession,
    correlation: TerminalEchoCorrelation,
    typed: string,
    after: readonly AcceptWaiter[],
    queued: boolean,
  ): AcceptWaiter | undefined {
    const frameId = podiumFrameId(typed)
    // A framed entry (or queue record) is provably another Podium send's, even
    // when no open watch carries its id: it must not spend an unwrapped
    // watch's order. Foreign/unknown entries still spend below.
    if (frameId)
      return after.find((waiter) => waiter.frameId === frameId && !(queued && waiter.held))
    const matches = correlation.textMatches
    if (!matches) return undefined
    const sessionId = session.sessionId
    const unchanged = (waiter: AcceptWaiter): boolean => {
      const mark = waiter.typingMark()
      const writes = host.foreignWrites
      return (
        mark !== undefined &&
        writes !== undefined &&
        writes.orderTrustworthy(sessionId) &&
        writes.count(sessionId) === mark
      )
    }
    // Order is decided on the first entry (or queue record) after the start
    // that is not provably another send's. An entry uniquely credited to
    // another open watch leaves every other unwrapped watch unspent.
    const deciding = after.filter(
      (waiter) => !waiter.frameId && !(queued ? waiter.queueSpent : waiter.orderSpent),
    )
    const spend = (): void => {
      for (const waiter of deciding) {
        if (queued) waiter.queueSpent = true
        else waiter.orderSpent = true
      }
    }
    const [candidate] = deciding.filter((waiter) => matches(waiter.text, typed))
    if (!candidate) {
      spend()
      // THE SELF-CHECK (spec §6.3): nothing else was written, yet the entry
      // is not the words typed — a prompt entry the counter did not explain.
      if (!queued && deciding.some(unchanged)) {
        log.warn('order gap: a prompt entry the foreign-write counter did not explain', {
          sessionId,
          sends: deciding.length,
        })
      }
      return undefined
    }
    if (queued && candidate.held) {
      spend()
      return undefined
    }
    // NEVER GUESS: another open send with the same words could be this entry.
    const twin = [...session.echoWaiters].some(
      (waiter) => waiter !== candidate && !waiter.frameId && matches(waiter.text, typed),
    )
    if (twin) {
      spend()
      log.warn('order credit withheld', {
        sessionId,
        reason: 'another open send has the same text',
        queued,
      })
      return undefined
    }
    if (!unchanged(candidate)) log.debug('order credit with foreign-write diagnostics', {
      sessionId, typingMark: candidate.typingMark(), count: host.foreignWrites?.count(sessionId),
      orderTrustworthy: host.foreignWrites?.orderTrustworthy(sessionId),
    })
    return candidate
  }

  function removeProofWatch(session: DriverSession, turnId: string): void {
    void host.proofWatches?.remove(session.sessionId, turnId).catch((err) =>
      log.warn('receipt watch removal failed', { sessionId: session.sessionId, turnId, err }))
  }

  const acceptFor = (session: DriverSession, waiters: DriverSession['hookWaiters'], atMs?: number): AcceptPort => ({
    watch(text: string, turnId?: string) {
      let settle: ((seen: AcceptSeen) => void) | undefined
      const accepted = new Promise<AcceptSeen>((resolve) => {
        settle = resolve
      })
      let pass: (() => void) | undefined
      const passed = new Promise<void>((resolve) => {
        pass = resolve
      })
      let markHeld: (() => void) | undefined
      const held = new Promise<void>((resolve) => {
        markHeld = resolve
      })
      let markDisproved: ((disproof: Disproof) => void) | undefined
      const disproved = new Promise<Disproof>((resolve) => {
        markDisproved = resolve
      })
      // Read before the first byte: `typingStarts` marks the same count.
      // The counter remains diagnostic even when the host has no writer lease.
      const armedAt = host.foreignWrites?.count(session.sessionId)
      let deadline: TimerHandle | undefined
      const waiter: AcceptWaiter = {
        text,
        resolve: (seen) => settle?.(seen),
        // Recovery starts at a saved time, not the observer's current tail.
        start: { atMs: atMs ?? host.now(), position: atMs === undefined
          ? session.transcriptPosition : { kind: 'unknown' } },
        pass: () => pass?.(),
        hold: () => {
          waiter.held = true
          markHeld?.()
        },
        disprove: (disproof) => markDisproved?.(disproof),
        frameId: podiumFrameId(text),
        typingMark: () =>
          turnId === undefined
            ? armedAt
            : host.foreignWrites?.typingMark(session.sessionId, turnId),
        orderSpent: false,
        queueSpent: false,
        held: false,
        turnId,
        beforeTypingIds: atMs === undefined && waiters === session.echoWaiters
          ? new Set(session.transcriptIds) : new Set(),
        seenPrompts: new Map(),
        unexplainedSeen: 0,
        cancel: () => {
          waiters.delete(waiter)
          if (deadline !== undefined) host.clearTimer(deadline)
        },
      }
      waiters.add(waiter)
      return {
        typingStartedAtMs: waiter.start.atMs,
        accepted,
        passed,
        held,
        disproved,
        cancel: () => waiter.cancel(),
        submitted() { waiter.submittedAtMs = host.now() },
        ...(waiters === session.echoWaiters && turnId !== undefined && host.proofWatches && atMs === undefined ? {
          async typingStarts() {
            await host.proofWatches!.save(session.sessionId, {
              turnId, text, typingStartedAt: new Date(waiter.start.atMs).toISOString(),
            })
            if (!session.disposed) deadline = host.setTimer(() => {
              waiter.pass()
              waiter.cancel()
              removeProofWatch(session, turnId)
            }, Math.max(0, waiter.start.atMs + PROOF_WATCH_MS - host.now()))
          },
        } : {}),
      }
    },
  })

  async function restoreProofWatches(session: DriverSession): Promise<void> {
    if (!host.proofWatches) return
    session.restoringProofItems = []
    try {
      const saved = await host.proofWatches.load(session.sessionId)
      if (session.disposed) return
      const open = saved.filter((watch) => {
        const atMs = Date.parse(watch.typingStartedAt)
        if (!Number.isFinite(atMs) || host.now() >= atMs + PROOF_WATCH_MS) {
          removeProofWatch(session, watch.turnId)
          return false
        }
        return true
      })
      if (open.length === 0) return
      const floor = Math.min(...open.map((watch) => Date.parse(watch.typingStartedAt)))
      const timestamps = profiles.get(session.sessionId)?.transcriptTimestamps ?? 'absent'
      // Rebuild order from the saved TIME. A tail page alone cannot establish
      // which prompt was first, or whether four later prompts already passed.
      const items: TranscriptItem[] = []
      let from: RuntimeHistoryPage['head']
      const heads = new Set<string>()
      for (;;) {
        const page = await host.readHistory({ sessionId: session.sessionId, agentKind: session.agentKind,
          cwd: session.cwd, ...(session.resume ? { resume: session.resume } : {}) },
          { limit: EXIT_HISTORY_READ_LIMIT, ...(from ? { from } : {}) })
        if (session.disposed) return
        items.unshift(...page.items)
        const oldestTime = page.items[0]?.ts ? Date.parse(page.items[0]!.ts!) : Number.NaN
        if (!page.hasMore || (timestamps !== 'absent' && Number.isFinite(oldestTime) &&
          oldestTime < Math.floor(floor / timestamps.resolutionMs) * timestamps.resolutionMs)) break
        const key = JSON.stringify(page.head)
        if (!page.head || heads.has(key)) throw new Error('history read did not reach receipt time floor')
        heads.add(key)
        from = page.head
      }
      for (const watch of open) {
        const atMs = Date.parse(watch.typingStartedAt)
        if (host.now() >= atMs + PROOF_WATCH_MS) {
          removeProofWatch(session, watch.turnId)
          continue
        }
        if ([...session.echoWaiters].some((waiter) => waiter.turnId === watch.turnId)) continue
        const echo = acceptFor(session, session.echoWaiters, atMs).watch(watch.text, watch.turnId)
        const waiter = [...session.echoWaiters].find((waiter) => waiter.turnId === watch.turnId)!
        const timer = host.setTimer(() => {
          echo.cancel()
          removeProofWatch(session, watch.turnId)
        }, Math.max(0, atMs + PROOF_WATCH_MS - host.now()))
        const close = () => { host.clearTimer(timer); echo.cancel() }
        const cancel = waiter.cancel
        waiter.cancel = () => { host.clearTimer(timer); cancel() }
        void echo.accepted.then((seen) => {
          close()
          if (session.disposed) return
          emit(session, { t: 'delivery', rowId: watch.turnId, outcome: 'delivered', ...seen },
            new Date(host.now()).toISOString(), 'live')
        })
        void echo.passed?.then(close)
        void echo.disproved?.then(({ proof, reason }) => {
          close()
          if (session.disposed) return
          emit(session, { t: 'delivery', rowId: watch.turnId, outcome: 'failed', cause: proof, reason },
            new Date(host.now()).toISOString(), 'live')
        })
      }
      creditEchoWaiters(session, [...items, ...(session.restoringProofItems ?? [])])
    } catch (err) {
      log.warn('receipt watches could not be restored', { sessionId: session.sessionId, err })
    } finally {
      session.restoringProofItems = undefined
    }
  }

  // -- session records ------------------------------------------------------

  /**
   * THE HANDED TERMINAL, when it is still attached. The session entry is the
   * handoff point: `register`/`recoverWithId` capture the terminal the host
   * hands at bind and `setTerminal` refreshes it on reattach (and on
   * steal/park). A parked — or never-handed — terminal reads as detached, so
   * the write paths refuse `not_running` until the host pushes a fresh one.
   */
  function terminalFor(session: DriverSession): TerminalTransport | undefined {
    return session.terminal?.live ? session.terminal : undefined
  }

  function injectionFor(session: DriverSession): TerminalInjectionMachine {
    const profile = profiles.get(session.sessionId)
    return createTerminalInjection(
      {
        // A turn's own typing is tagged so the host's foreign-write counter
        // lets it through; every other write here (the interrupt key) is
        // counted (POD-4888, spec §5.3).
        write: (text, role) => {
          terminalFor(session)?.writeBase64(Buffer.from(text, 'utf8').toString('base64'), role)
        },
        typingStarts: (turnId) => host.foreignWrites?.markTyping(session.sessionId, turnId),
        running: () => session.alive && terminalFor(session) !== undefined,
        live: () => session.live && session.alive && terminalFor(session) !== undefined,
        phase: () => host.trackedState(session.sessionId)?.phase,
        ...(host.readInput ? { readInput: () => host.readInput!(session.sessionId) } : {}),
        foreignWriteCount: () => host.foreignWrites?.orderTrustworthy(session.sessionId)
          ? host.foreignWrites.count(session.sessionId) : undefined,
        lastOutputAtMs: () => session.lastOutputAtMs,
        now: host.now,
        setTimer: host.setTimer,
        clearTimer: host.clearTimer,
        ...(profile?.acceptCorrelation?.hook ? { hookAccept: acceptFor(session, session.hookWaiters) } : {}),
        ...(profile?.acceptCorrelation?.['transcript-echo']
          ? { echoAccept: acceptFor(session, session.echoWaiters) }
          : {}),
        // READS THE SAME RESET-AWARE COUNT as the echo baseline, and for the same
        // reason: `isRawFirstTurn` in `inbox.ts` asks whether the harness's own
        // transcript has ANY user turn, so an adopted session whose driver-local
        // history happened to be empty must not be told to type raw keystrokes
        // into a grok that is long past its first turn.
        rawFirstTurn: () => (profile?.usesRawFirstTurn ?? false) && session.userTurns === 0,
        needsSubmitVerification: () => profile?.needsSubmitVerification ?? false,
        observedTurnEpoch: () => session.turnEpoch,
        /**
         * THE ABANDONED-QUEUE REPORT (POD-2107, POD-2202), and it is
         * UNCONDITIONAL.
         *
         * A drain that gave up because the session never went live and a teardown
         * that discards its queue used to make no sound: the caller held a
         * `queued` receipt and nothing anywhere said the words were never typed.
         * One line naming the session, reason and turns is the least this can cost,
         * and it is the difference between a bug someone can find and a session
         * that quietly answers nothing.
         *
         * NOT EMITTED AS A `turn` EVENT, deliberately. A turn event on this stream
         * is a PROVIDER-CONFIRMED FENCE — the corpus pins that the driver emits
         * none of its own, because a consumer told a turn failed believes a turn
         * ran. These turns never started. Correcting the SENDER's receipt is a
         * server-side surface (the durable FIFO is the server's), reached through
         * `host.onDrainAbandoned` and its dedicated daemon frame.
         */
        onDrainAbandoned: (turns, reason) => {
          log.warn('queued turns were never delivered', {
            sessionId: session.sessionId,
            reason,
            turns: turns.length,
            turnIds: turns.map((turn) => turn.id),
          })
          host.onDrainAbandoned?.({ sessionId: session.sessionId, turns, reason })
        },
        ...(host.authorizeAtDrain
          ? {
              authorizeAtDrain: (turn: QueuedTurn) =>
                host.authorizeAtDrain?.({ sessionId: session.sessionId, turn }) ?? { ok: true },
              onDrainRejected: (turn: QueuedTurn, reason: string) =>
                host.onDrainRejected?.({ sessionId: session.sessionId, turn, reason }),
            }
          : {}),
      },
      // THE MANIFEST'S interrupt key and idle guard (POD-3981). The profile
      // carries what the harness manifest declares, read once in
      // `terminalProfileFor`; the injection machine writes exactly these
      // bytes and withholds them while idle when the guard says so — the
      // contract half of the legacy `abortKeyFor` answer. Undefined when
      // the session registered with no profile, and the machine’s own
      // esc-without-a-guard default — today’s whole fleet — covers that.
      profile
        ? { bytes: profile.interruptBytes, quitsWhenIdle: profile.interruptQuitsWhenIdle }
        : undefined,
    )
  }

  function openSession(
    registration: TerminalSessionRegistration,
    profile: TerminalHarnessProfile,
  ): DriverSession {
    const existing = sessions.get(registration.sessionId)
    if (existing) {
      closeOpenInteractions(existing, new Date(host.now()).toISOString(), 'live', null)
      // A reattach hands a fresh terminal; the handed one is refreshed here so
      // no per-write lookup remains.
      existing.terminal = registration.terminal
      // A REBIND, not a second record. The observer generation and binding
      // version go UP and the conversation position does not move — which is
      // exactly the invariant the corpus pins across a supervisor restart.
      existing.observerGeneration = Math.max(
        registration.observerGeneration === undefined
          ? existing.observerGeneration + 1
          : existing.observerGeneration,
        registration.observerGeneration ?? 0,
      )
      existing.bindingVersion = Math.max(
        registration.bindingVersion === undefined
          ? existing.bindingVersion + 1
          : existing.bindingVersion,
        registration.bindingVersion ?? 0,
      )
      if (!existing.alive) {
        existing.live = false
        existing.liveAtMs = undefined
      }
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
    // where it left off. A process THIS daemon has never seen — its own process
    // restarted and is adopting a surviving session — must not start at zero:
    // `seq` is a component of a cursor the consumer compares as a MONOTONIC
    // VECTOR, and a regressed component reads every event after the restart as
    // `same_or_before` the last one the consumer accepted. Those events are
    // dropped as duplicates until the counter climbs past its old value, and
    // the turn-start dropped in that window fenced the whole stream for good
    // (POD-4360: delivery outcomes never arrived, queued rows were re-typed on
    // every server restart). The floor is the clock in milliseconds: strictly
    // above any sequence a previous process could have reached, since no
    // process emits a thousand events per second for its whole life, and
    // ordinal beyond that — it never participates in succession as a time.
    const carried = streamPositions.get(registration.sessionId)
    const seqFloor = host.now()
    const session: DriverSession = {
      sessionId: registration.sessionId,
      agentKind: registration.agentKind,
      driverId: profile.driverId,
      cwd: registration.cwd,
      terminal: registration.terminal,
      resume: registration.resume,
      resumeConfidence: registration.resume ? 'exact' : undefined,
      bindingVersion: registration.bindingVersion ?? 1,
      observerGeneration: registration.observerGeneration ?? 1,
      turnEpoch: carried?.turnEpoch ?? 0,
      fencedTurnEpoch: carried?.fencedTurnEpoch ?? 0,
      epochOpen: false,
      providerCursor: null,
      publishedCursor: null,
      seq: carried?.seq ?? seqFloor,
      log: [],
      wakers: new Set(),
      interactions: new Map(),
      interactionOwners: new Map(),
      answered: new Set(),
      lease: null,
      draft: undefined,
      contextUsedPercent: undefined,
      metadata: new Map(),
      observedStatePhase: undefined,
      transcriptVersions: new Map(),
      transcriptIds: new Set(),
      injection: undefined as unknown as TerminalInjectionMachine,
      hookWaiters: new Set(),
      echoWaiters: new Set(),
      // A FRESH LAUNCH STARTS ON AN EMPTY STORE. Nothing is in its transcript
      // yet, so whatever it records later came after any send made now — which
      // matters where the file does not exist until the first prompt (Cursor)
      // and no delta can say so. A resume or an adopt has history the driver
      // has not seen; it starts `unknown` until a delta places it.
      transcriptPosition:
        registration.resume || registration.rebind ? { kind: 'unknown' } : { kind: 'empty' },
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
    void restoreProofWatches(session)
    // A REBIND INTO A PROCESS THAT HAS NEVER SEEN THIS SESSION is the daemon
    // itself having restarted (the in-process rebind above is the other case).
    // Say so on the stream, as that branch does: `process/adopted` is what lets
    // the consumer re-seed its position for a new observer process instead of
    // fencing every later event as an epoch jump (POD-4360). The boot-time
    // terminal adoption reaches `register()` directly, never `adopt()` below,
    // so this is the only place the announcement can come from.
    if (registration.rebind) {
      emit(
        session,
        { t: 'process', ev: { ev: 'adopted', bindingVersion: session.bindingVersion } },
        new Date(host.now()).toISOString(),
        'live',
      )
    }
    return session
  }

  // -- the handle -----------------------------------------------------------

  function makeHandle(session: DriverSession): AgentSessionHandle {
    const profile = profiles.get(session.sessionId)
    const refuse = (reason: Refusal['reason'], detail?: string): Refusal =>
      detail === undefined ? { reason } : { reason, detail }
    /** What a send hears after its receipt: a held send's record or its end
     *  (POD-4905, POD-4849), an `unverified` send's late proof (POD-4840). */
    const followUps = (options: SendOptions) => ({
      ...(options.onTypingStarted ? { onTypingStarted: options.onTypingStarted } : {}),
      ...(options.onTranscriptItem ? { onTranscriptItem: options.onTranscriptItem } : {}),
      ...(options.onUnrecorded ? { onUnrecorded: options.onUnrecorded } : {}),
      ...(options.onLateProof ? { onLateProof: options.onLateProof } : {}),
    })
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
        // SESSION-SCOPED, and opaque to the contract: the driver never resolves
        // labels, scope units or pids itself — the daemon resolves the entry's
        // durable label per session, and identity beyond this key lives in
        // host.recover's fence.
        key: session.sessionId,
      },
      bindingVersion: session.bindingVersion,
    })

    const deliveryReady = (): boolean => {
      const liveAt = session.liveAtMs
      if (!session.live || !session.alive || liveAt === undefined) return false
      const now = host.now()
      return (
        now - liveAt >= 6000 ||
        (session.lastOutputAtMs > liveAt &&
          now - liveAt >= 800 &&
          now - session.lastOutputAtMs >= 600)
      )
    }
    const handle: AgentSessionHandle = {
      get binding() {
        return binding()
      },

      // ---- lifecycle ----
      async stop() {
        session.answerScript?.cancel('the process ended')
        session.alive = false
        session.terminatedByDriver = true
        // The PROCESS is gone, so its stream position goes with it: a later
        // process under the same session is a different conversation, and carrying
        // a position across would fence its first events out as already-seen.
        streamPositions.delete(session.sessionId)
        if (!await host.stopSession({ sessionId: session.sessionId }))
          throw new Error('terminal process retirement was not confirmed')
      },

      async hibernate() {
        // REFUSES WITHOUT A RESUME REF. The daemon reaps the durable host on
        // hibernate, so a session with nothing to resume from would simply be
        // gone — data loss wearing a lifecycle verb's name.
        if (!session.resume) return refuse('no_resume_ref')
        session.answerScript?.cancel('the process ended')
        session.alive = false
        session.terminatedByDriver = true
        if (!await host.stopSession({ sessionId: session.sessionId }))
          throw new Error('terminal process retirement was not confirmed')
        return { ok: true as const }
      },

      async kill() {
        session.answerScript?.cancel('the process ended')
        session.alive = false
        session.terminatedByDriver = true
        streamPositions.delete(session.sessionId)
        if (!await host.stopSession({ sessionId: session.sessionId }))
          throw new Error('terminal process retirement was not confirmed')
      },

      async health(): Promise<SessionHealth> {
        return sessionHealth({
          alive: session.alive && terminalFor(session) !== undefined,
          // Resource truth is the host's per-session answer (POD-2413): the
          // daemon resolves the entry's label, scope unit and pid itself.
          resources: host.resources(session.sessionId),
        })
      },

      // ---- identity ----
      async snapshot(): Promise<SessionSnapshot> {
        return {
          binding: binding(),
          state: session.state ??
            host.trackedState(session.sessionId) ?? {
              phase: 'unknown',
              since: new Date(host.now()).toISOString(),
              nativeSubagentCount: 0,
            },
          cursor: cursorFor(session, session.seq),
          observerGeneration: session.observerGeneration,
          turnEpoch: session.turnEpoch,
          interactions: [...session.interactions.values()],
          metadata: [...session.metadata.values()],
          ...(session.draft !== undefined ? { draft: session.draft } : {}),
          at: new Date(host.now()).toISOString(),
        }
      },

      async export(): Promise<SessionArchive> {
        /**
         * THE DECLARATION IS CHECKED FIRST (POD-2703, review 1), and the order
         * is the answer rather than a formality. "This harness declares no
         * handoff transcript" is PERMANENT and "the store is not written yet" is
         * NOT YET; a caller retries one and never the other. Reporting
         * `no_resume_ref` for a harness that will never have an archive sends an
         * archive scheduler round a loop it cannot leave.
         */
        if (!profile?.archivable) {
          throw new DriverRefusalError(
            {
              reason: 'unsupported',
              detail: `${session.agentKind} declares no handoff transcript locator`,
            },
            'terminal driver export',
          )
        }
        if (!session.resume) {
          // TYPED, not a bare throw: `export()` has no refusal arm in its return
          // type, so `DriverRefusalError` IS the refusal channel here. An
          // archive scheduler must be able to tell "not yet — this harness
          // writes its store at the first turn" from "the driver broke", and a
          // message string is not something a caller may branch on.
          throw new DriverRefusalError({ reason: 'no_resume_ref' }, 'terminal driver export')
        }
        const located = await host.archiveTranscript({
          agentKind: session.agentKind,
          cwd: session.cwd,
          resumeValue: session.resume.value,
        })
        const bytes = await host.readArchiveBytes(located.path)
        const name = machinePathBasename(located.path) ?? `${session.sessionId}.jsonl`
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

      ...(primeSource && profiles.get(session.sessionId)?.instrumentationRequired ? {
        boundaryContext: (request: BoundaryContextRequest) => {
          if (session.disposed || sessions.get(session.sessionId) !== session) return Promise.resolve(null)
          return boundaryContextFor(session.sessionId)?.(request) ?? Promise.resolve(null)
        },
      } : {}),
      // ---- turns ----
      async send(input: TurnInput, options: SendOptions): Promise<TurnReceipt> {
        if (options.delivery === 'at-boundary') {
          return {
            outcome: 'refused',
            refusal: {
              reason: 'unsupported',
              detail: 'boundary delivery is not implemented by this driver',
            },
          }
        }
        if (!session.alive || !terminalFor(session)) {
          return { outcome: 'refused', refusal: refuse('not_running') }
        }
        if (profile?.usesRawFirstTurn && input.attachments?.length) {
          return {
            outcome: 'refused',
            refusal: refuse('unsupported', RAW_FIRST_TURN_ATTACHMENT_REFUSAL),
          }
        }
        const text = [...(input.attachments ?? []).map((attachment) => attachment.path), input.text]
          .filter(Boolean)
          .join('\n')
        const enqueue = (): TurnReceipt =>
          session.injection.enqueue(text, {
            origin: options.origin,
            id: input.id ?? randomUUID(),
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
        //
        // AND THE LEASE IS HELD BY SOMEBODY, NOT BY A CATEGORY (POD-1761 W4,
        // closing W3's review precondition 1). Keying only on `origin !== 'human'`
        // serializes the steward behind a takeover but lets a SECOND PERSON type
        // straight into it — two humans interleaving mid-turn is the exact race
        // the one-lease rule exists to prevent, and it was reachable because
        // `SendOptions` carried no holder identity to compare.
        //
        // The identity it compares is the acting principal's `ref`, folded in
        // rather than added beside it: the contract already carries "who is
        // acting" through queueing for authorization, and a second holder field
        // would be a second answer to the same question — two ids that can
        // disagree about who is typing. A send with no principal cannot prove it
        // is the holder, so it queues; that is the safe direction, because
        // queueing costs an ordering delay and interleaving costs a corrupted
        // turn.
        const leaseBlocks =
          session.lease?.kind === 'human-controller' &&
          (options.origin !== 'human' || options.principal?.ref !== session.lease.holder)
        if (leaseBlocks) {
          if (options.deliveryAttempt) return { outcome: 'refused', refusal: refuse('lease_held') }
          return enqueue()
        }

        // DEGRADATION IS REPORTED, NEVER SILENT. A TUI cannot append into an open
        // turn, so `steer` becomes `queue` and `deliveredAs` says so.
        const requested: TurnDelivery = options.delivery
        if (requested === 'steer' || requested === 'queue') return enqueue()
        // SEND OUTCOME DECISION (POD-4387): `when-ready` on an idle session is
        // `accepted`, never `queued`. POD-4291's durable-custody change gated
        // direct sends on `deliveryReady()` (live + 6s settle/quiet) and routed
        // fresh idle sessions through the inner queue, so every conformance
        // profile reported `queued` where the contract requires `accepted` — and
        // the gate ran before the `needs_user` refusal, turning a blocking ask
        // into a parked turn. The settle wait belongs to the QUEUE DRAIN (and to
        // the outer durable `withDeliveryQueue` via `deliveryReady` as its
        // `ready`), not to the direct path: typing immediately is what the
        // verification ladder proves, and `queued` is reserved for explicit
        // `queue`/`steer`/lease requests. Custody (delivery_owner, recovery,
        // durable/initialPrompt windows) is untouched.
        //
        // BUSY IS NOT IDLE (POD-4700). The paragraph above is about a session
        // with nothing running; a session with a turn running takes the
        // opposite answer. Typing a `when-ready` into a running TUI cuts the
        // turn off — OpenCode answers the second prompt and the first row is
        // later reported lost as "target gone" (POD-4604 run 13) — so a send
        // that finds the agent computing never types mid-turn.
        //
        // The answer is `busy`, whoever asked. The server's sends are all
        // durable rows (POD-4795): the delivery queue that retries this
        // attempt waits for the turn end itself, and holds the row under its
        // id across that wait. `interrupt` is exempt (cutting in is its job)
        // and `needs_user` is still refused inside `deliver`.
        //
        // THE TRACKER CAN LIE (POD-4871). The daemon's tracker folds
        // hook-translate activity with no epoch fence, so a late Grok hook
        // (PostToolUse, SubagentStop, …) flips it back to working after the
        // turn closed, with no turn to end it — while this driver suppresses
        // the same working observations in its fenced epoch (POD-4804) and
        // reads idle. A refusal reading the tracker alone then holds every
        // follow-up behind a turn that does not exist (2d8bcbc6: queued,
        // never typed; the rebased smoke: none of three ran). For causal
        // lifecycles this driver's own epoch is the turn truth — folded from
        // the same observations, plus the absorbing fence — so the refusal
        // additionally requires an open turn here: tracker-busy with no open
        // turn is a stale reading and the send proceeds. Poll-lifecycle
        // harnesses keep the tracker-only answer: their epochs never pass
        // through this machine's observation fold (the opencode busy test
        // pins it).
        if (
          requested === 'when-ready' &&
          ['working', 'compacting'].includes(host.trackedState(session.sessionId)?.phase ?? '') &&
          (profile?.lifecycleFromState === true || session.epochOpen)
        ) {
          return { outcome: 'refused', refusal: refuse('busy') }
        }

        if (requested === 'interrupt') {
          // The manifest key first, then the replacement prompt one CR-delay
          // later — the exact shape of `interruptText`, whose gap is what lets
          // the CLI dismiss its prompt before the paste lands.
          session.injection.interrupt()
          host.onInterruptRequested?.(session.sessionId)
          await new Promise<void>((resolve) => {
            host.setTimer(resolve, SUBMIT_CR_DELAY_MS)
          })
          return session.injection.deliver(text, {
            origin: options.origin,
            delivery: 'interrupt',
            afterEsc: true,
            ...(input.id !== undefined ? { turnId: input.id } : {}),
            ...followUps(options),
          })
        }

        return session.injection.deliver(text, {
          origin: options.origin,
          delivery: 'when-ready',
          signal: options.signal,
          ...(input.id !== undefined ? { turnId: input.id } : {}),
          initialPrompt: input.initialPrompt,
          ...followUps(options),
        })
      },

      async stageAttachment(source) {
        if (!session.alive || !terminalFor(session)) return refuse('not_running')
        if (profile?.usesRawFirstTurn) {
          return refuse('unsupported', RAW_FIRST_TURN_ATTACHMENT_REFUSAL)
        }
        try {
          return await host.stageAttachment({ sessionId: session.sessionId, source })
        } catch (err) {
          return refuse('staging_failed', String(err))
        }
      },

      async interrupt(): Promise<void> {
        // REQUESTS a fence and nothing more. The fence arrives — or does not — as
        // a provider-confirmed `turn_terminal` observation on the causal stream.
        // A driver that emitted its own here would let a consumer believe a turn
        // ended that the agent is still running.
        session.injection.interrupt()
        host.onInterruptRequested?.(session.sessionId)
      },

      async answer(interactionId, answer, answerOptions): Promise<InteractionAnswerOutcome> {
        // IDEMPOTENT: a second answer is a typed error, never a second script
        // typed into a menu that is no longer there.
        if (session.answered.has(interactionId)) return { ok: false, reason: 'already-answered' }
        const interaction = session.interactions.get(interactionId)
        if (!interaction) return { ok: false, reason: 'unknown-interaction' }
        const owner = session.interactionOwners.get(interactionId)
        if (session.disposed || !session.alive || !owner?.terminal ||
            terminalFor(session) !== owner.terminal ||
            owner.generation !== session.observerGeneration || owner.bindingVersion !== session.bindingVersion) {
          return { ok: false, reason: 'expired' }
        }
        const script = menuScriptFor(answer, interaction)
        // AN ANSWER THIS DRIVER CANNOT TYPE IS NOT AN ANSWER. Nothing is sent and
        // the ask stays open, because a partial script would leave the menu on a
        // row nobody chose and a closing keystroke would commit it (POD-770's
        // failure, in the one place it could recur). `not-yet-supported` is the
        // contract's deliberate refusal for exactly this — the server's table
        // keeps the ask open on it, so a human can answer what the driver could
        // not type.
        if (!script.ok) return { ok: false, reason: 'not-yet-supported', detail: script.detail }
        // ONE KEYSTROKE PER WRITE, spaced. The CLI's key parser folds a
        // multi-character chunk into a SINGLE key event whose name is the whole
        // string, so `"12"` arrives as the key "12", matches no digit, and the
        // menu does not move at all (POD-609). The gaps are the keystroke
        // path's own: 120ms between keys, 240ms before the closing commit.
        if (session.answerScript) return { ok: false, reason: 'already-answered' }
        const terminal = terminalFor(session)
        if (!terminal || session.disposed) return { ok: false, reason: 'expired' }
        const generation = session.observerGeneration
        const bindingVersion = session.bindingVersion
        const completed = await new Promise<InteractionAnswerOutcome>((resolve) => {
          const timers = new Set<TimerHandle>()
          let writes = 0
          let settled = false
          const finish = (outcome: InteractionAnswerOutcome): void => {
            if (settled) return
            settled = true
            for (const timer of timers) host.clearTimer(timer)
            if (session.answerScript === running) session.answerScript = undefined
            resolve(outcome)
          }
          const running = {
            cancel(detail: string): void {
              // A partial script must never be retried against this menu.
              if (writes > 0) {
                session.interactions.delete(interactionId)
                session.interactionOwners.delete(interactionId)
                session.answered.add(interactionId)
              }
              finish({ ok: false, reason: writes > 0 ? 'partial-delivery' : 'expired',
                detail: `${detail}; ${writes}/${script.script.keys.length} writes completed` })
            },
          }
          session.answerScript = running
          const send = (key: string, index: number): void => {
            if (settled) return
            if (session.disposed || !session.alive || sessions.get(session.sessionId) !== session ||
                terminalFor(session) !== terminal ||
                session.observerGeneration !== generation || session.bindingVersion !== bindingVersion ||
                session.interactions.get(interactionId) !== interaction || session.answerScript !== running) {
              running.cancel('answer ownership changed')
              return
            }
            // Count an attempted write conservatively: a throwing terminal may have written bytes.
            writes += 1
            try { terminal.writeBase64(Buffer.from(key, 'utf8').toString('base64')) }
            catch { running.cancel('terminal write failed'); return }
            if (index === script.script.keys.length - 1) finish({ ok: true })
          }
          for (const [index, key] of script.script.keys.entries()) {
            if (settled) break
            const delay = script.script.at[index] ?? 0
            if (delay <= 0) send(key, index)
            else timers.add(host.setTimer(() => send(key, index), delay))
          }
        })
        if (!completed.ok) return completed
        session.interactions.delete(interactionId)
        session.interactionOwners.delete(interactionId)
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
        return createRuntimeEventStream(after, {
          log: session.log,
          wakers: session.wakers,
          currentSeq: () => session.seq,
          isDisposed: () => session.disposed,
        })
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
          session.state ??
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
          return host.readHistory(
            {
              sessionId: session.sessionId,
              agentKind: session.agentKind,
              cwd: reg?.cwd ?? session.cwd,
              ...(session.resume ? { resume: session.resume } : {}),
            },
            range,
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
        async set(text) {
          if (session.disposed) return refuse('not_running')
          if (
            !host.draftSyncing(session.sessionId) ||
            !host.setDraftTarget(session.sessionId, text)
          ) {
            return refuse('unsupported', 'composer injection is unavailable for this session')
          }
          observeDraft(session.sessionId, text)
          return { ok: true as const }
        },
      },

      /**
       * REFUSES, and the capability says the same thing for the same reason —
       * see `drivers/terminal/capabilities.ts`. POD-3081 made model and effort
       * sticky on the three headless drivers by writing the session's policy and
       * letting the next request carry it; there is no next request here to
       * carry anything, only a CLI that read its model from argv. Typing
       * `/model` into the PTY would be a change this driver could not observe,
       * confirm, or report, which is the one thing a refusal is cheaper than.
       */
      async configure(_request: ConfigureRequest) {
        return refuse(
          'unsupported',
          'a TUI reads its model and effort from argv at launch; changing them is a relaunch',
        )
      },

      async usage() {
        if (session.contextUsedPercent === undefined) {
          return refuse('unsupported', 'this harness has reported no context usage')
        }
        return { contextUsedPercent: session.contextUsedPercent }
      },
    }

    return withDeliveryQueue(
      handle,
      (event) => emit(session, event, new Date(host.now()).toISOString(), 'live'),
      deliveryReady,
      () => !session.disposed,
      slots.deliveryJournal?.(session.sessionId),
    )
  }

  // -- registration + drivers ----------------------------------------------

  function register(
    registration: TerminalSessionRegistration,
    profile: TerminalHarnessProfile,
  ): AgentSessionHandle {
    registrations.set(registration.sessionId, registration)
    profiles.set(registration.sessionId, profile)
    const session = openSession(registration, profile)
    // Rebinding the same daemon-owned process must preserve queued custody and
    // completed outcome replay, including an acceptance still in flight. The
    // get-or-make runs against the ENTRY, so a rebind reuses the one handle
    // exactly as the deleted index did.
    const handle = slots.get(registration.sessionId) ?? makeHandle(session)
    slots.set(registration.sessionId, handle)
    replayHeldFrames(registration.sessionId)
    return handle
  }

  /**
   * Deliver whatever arrived while this session was being created or adopted.
   *
   * ORDER MATTERS TWICE. The entry is removed BEFORE the replay so a frame going
   * back through `observe()` cannot re-enter the buffer it just left; and the
   * frames go out in ARRIVAL order, through the same `observe()` that would have
   * taken them live, so a `bind` followed by an `agentExit` still means the
   * session came up and then died rather than the reverse.
   */
  function replayHeldFrames(sessionId: SessionId): void {
    const held = pendingFrames.get(sessionId)
    if (!held) return
    pendingFrames.delete(sessionId)
    for (const msg of held) observe(msg)
  }

  function clear(sessionId: SessionId): void {
    contexts.get(sessionId)?.reset()
    contexts.delete(sessionId)
    const session = sessions.get(sessionId)
    if (session) {
      session.answerScript?.cancel('the driver was disposed')
      session.disposed = true
      session.injection.dispose()
      for (const waiter of [...session.echoWaiters, ...session.hookWaiters]) waiter.cancel()
      // The PROCESS is gone — `clear` is called from the daemon's teardown path
      // and on exit — so its stream position goes with it. Retaining it would
      // leak one entry per session for the daemon's life AND would fence out the
      // first events of any later process that reused the label. Note the
      // asymmetry with `restartSupervisor`, which keeps positions on purpose:
      // there the process SURVIVES and only the handle is dropped.
      streamPositions.delete(session.sessionId)
      for (const wake of [...session.wakers]) wake()
    }
    sessions.delete(sessionId)
    // Forget the entry's handle WITHOUT destroying it: the daemon's teardown
    // holds its own reference for the §4.8 step 6 reap (POD-4512).
    forgetDriver(sessionId)
    profiles.delete(sessionId)
    registrations.delete(sessionId)
    // A session torn down mid-create has nothing left to replay INTO, and
    // holding its frames would deliver them to whatever registered next under
    // the same id.
    pendingFrames.delete(sessionId)
  }

  const control: TerminalRuntimeControl = {
    restartSupervisor() {
      // HANDLES DIE, PROCESSES DO NOT — a daemon restart, exactly. The records go
      // because a restarted daemon has none; the durable masters keep running,
      // which is what `adopt()` then has to find.
      for (const session of [...sessions.values()]) {
        session.answerScript?.cancel('the driver was disposed')
        session.disposed = true
        session.injection.dispose()
        for (const waiter of [...session.echoWaiters, ...session.hookWaiters]) waiter.cancel()
        for (const wake of [...session.wakers]) wake()
        forgetDriver(session.sessionId)
      }
      sessions.clear()
    },
    askInteraction(sessionId, interaction) {
      const session = sessions.get(sessionId)
      if (!session) return
      session.interactions.set(interaction.id, interaction)
      session.interactionOwners.set(interaction.id, { terminal: terminalFor(session),
        generation: session.observerGeneration, bindingVersion: session.bindingVersion })
      emit(
        session,
        { t: 'interaction', ev: { ev: 'asked', interaction } },
        interaction.askedAt,
        'live',
      )
    },
  }

  /**
   * ONE CREATION PATH (POD-5814), whoever minted the id: install the session's
   * hook wiring, have the host launch the harness from the spec, put the
   * session behind the contract under the lease the host reports, then let the
   * host announce it. The handle exists before the bind names it.
   */
  async function createWithId(
    sessionId: SessionId,
    spec: SessionSpec,
    profile: TerminalHarnessProfile,
    resume?: ResumeRef,
  ): Promise<AgentSessionHandle> {
    contexts.get(sessionId)?.reset()
    contexts.delete(sessionId)
    profiles.set(sessionId, profile)
    // Claim before installation/launch: initial frames can arrive during either await.
    try {
      return await claiming(sessionId, async () => {
        const instrumentation = await prepareTerminalInstrumentation(
          capabilitiesFor(profile),
          spec,
          () => host.installInstrumentation(sessionId, spec),
        )
        reportInstrumentationDegradation(host, spec.harness, instrumentation, (message) =>
          host.send(message as TerminalDriverReport),
        )
        const launched = await host.launch({
          sessionId,
          spec,
          instrumentation,
          ...(resume ? { resume } : {}),
        })
        const handle = register(
          {
            sessionId,
            agentKind: spec.harness as AgentKind,
            cwd: spec.workdir,
            resume: resume ?? null,
            ...(launched.observerGeneration !== undefined
              ? { observerGeneration: launched.observerGeneration }
              : {}),
            ...(launched.bindingVersion !== undefined
              ? { bindingVersion: launched.bindingVersion }
              : {}),
            ...(launched.terminal ? { terminal: launched.terminal } : {}),
          },
          profile,
        )
        launched.announce()
        return handle
      })
    } catch (error) {
      if (!slots.get(sessionId)) {
        contexts.get(sessionId)?.reset()
        contexts.delete(sessionId)
        profiles.delete(sessionId)
      }
      throw error
    }
  }

  const recoveries = new Map<SessionId, Promise<AgentSessionHandle>>()

  function recoverWithId(
    msg: TerminalReattachControl,
    profile: TerminalHarnessProfile,
    verifyDurable = false,
  ): Promise<AgentSessionHandle> {
    // Serialize one session's leases. The host's fan-out gate only bounds work
    // across sessions; it cannot fence a late, older recovery of the same id.
    const previous = recoveries.get(msg.sessionId)
    const recovery = (async () => {
      await previous?.catch(() => undefined)
      if (
        typeof msg.requestedDriverId === 'string' &&
        canonicalDriverId(msg.requestedDriverId) !== profile.driverId
      ) {
        throw new TerminalRecoveryRefusal(
          `runtime driver '${msg.requestedDriverId}' cannot recover as '${profile.driverId}'`,
        )
      }
      const current = sessions.get(msg.sessionId)
      if (
        current &&
        (current.agentKind !== msg.agentKind ||
          current.driverId !== profile.driverId ||
          (msg.observationGeneration !== undefined &&
            msg.observationGeneration < current.observerGeneration) ||
          (msg.observationBindingVersion !== undefined &&
            msg.observationBindingVersion < current.bindingVersion))
      )
        throw new TerminalRecoveryRefusal(
          'terminal recovery identity or observation fence is stale',
        )
      return claiming(msg.sessionId, async () => {
        if (verifyDurable && !(await host.processAlive(msg.sessionId))) {
          throw new Error(`terminal driver: no surviving process for ${msg.sessionId}`)
        }
        let handle: AgentSessionHandle | undefined
        await host.recover(msg, (terminal) => {
          handle = register(
            {
              sessionId: msg.sessionId,
              agentKind: msg.agentKind,
              cwd: msg.cwd,
              resume: msg.resume ?? null,
              terminal,
              ...(msg.observationGeneration !== undefined
                ? { observerGeneration: msg.observationGeneration }
                : {}),
              ...(msg.observationBindingVersion !== undefined
                ? { bindingVersion: msg.observationBindingVersion }
                : {}),
              rebind: true,
            },
            profile,
          )
          if (!current) {
            const session = sessions.get(msg.sessionId)!
            emit(
              session,
              { t: 'process', ev: { ev: 'adopted', bindingVersion: session.bindingVersion } },
              observedAt(),
              'live',
            )
          }
        })
        if (!handle) throw new Error('terminal recovery did not compose a live host')
        return handle
      })
    })()
    recoveries.set(msg.sessionId, recovery)
    void recovery
      .finally(() => {
        if (recoveries.get(msg.sessionId) === recovery) recoveries.delete(msg.sessionId)
      })
      .catch(() => undefined)
    return recovery
  }

  return {
    boundaryContextFor,
    createWithId,
    recoverWithId,
    register,
    handleFor: (sessionId) => slots.get(sessionId),
    bindings: () => slots.handles().map((handle) => handle.binding),
    has: (sessionId) => sessions.has(sessionId),
    setTerminal: (sessionId, terminal) => {
      const session = sessions.get(sessionId)
      if (session && !session.disposed) session.terminal = terminal
    },
    observe,
    observeState: (observation) => observe({ type: 'terminalState', ...observation }),
    observeDraft,
    onHookPayload,
    async respondToHook(sessionId, payload, signal) {
      const session = sessions.get(sessionId)
      if (!session) return null
      const response = await respondToMailBoundary(host.boundaryContext, sessionId, payload, signal)
      return sessions.get(sessionId) === session ? response : null
    },
    reportOomKill(sessionId, scopeUnit) {
      const session = sessions.get(sessionId)
      if (!session) return
      emit(
        session,
        { t: 'process', ev: { ev: 'oomKilled', ...(scopeUnit ? { scopeUnit } : {}) } },
        observedAt(),
        'live',
      )
    },
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
          return createWithId(asSessionId(randomUUID()), spec, profile)
        },

        async resume(ref: ResumeRef, spec: SessionSpec): Promise<AgentSessionHandle> {
          return createWithId(asSessionId(randomUUID()), spec, profile, ref)
        },

        async adopt(bound: RuntimeSessionBinding): Promise<AgentSessionHandle> {
          // Process identity beyond family/driver/harness lives in
          // host.recover's fence: the daemon resolves the entry's durable
          // label per session, so the driver never compares keys itself.
          if (
            bound.family !== 'terminal' ||
            bound.driver !== profile.driverId ||
            bound.harness !== harness
          ) {
            throw new TerminalRecoveryRefusal('terminal recovery process identity mismatch')
          }
          return recoverWithId(
            {
              type: 'reattach',
              sessionId: bound.sessionId,
              durableLabel: bound.process.key,
              agentKind: harness,
              cwd: bound.workdir,
              ...(bound.resume ? { resume: bound.resume } : {}),
              // Screen parser hint only; host recovery never applies this to PTY.
              lastKnownGeometry: { cols: 80, rows: 24 },
              observationBindingVersion: bound.bindingVersion + 1,
              observationGeneration: bound.bindingVersion + 1,
            },
            profile,
            true,
          )
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const capabilityCache = new WeakMap<TerminalHarnessProfile, DriverCapabilities>()

/**
 * Fold a delta's cursors into the furthest position seen. A cursor in another
 * segment means the store moved on (resume, new file, rotation), so the
 * position moves with it. Within one segment the MAX wins: a producer may
 * re-emit an earlier item, as OpenCode does when a part is updated. An item
 * whose cursor does not decode cannot be placed: it ends `empty` (the store
 * is no longer known to be empty) and leaves a known position as it was.
 */
function advancePosition(
  from: TranscriptPosition,
  items: readonly TranscriptItem[],
): TranscriptPosition {
  let position = from
  for (const item of items) {
    const parts = item.cursor ? decodeCursor(item.cursor) : null
    if (!parts) {
      if (position.kind === 'empty') position = { kind: 'unknown' }
      continue
    }
    if (position.kind === 'at' && position.fileId === parts.fileId &&
      (parts.offset < position.offset || parts.offset === position.offset && parts.sub <= position.sub)) continue
    position = { kind: 'at', fileId: parts.fileId, offset: parts.offset, sub: parts.sub }
  }
  return position
}

/**
 * WHETHER A TRANSCRIPT ENTRY WAS WRITTEN AFTER THE SEND STARTED (POD-4838).
 *
 * The echo matches by content, and short prompts repeat — "yes", "continue" —
 * so an entry may credit a send only if the harness wrote it after the send
 * began. A re-read (`reset`) carries every older copy of the same words, and a
 * polled tail can hand over a record written just before the send just after
 * it; neither may confirm a new send.
 *
 *   - A timestamp, where the harness writes a usable one, must be at or after
 *     the start, less the harness's own resolution. Same machine, same clock.
 *   - A comparable live position can REFUSE an already-observed entry even
 *     when its timestamp equals the typing floor. This witness is transient;
 *     restored watches start from time alone, never the current tail position.
 *   - When the transcript was empty at the start — a fresh launch, or a
 *     re-read that found nothing — every entry lies after it.
 *   - Anywhere else — another segment, or a start before any delta arrived —
 *     position proves nothing, and only the timestamp can answer.
 *
 * FAIL CLOSED. No usable timestamp and no comparable position ⇒ no credit; the
 * send reports `unverified`, the honest outcome, instead of a guessed accept.
 *
 * A hook does not bypass this floor. Its timely native id can prove only an
 * eligible recorded prompt, including when hook and history arrive reversed.
 */
function echoIsAfterStart(
  item: TranscriptItem,
  start: AcceptWaiter['start'],
  timestamps: TranscriptTimestampFidelity,
): boolean {
  const writtenAtMs = timestamps !== 'absent' && item.ts ? Date.parse(item.ts) : Number.NaN
  const dated = Number.isFinite(writtenAtMs)
  const parts = item.cursor ? decodeCursor(item.cursor) : null
  const comparable = parts !== null && start.position.kind === 'at' && parts.fileId === start.position.fileId
  if (comparable && start.position.kind === 'at' &&
    (parts.offset < start.position.offset || parts.offset === start.position.offset && parts.sub <= start.position.sub)) return false
  if (dated && timestamps !== 'absent') {
    return writtenAtMs >= Math.floor(start.atMs / timestamps.resolutionMs) * timestamps.resolutionMs
  }
  if (start.position.kind === 'empty') return true
  return comparable
}

function capabilitiesFor(profile: TerminalHarnessProfile | undefined): DriverCapabilities {
  const resolved: TerminalHarnessProfile = profile ?? {
    driverId: 'generic-pty',
    composerReadiness: 'on-bind',
    instrumentationRequired: false,
    sendProof: ['transcript-echo'],
    acceptCorrelation: {},
    transcriptTimestamps: 'absent',
    needsSubmitVerification: true,
    usesRawFirstTurn: false,
    archivable: false,
    reportsContextPercent: false,
    // No profile means no manifest to ask — the conservative guess, matching
    // `harnessInterrupt`'s unknown-harness answer: esc, and never fatal.
    interruptBytes: '\x1b',
    interruptQuitsWhenIdle: false,
  }
  const cached = capabilityCache.get(resolved)
  if (cached) return cached
  const built = terminalCapabilities({
    driverId: resolved.driverId,
    instrumentationRequired: resolved.instrumentationRequired,
    sendProof: resolved.sendProof,
    composerReadiness: resolved.composerReadiness,
    interactionsFromHooks: resolved.interactionsFromHooks === true,
    usesRawFirstTurn: resolved.usesRawFirstTurn,
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

/**
 * The keystrokes that answer a native menu, and when each one goes.
 *
 * `at[i]` is the ABSOLUTE delay in ms before `keys[i]`; `at[0]` is always 0.
 * The gaps are the server keystroke path's own (`answerAskUserQuestion`):
 * 120ms between keys, 240ms before the closing commit.
 */
interface MenuScript {
  keys: string[]
  at: number[]
}

type MenuScriptResult = { ok: true; script: MenuScript } | { ok: false; detail: string }

/** One question's answer once mapped onto the keystroke path's vocabulary —
 *  the same `AnswerChoice` shape `nativeMenuChoices` builds on the server, so
 *  the guards below read the same way on both routes. */
type MenuChoice = { multiSelect?: boolean; previewLayout?: boolean } & (
  | { optionIndices: number[] }
  | { freeText: string; otherIndex?: number }
)

/** One typed digit. Anything else cannot be a menu keystroke. */
const isMenuDigit = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 9

/** Several picks can only have come from a multi-select, so an ask that cannot
 *  say so is still read correctly — the legacy script's own inference. */
const isMultiChoice = (choice: MenuChoice): boolean =>
  choice.multiSelect ?? ('optionIndices' in choice && choice.optionIndices.length > 1)

/** The side-by-side preview dialog. Single-select BY CONSTRUCTION, so a choice
 *  claiming both is a contradiction and must not be typed at all. */
const isPreviewChoice = (choice: MenuChoice): boolean =>
  choice.previewLayout === true && !isMultiChoice(choice)

/** The ONE shape the native menu commits by itself, so the ONE shape that must
 *  not be given a closing CR. Holds in the preview layout too: a lone question
 *  auto-submits the moment the CR selects a row. */
const isLoneSingleChoice = (choices: MenuChoice[]): boolean => {
  const only = choices.length === 1 ? choices[0] : undefined
  return only !== undefined && !isMultiChoice(only)
}

/**
 * Why this answer cannot be typed into the native menu, or null when it can.
 *
 * Checked for EVERY choice before a single byte moves — the legacy path's own
 * rule, kept verbatim: a choice this cannot express is a refusal, never a
 * partial script, because the questions it could not answer stay on their
 * first row and a closing CR would commit those rows as if the operator had
 * picked them.
 */
const undeliverableChoice = (choice: MenuChoice, at: number): string | null => {
  const where = `question ${at + 1}`
  const digits = 'optionIndices' in choice ? choice.optionIndices.filter(isMenuDigit) : []
  if (choice.previewLayout === true) {
    if (choice.multiSelect === true) return `${where}: a preview question cannot be multi-select`
    if (digits.length > 1) {
      return `${where}: a preview question takes one option, got ${digits.join(',')}`
    }
  }
  if ('freeText' in choice) {
    if (choice.freeText.trim() === '') return `${where}: empty free text`
    // The Other row only exists in the classic list layout; the preview layout
    // reaches its Notes field with `n` and needs no index.
    if (!isPreviewChoice(choice) && !isMenuDigit(choice.otherIndex)) {
      return `${where}: Other is at ${choice.otherIndex}, outside the menu's 1-9 digits`
    }
    return null
  }
  if (digits.length === 0 || digits.length !== choice.optionIndices.length) {
    const got = choice.optionIndices.join(',') || 'nothing'
    return `${where}: no option in the menu's 1-9 digits (got ${got})`
  }
  return null
}

/**
 * The `need.interview` the channel carried, in the ask's own vocabulary.
 *
 * The flags follow the server synthesis's `normalizeQuestions` rule for rule —
 * `previewLayout` is the CLI's own predicate (`!multiSelect` with any
 * per-option preview), and `otherIndex` is the synthetic Other row one past
 * the last option, never under a preview layout whose dialog has no Other row
 * at all. Null when the channel carried no interview, in which case the ask
 * stays the honest option-less prompt it always was.
 */
function interviewPrompts(need: AgentRuntimeState['need']): QuestionPrompt[] | null {
  const raw = need?.kind === 'question' ? need.interview?.questions : undefined
  if (!raw || raw.length === 0) return null
  return raw.map((q) => {
    const options = q.options.map((o) => ({
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
      ...(o.preview ? { preview: o.preview } : {}),
    }))
    const multiSelect = q.multiSelect === true
    const previewLayout = !multiSelect && options.some((o) => (o.preview ?? '') !== '')
    return {
      question: q.question,
      ...(q.header ? { header: q.header } : {}),
      multiSelect,
      ...(!previewLayout && options.length > 0 ? { otherIndex: options.length + 1 } : {}),
      previewLayout,
      options,
    }
  })
}

/**
 * The keystrokes that answer a native menu (POD-3982).
 *
 * TWO VOCABULARIES IN. The shorthand the conformance corpus speaks —
 * `{skip}`, `{index}`, `{decision}` — types exactly what it always typed. The
 * typed contract value (`{kind:'question', selections}`) is mapped onto the
 * legacy keystroke path choice for choice — single, multi-select, preview,
 * free text through the Other row or the preview Notes field, several
 * questions in one ask — with the same pre-send guards and the same script:
 * digits one keystroke each, CR to select under preview, Tab past a multi,
 * one closing CR unless the menu commits by itself, ESC for skip.
 *
 * NOTHING IS TYPED UNTIL EVERY SELECTION IS DELIVERABLE: an answer this cannot
 * express in full is a refusal with the reason, never a partial script.
 */
function menuScriptFor(answer: unknown, ask: PendingInteraction): MenuScriptResult {
  if (typeof answer !== 'object' || answer === null) {
    return { ok: false, detail: 'this menu takes a question answer' }
  }
  const record = answer as Record<string, unknown>
  if (typeof record.kind !== 'string') {
    // THE SHORTHAND, unchanged: it names an option rather than carrying the
    // typed vocabulary, and the conversion from 0-based option to 1-based menu
    // digit happens exactly here.
    if (record.skip === true) return { ok: true, script: { keys: [ESC], at: [0] } }
    const index = record.index ?? record.optionIndex
    // `index` IS ZERO-BASED — it names an OPTION, not a keystroke. The menu's own
    // digits are 1-based, and the conversion happens exactly here so that no caller
    // ever has to know the difference between "the second option" and "the key you
    // press for it".
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index <= 8) {
      return { ok: true, script: { keys: [String(index + 1)], at: [0] } }
    }
    const decision = record.decision
    // A permission ask's yes/no is the same menu shape: the first option allows,
    // ESC dismisses.
    if (decision === 'allow') return { ok: true, script: { keys: ['1'], at: [0] } }
    if (decision === 'deny') return { ok: true, script: { keys: [ESC], at: [0] } }
    return { ok: false, detail: 'this menu takes a question answer' }
  }
  if (record.kind !== 'question' || ask.kind !== 'question') {
    return {
      ok: false,
      detail: `an answer of kind '${String(record.kind)}' cannot answer this menu`,
    }
  }
  if (record.skip === true) return { ok: true, script: { keys: [ESC], at: [0] } }
  const selections = Array.isArray(record.selections)
    ? (record.selections as readonly QuestionSelection[])
    : null
  if (!selections) return { ok: false, detail: 'a question answer names one selection per prompt' }
  return questionScriptFor(ask.payload.questions, selections)
}

/**
 * The typed question answer at the ask's own prompts.
 *
 * PARTIAL IS A REFUSAL. A menu holds every prompt open at once and the closing
 * CR commits all of them, so answering three of four questions would commit
 * the fourth on whatever row it happened to be sitting. Anything short of one
 * expressible choice per prompt returns the reason and nothing is typed.
 */
function questionScriptFor(
  prompts: readonly QuestionPrompt[],
  selections: readonly QuestionSelection[],
): MenuScriptResult {
  if (prompts.length === 0) {
    return { ok: false, detail: 'this ask carries no readable options to answer' }
  }
  if (selections.length !== prompts.length) {
    return {
      ok: false,
      detail: `this menu holds ${prompts.length} prompt(s) and the answer covers ${selections.length}`,
    }
  }
  const choices: MenuChoice[] = []
  for (let at = 0; at < prompts.length; at++) {
    const prompt = prompts[at]
    const selection = selections[at]
    if (!prompt || !selection) return { ok: false, detail: `prompt ${at + 1}: missing` }
    if (prompt.options.length === 0) return { ok: false, detail: `prompt ${at + 1}: options are unreadable` }
    if (!prompt.multiSelect && selection.optionIndices.length > 1) {
      return { ok: false, detail: `prompt ${at + 1}: this question takes one option` }
    }
    if (selection.text !== undefined && /[\r\n]/.test(selection.text)) {
      return { ok: false, detail: `prompt ${at + 1}: free text must be a single line` }
    }
    const shape = {
      ...(prompt.multiSelect ? { multiSelect: true as const } : {}),
      ...(prompt.previewLayout ? { previewLayout: true as const } : {}),
    }
    if (selection.text !== undefined) {
      // THE "OTHER" ROW ONLY EXISTS WHERE THE MENU DREW IT. Without it there
      // is no row to type free text into — except under a preview layout,
      // whose Notes field the `n` key reaches with no index at all, and except
      // on an unreadable menu, where the answer's own digit is the only row.
      if (isPreviewChoice({ ...shape, optionIndices: [] })) {
        choices.push({ ...shape, freeText: selection.text })
        continue
      }
      if (prompt.otherIndex !== undefined) {
        choices.push({ ...shape, freeText: selection.text, otherIndex: prompt.otherIndex })
        continue
      }
      const sole = selection.optionIndices.length === 1 ? selection.optionIndices[0] : undefined
      if (prompt.options.length === 0 && isMenuDigit(sole)) {
        choices.push({ ...shape, freeText: selection.text, otherIndex: sole })
        continue
      }
      return { ok: false, detail: `prompt ${at + 1}: this menu has no free-text row` }
    }
    if (selection.optionIndices.length === 0) {
      return { ok: false, detail: `prompt ${at + 1}: no option chosen` }
    }
    if (prompt.options.length > 0) {
      // The classifier read N options; an index past them is an answer to a
      // menu this is not looking at — including the Other row named without
      // its free text.
      const beyond = selection.optionIndices.find((index) => index > prompt.options.length)
      if (beyond !== undefined) {
        return {
          ok: false,
          detail: `prompt ${at + 1}: option ${beyond} is beyond the ${prompt.options.length} option(s) on screen`,
        }
      }
    }
    choices.push({ ...shape, optionIndices: [...selection.optionIndices] })
  }
  for (const [i, choice] of choices.entries()) {
    const why = undeliverableChoice(choice, i)
    if (why) return { ok: false, detail: why }
  }
  const keys: string[] = []
  const at: number[] = []
  let delayMs = 0
  const key = (data: string, gapBefore = MENU_KEY_DELAY_MS): void => {
    if (keys.length > 0) delayMs += gapBefore
    keys.push(data)
    at.push(delayMs)
  }
  for (const choice of choices) {
    const preview = isPreviewChoice(choice)
    if ('freeText' in choice) {
      // Ink needs a frame to move focus into the field before characters land
      // as the custom answer rather than as menu keys.
      key(preview ? 'n' : String(choice.otherIndex))
      key(choice.freeText)
      key('\r')
    } else {
      const digits = choice.optionIndices.filter(isMenuDigit)
      if (preview) {
        // The digit only moves the cursor here; the CR is what selects. Exactly
        // one digit survives validation above, so there is always a first.
        const first = digits[0]
        if (first === undefined)
          return { ok: false, detail: `question: no option in the menu's digits` }
        key(String(first))
        key('\r')
      } else {
        for (const digit of digits) key(String(digit))
      }
    }
    if (isMultiChoice(choice)) key('\t')
  }
  if (!isLoneSingleChoice(choices)) key('\r', MENU_CONFIRM_DELAY_MS)
  return { ok: true, script: { keys, at } }
}

