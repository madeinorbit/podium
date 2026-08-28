/**
 * THE codex app-server DRIVER (POD-1761 W6; spec §2, §3, §5, §6).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ONE PROVES THAT W5 COULD NOT
 * ---------------------------------------------------------------------------
 *
 * Three things, and each is a first for the epic:
 *
 *   1. NATIVE STEER. `turn/steer` puts words into an OPEN turn. Every other
 *      driver in the fleet degrades `steer` to `queue` and reports the
 *      downgrade; this one reports `deliveredAs: 'steer'` because it actually
 *      steered.
 *   2. THE APPROVAL INVERSION. The server asks US questions over the same link
 *      and BLOCKS until answered. An interaction here is not an event we
 *      observed and later reply to out of band — it is an open JSON-RPC request
 *      whose response is the answer.
 *   3. SUBSCRIPTION AUTH, HEADLESS. The child inherits `~/.codex/auth.json` and
 *      `getAuthStatus` reports `authMethod: 'chatgpt'` — which this driver
 *      ASSERTS rather than assumes, because the daemon strips inherited API keys
 *      precisely so that a silent fallback to a different account is impossible.
 *
 * ---------------------------------------------------------------------------
 * THE SPLIT: SESSION LOGIC HERE, PROCESSES IN THE DAEMON
 * ---------------------------------------------------------------------------
 *
 * Everything below is JSON-RPC and bookkeeping — testable in-process against a
 * fake app-server built from recorded frames. What is NOT here is spawning:
 * `codex app-server` under a systemd transient scope, its env hygiene, the
 * binding journal on disk. That is `apps/daemon/src/runtime/codex-app-server.ts`,
 * reached only through {@link CodexRuntimeHost} — the same discipline
 * `TerminalRuntimeHost` and `OpencodeRuntimeHost` apply.
 *
 * ---------------------------------------------------------------------------
 * WHY `adopt()` RESUMES INSTEAD OF REBINDING, AND WHY THAT IS NOT A DODGE
 * ---------------------------------------------------------------------------
 *
 * The contract says `adopt()` rebinds a SURVIVING process tree on exact
 * identity. For this family there is never one, and that is a measured property
 * of the host lifetime rather than a limitation of the implementation: protocol
 * clients use the private Unix listener, while the child still exits cleanly
 * when the daemon-owned stdin reaches EOF. When the daemon dies that lifetime
 * tether closes, so the child dies with it. There is no orphan to find and
 * nothing to rebind to.
 *
 * What survives is the thing that matters: the conversation. Codex persists each
 * thread to its own rollout JSONL, so `adopt()` starts a fresh app-server and
 * `thread/resume`s the journalled thread id. The session id, the transcript, the
 * resume ref and the causal continuity (turn epoch and event seq, carried in the
 * journal) all hold across the restart; the PROCESS is new and says so, by
 * bumping the binding version and emitting an `adopted` process event. A driver
 * that instead reported the old pid as alive would be fabricating exactly the
 * state the house rules forbid.
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
import { codexAppServerCapabilities } from './capabilities.js'
import { type CodexClient, type CodexClientConfig, createCodexClient } from './client.js'
import {
  answerAction,
  commandApprovalAsk,
  describeTurnError,
  elicitationAsk,
  fileChangeApprovalAsk,
  idleToStateEvent,
  permissionsApprovalAsk,
  statusToStateEvent,
  threadItemToItems,
  turnStatusToVerdict,
} from './map.js'
import {
  CHATGPT_AUTH_METHOD,
  CODEX_METHODS,
  CODEX_SERVER_REQUESTS,
  type CodexNotification,
  CodexRpcError,
  type CodexThreadId,
  type CodexTurn,
  type CodexTurnId,
  DELTA_NOTIFICATIONS,
} from './protocol.js'

// ---------------------------------------------------------------------------
// The host port
// ---------------------------------------------------------------------------

/** One live `codex app-server` child, as the driver needs it. */
export interface CodexServerEndpoint {
  /** The driver's connected client. The driver owns JSON-RPC; the host owns I/O. */
  transport: CodexClientConfig['transport']
  /** The per-session address Codex's stock TUI connects to. */
  clientAddress: string
  /**
   * Open another protocol client on the SAME app-server, when supported.
   *
   * CURRENTLY IMPLEMENTED AND NOT CALLED, which is stated rather than quietly
   * true. Its only caller was the fine-watch upgrade's candidate connection,
   * deleted in POD-2745. A review of that deletion proposed removing this port
   * as dead, and I nearly did — but the daemon really does implement it
   * (`apps/daemon/src/runtime/codex-app-server.ts`, the Unix-socket endpoint),
   * so deleting the declaration breaks the daemon's typecheck. Kept because a
   * second client on one app-server is a real capability of this transport that
   * a future caller would otherwise have to rebuild; delete BOTH halves together
   * if it is still unused when someone next looks.
   */
  reconnect?(): Promise<CodexClientConfig['transport']>
  /** What a rebind matches on. Opaque and EXACT. */
  process: ProcessIdentity
  stop(): Promise<void>
  kill(): Promise<void>
  /** Resource truth for this session's scope — memory, tasks, and the kernel's
   *  own OOM-kill counter. `undefined` where the platform has no cgroup or the
   *  scope is already gone. */
  resources(): ScopeResources | undefined
}

/** What the driver needs from whoever owns processes and disks. */
export interface CodexRuntimeHost {
  /**
   * Spawn an app-server for one session and return its connected transport.
   *
   * NO READINESS PROBE IS NEEDED HERE, unlike opencode's host: the handshake IS
   * the probe. `initialize` either answers over the transport or it is not
   * usable, so there is no window in which the child is up but not driveable.
   */
  launch(input: {
    sessionId: SessionId
    workdir: string
    env?: Readonly<Record<string, string>>
    /**
     * Podium's MCP configuration, forwarded VERBATIM from `SessionSpec`.
     *
     * The driver hands the declaration over rather than turning it into `-c`
     * overrides itself, and the split is the same one the whole file runs on:
     * argv construction is the daemon's, because that is where the rest of this
     * child's command line is built and where the manifest's own
     * `codexMcpArgs` mechanism already lives. A driver that built argv would be
     * a second place that knows how Codex mounts an MCP server.
     */
    mcpServers?: { transport: 'path'; path: string } | { transport: 'inline'; config: string }
  }): Promise<CodexServerEndpoint>

  stageAttachment: AttachmentStager

  /** Read a thread's rollout JSONL, for `export()`. `undefined` when the file is
   *  gone — an archive that silently shipped zero bytes would be worse. */
  readRollout?(path: string): Promise<Uint8Array | undefined>

  /** Does the rollout path returned by `thread/start` exist yet? Codex does not
   *  write a brand-new thread until its first turn or metadata mutation, while
   *  `codex resume <id>` requires that file. The host owns this disk fact. */
  rolloutExists?(path: string): Promise<boolean>

  /**
   * Report which credential Codex actually chose for a session.
   *
   * A HOST CALLBACK RATHER THAN A STREAM EVENT, and the reason is the house rule
   * about not fabricating state: `ProcessEvent` has three arms — `exited`,
   * `oomKilled`, `adopted` — and none of them means "this session is on a
   * different credential than expected". Adding a fourth to the shared contract
   * so one driver could report one diagnostic would widen a vocabulary every
   * consumer branches on, for a fact only the daemon needs to log. So the fact
   * goes to whoever owns surfacing, and the contract is left alone.
   */
  reportAuthMode?(input: {
    sessionId: SessionId
    authMethod: string | undefined
    /** Whether that method IS the ChatGPT subscription. Computed here so every
     *  host does not re-encode which string means what. */
    subscription: boolean
  }): void

  /** Start Codex's own TUI against this thread, for `attach()`. `undefined` when
   *  the host has nowhere to run one. */
  attachClient?(input: {
    sessionId: SessionId
    threadId: CodexThreadId
    clientAddress: string
    mode: AttachRequest['mode']
  }): Promise<{ streamId: string; warmTtlMs: number } | undefined>
  /** Stop the stock TUI when its parent session ends. */
  detachClient?(input: { sessionId: SessionId }): Promise<void>

  /**
   * TURNS THIS DRIVER ACCEPTED AND WILL NEVER DELIVER (POD-2297).
   *
   * The server family's counterpart to `TerminalInjectionPorts.onDrainAbandoned`
   * — see `../../queue-abandonment.ts` for why the promise needs one here too,
   * and the terminal port for the at-least-once and dedupe rules the host owes.
   * Optional; the daemon's adapter logs every abandonment either way.
   */
  onQueueAbandoned?: OnQueueAbandoned

  journal: CodexJournal
  now(): number
  mintSessionId(): SessionId
  /** Injected only by tests, which point the client at an in-process server. */
  makeClient?(config: CodexClientConfig): CodexClient
}

/** What survives a supervisor restart. The transient listener address does not:
 *  its 0600 filesystem boundary is recreated with the next child. */
export interface CodexJournalEntry {
  sessionId: SessionId
  threadId: CodexThreadId
  workdir: string
  /** The rollout JSONL path Codex reported at `thread/start`. What makes
   *  `export()` byte-faithful for this family. */
  rolloutPath?: string
  /**
   * THE SESSION'S MODEL POLICY, because a resume that drops it CHANGES THE
   * AGENT (POD-2775, review 3).
   *
   * `deliver()` sends `model` and `effort` on every `turn/start` from the spec
   * it was bound with, and an adopted session used to be bound with an empty
   * one. So a session the operator put on a specific model came back on Codex's
   * default and stayed there — silently, because nothing in the transcript says
   * which model answered.
   *
   * It belongs in the journal rather than in the resume frame because the wake
   * has to work from what THIS MACHINE persisted: a daemon restart adopts with
   * no frame at all, and the spawn frame that does arrive describes what the
   * server currently believes rather than what the session was started with.
   *
   * Optional: entries written before this field existed simply have no policy,
   * which is exactly the old behaviour and not a parse error.
   */
  model?: ModelPolicy
  process: ProcessIdentity
  /** The event-stream high-water mark, so a rebind resumes rather than replays
   *  and so `seq` stays monotonic across it. */
  seq: number
  turnEpoch: number
  bindingVersion: number
}

export interface CodexJournal {
  read(sessionId: SessionId): CodexJournalEntry | undefined
  write(entry: CodexJournalEntry): void
  clear(sessionId: SessionId): void
}

/** How many events one session's replay buffer retains — the same bound and the
 *  same argument as the other two drivers': it serves a RECONNECT, not history. */
export const CODEX_EVENT_LOG_LIMIT = 512

/** How long `send({delivery:'when-ready'})` waits for an open turn to end.
 *  Long, because the honest alternative to waiting is refusing, and a caller
 *  that asked for `when-ready` said it would rather wait. */
const WHEN_READY_TIMEOUT_MS = 10 * 60_000

/**
 * How long a `steer` waits for the turn to actually OPEN before giving up on
 * steering and queueing instead.
 *
 * THIS WINDOW IS REAL AND WAS MEASURED. `turn/start`'s response lands BEFORE the
 * `turn/started` notification, and a `turn/steer` fired in between is refused
 * with "no active turn to steer". Short, because it is a local race between two
 * frames on one connection, not a wait on the model.
 */
const STEER_OPEN_TIMEOUT_MS = 15_000

export const CODEX_APP_SERVER_DRIVER_ID = 'codex-app-server'

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

interface QueuedTurn {
  input: TurnInput
  options: SendOptions
}

/** An outstanding server→client request: the ask, plus what is needed to answer
 *  it. `requestId` is the JSON-RPC id the response must carry. */
interface OpenAsk {
  interaction: PendingInteraction
  requestId: number | string
  /** The ask's own `availableDecisions`, kept verbatim so `answerAction` can
   *  check EVERY decision against it — not just the always-allow. */
  availableDecisions: readonly unknown[] | undefined
}

/** The mutable handler box a connection is built around — see `connect()`. */
interface CodexSink {
  note?: (note: CodexNotification) => void
  request?: (request: { id: number | string; method: string; params: unknown }) => void
  closed?: () => void
}

/** A client plus the box whose handlers it calls. They travel together because
 *  re-pointing the handlers is what `wire()` does, and a client without its box
 *  can never be attached to a session. */
interface CodexConnection {
  client: CodexClient
  sink: CodexSink
}

interface DriverSession {
  sessionId: SessionId
  spec: SessionSpec
  endpoint: CodexServerEndpoint
  connection: CodexConnection
  client: CodexClient
  threadId: CodexThreadId
  rolloutPath: string | undefined
  binding: SessionBinding
  observerGeneration: number
  turnEpoch: number
  seq: number
  /** The turn Codex says is open, or undefined. Set by `turn/started` and
   *  cleared by `turn/completed` — never guessed, and never set by the
   *  `turn/start` RESPONSE, which arrives before the turn is steerable. */
  openTurnId: CodexTurnId | undefined
  /** A turn we have accepted but whose `turn/started` has not landed yet. This
   *  is the measured window between the ack and the open turn. */
  pendingTurnId: CodexTurnId | undefined
  /** Provider turn ids whose terminal notification has already been folded. */
  fencedTurnIds: Set<CodexTurnId>
  asks: Map<string, OpenAsk>
  /** Asks this driver saw CLOSE, so a second answer is `already-answered`
   *  rather than `unknown-interaction`. */
  answered: Set<string>
  queue: QueuedTurn[]
  lease: SessionLease | null
  draft: string
  /** Viewers, by level. `fine` is the ONLY gate on fragment emission: the
   *  connection carries them either way (POD-2745), so this count is what makes
   *  the level a per-viewer fact rather than a per-connection one. */
  watchers: { coarse: number; fine: number }
  log: { seq: number; event: RuntimeEvent }[]
  wakers: Set<() => void>
  state: AgentRuntimeState
  disposed: boolean
  /** Resolvers waiting for the session to go idle. */
  idleWaiters: Set<() => void>
  /** Resolvers waiting for a turn to actually open (the steer window). */
  turnOpenWaiters: Set<() => void>
  usage: UsageSnapshot | undefined
  title: string | undefined
}

export interface CodexRuntime {
  driver: RuntimeDriver
  /** Start a session under an id the CALLER already minted — the same division
   *  W3 and W5 use, and for the same reason: the server row's id exists before
   *  the spawn frame is sent, and a handle registered under a different one is a
   *  handle every subsequent verb fails to find. */
  createWithId(sessionId: SessionId, spec: SessionSpec): Promise<AgentSessionHandle>
  handleFor(sessionId: SessionId): AgentSessionHandle | undefined
  bindings(): readonly AgentSessionHandle['binding'][]
  /** Drop a session's handle without touching the process. What a supervisor
   *  restart looks like from inside this process. */
  forget(sessionId: SessionId): void
  /**
   * THE SUPERVISOR OBSERVED A KERNEL OOM KILL in this session's scope
   * (POD-2413).
   *
   * The fact enters through the DRIVER rather than going to the server
   * directly, because a runtime event without a causal envelope is not a
   * runtime event: only the driver holds this session's cursor, observer
   * generation and turn epoch. The supervisor knows WHAT happened; the driver
   * is what can say it in the stream's own language.
   *
   * Not a death. `OOMPolicy=continue` means the kernel killed one process
   * inside the tree and the session usually keeps serving; whether it died is
   * the `exited` arm's business.
   */
  reportOomKill(sessionId: SessionId, scopeUnit?: string): void

  dispose(): void
}

export function createCodexRuntime(host: CodexRuntimeHost): CodexRuntime {
  const sessions = new Map<SessionId, DriverSession>()
  const handles = new Map<SessionId, AgentSessionHandle>()
  const streamPositions = new Map<string, { seq: number; turnEpoch: number }>()
  const capabilities = codexAppServerCapabilities()

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
    if (session.log.length > CODEX_EVENT_LOG_LIMIT) {
      session.log.splice(0, session.log.length - CODEX_EVENT_LOG_LIMIT)
    }
    for (const wake of [...session.wakers]) wake()
    persist(session)
  }

  /**
   * THE CURSOR: the thread id as the segment, this stream's ordinal as the
   * position.
   *
   * Codex's notifications carry `emittedAtMs` but no ordinal, so the driver
   * maintains one and persists the high-water mark in the journal. The segment
   * is the THREAD id, which makes a cursor from one thread incomparable with
   * another's rather than accidentally ordered against it — and a fork, which
   * mints a new thread id, is correctly incomparable with its parent.
   */
  const cursorFor = (session: DriverSession, seq: number): ProviderCursor => {
    if (!session.threadId) return driverLocalCursor(session.binding.process.key, seq)
    return { segmentId: session.threadId, components: { seq } }
  }

  const persist = (session: DriverSession): void => {
    host.journal.write({
      sessionId: session.sessionId,
      threadId: session.threadId,
      workdir: session.spec.workdir,
      ...(session.rolloutPath ? { rolloutPath: session.rolloutPath } : {}),
      model: session.spec.model,
      process: session.binding.process,
      seq: session.seq,
      turnEpoch: session.turnEpoch,
      bindingVersion: session.binding.bindingVersion,
    })
  }

  // -- notification ingestion ----------------------------------------------

  /**
   * Fold one notification into the session.
   *
   * THE FIRST LINE IS THE THREAD FILTER, and it is not defensive programming:
   * one app-server can hold several threads, and Codex runs subagents as CHILD
   * threads with their own ids on the SAME connection. A driver that skipped
   * this would watch a subagent's `turn/completed` fence its parent mid-turn and
   * drain the parent's queue into a running turn — the same class of bug W5
   * documented for opencode's child sessions.
   */
  function ingest(session: DriverSession, note: CodexNotification): void {
    const subject = 'threadId' in note.params ? note.params.threadId : undefined
    if (subject !== undefined && subject !== session.threadId) return

    switch (note.method) {
      case 'thread/started': {
        // A resumed or forked thread announces itself; the path is what makes
        // `export()` byte-faithful, so it is captured wherever it appears.
        if (note.params.thread.path) session.rolloutPath = note.params.thread.path
        if (note.params.thread.name) session.title = note.params.thread.name
        persist(session)
        break
      }
      case 'thread/status/changed': {
        const at = iso()
        const change = statusToStateEvent(note.params.status, at)
        if (change) emit(session, { t: 'state', change }, at)
        break
      }
      case 'thread/tokenUsage/updated': {
        const total = note.params.tokenUsage.total
        const window = note.params.tokenUsage.modelContextWindow
        session.usage = {
          ...(total?.inputTokens !== undefined ? { inputTokens: total.inputTokens } : {}),
          ...(total?.outputTokens !== undefined ? { outputTokens: total.outputTokens } : {}),
          // THE ONE DRIVER THAT CAN REPORT THIS WITHOUT A SECOND LOOKUP: Codex
          // sends the model's context window alongside the count, so the
          // percentage is a division rather than a guess about which model is
          // loaded.
          ...(window && total?.totalTokens !== undefined
            ? { contextUsedPercent: Math.min(100, (total.totalTokens / window) * 100) }
            : {}),
        }
        break
      }
      case 'turn/started': {
        const at = iso(note.params.turn.startedAt ? note.params.turn.startedAt * 1000 : undefined)
        session.openTurnId = note.params.turn.id
        session.pendingTurnId = undefined
        session.state = { phase: 'working', since: at, nativeSubagentCount: 0 }
        // The turn is only STEERABLE from here — see STEER_OPEN_TIMEOUT_MS.
        for (const wake of [...session.turnOpenWaiters]) wake()
        session.turnOpenWaiters.clear()
        break
      }
      case 'turn/completed': {
        closeTurn(session, note.params.turn)
        break
      }
      case 'item/started':
      case 'item/completed': {
        const ms =
          note.method === 'item/completed' ? note.params.completedAtMs : note.params.startedAtMs
        const at = iso(ms)
        /**
         * ONLY COMPLETED ITEMS BECOME `complete` EVENTS.
         *
         * Codex updates ONE item in place: `item/started` carries a
         * `commandExecution` with `status:'inProgress'` and no output, and
         * `item/completed` carries the same id with the output attached.
         * Emitting both as `complete` would put the same tool call in the
         * transcript twice, the first time with its result missing — and the
         * durable transcript path has never carried partial items.
         */
        if (note.method !== 'item/completed') {
          /**
           * EXCEPT AS A LIVE-ONLY PARTIAL, WHICH IS NOT THE SAME THING
           * (POD-2293).
           *
           * The argument above is about the DURABLE path and it still holds: an
           * `item/started` must not become a `complete`, or the transcript
           * carries the tool call twice. But a viewer watching a two-minute
           * command run has nothing to look at until it finishes, and codex is
           * the only one of the three families with that hole — opencode
           * re-publishes a growing tool part and grok emits its `tool_call`
           * immediately, so both are already visible mid-run.
           *
           * So the started item goes out on the fine plane instead, under the
           * same two guards the fragment stream uses: a watcher must be asking
           * for it, and the turn it belongs to must still be open.
           */
          if (session.watchers.fine <= 0) break
          if (session.openTurnId === undefined) break
          /**
           * TOOL-ISH ITEMS ONLY, AND THE FILTER IS ON THE MAPPED ROLE RATHER
           * THAN ON CODEX'S TYPE NAMES (POD-2701, found by driving it).
           *
           * `item/started` fires for EVERY arm of the vocabulary. Two of them
           * are things the viewer can already see, and letting either through
           * opens a preview row for something that needs none:
           *
           *   - `userMessage` — the viewer typed it a moment ago and it is on
           *     screen above the composer.
           *   - `agentMessage` — `item/agentMessage/delta` is streaming that
           *     very message on this same plane, fragment by fragment.
           *
           * Both map to a TranscriptItem with no `toolName`, so the preview drew
           * them with the renderer's last-resort label: a bare "tool" line
           * sitting above the answer as it was written. That is what the drive
           * saw, on every single turn.
           *
           * The hole this partial exists to fill is the OTHER arms. Codex
           * updates one item in place, so a command execution, a file change,
           * an MCP call or a web search is invisible until it completes — none
           * has a delta stream, and each maps to `role: 'tool'`. Filtering on
           * the mapped role rather than on a list of type names means an arm
           * `map.ts` learns to render later is classified by what it turns into,
           * not by whether someone remembered to add it here.
           */
          for (const item of threadItemToItems(note.params.item, at)) {
            if (item.role !== 'tool') continue
            emit(session, { t: 'item', item: { kind: 'partial', item } }, at)
          }
          break
        }
        for (const item of threadItemToItems(note.params.item, at)) {
          emit(session, { t: 'item', item: { kind: 'complete', item } }, at)
        }
        break
      }
      case 'item/agentMessage/delta': {
        /**
         * FINE WATCH ONLY, AND THIS LINE IS THE ONLY GATE (POD-2745).
         *
         * These now reach the driver at every level — the handshake stopped
         * muting them at the server, because a mute that can only be lifted by
         * reconnecting made the level a property of the connection and cost a
         * mid-turn viewer the very turn they came to watch. So the count decides,
         * and it decides HERE, ahead of `emit`: a dropped fragment costs no
         * `seq`, no entry in the bounded event log, no journal write, and
         * nothing forwarded to the daemon. "Fine must not stay on with nobody
         * watching" is enforced by this comparison and nothing else, which is
         * why it is the first statement in the arm rather than a condition
         * further down.
         */
        if (session.watchers.fine <= 0) break
        // NOT INTO A CLOSED TURN (POD-2293). `closeTurn` clears `openTurnId`, so
        // an absent one means the fence already landed and the viewer already
        // has the durable item — a fragment now could only revive a preview that
        // was correctly replaced. The absorb rule, stated in fragment terms.
        if (session.openTurnId === undefined) break
        emit(
          session,
          {
            t: 'item',
            item: {
              kind: 'delta',
              // Keyed by the ITEM id, which is what the `item/completed` for the
              // same message carries as its `id`. Unlike opencode — whose item
              // ids are derived from their text and therefore change on every
              // update — Codex's `msg_…` id is stable for the item's whole life,
              // so a consumer reconciles a fragment stream against the complete
              // item on the id itself.
              itemId: note.params.itemId,
              textDelta: note.params.delta,
            },
          },
          iso(),
        )
        break
      }
      case 'serverRequest/resolved': {
        // AN ASK CLOSED, whoever closed it. Codex resolves a server→client
        // request when it is answered — including when it was answered by
        // something other than us, or cancelled because the turn ended. The
        // aggregate must see it close either way, or the session reports itself
        // blocked while it works.
        closeAsk(session, String(note.params.requestId), iso(), 'human')
        break
      }
      case 'error': {
        const at = iso()
        const detail = describeTurnError(note.params)
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
          {
            t: 'state',
            change: {
              kind: 'turn_failed',
              errorClass: detail.reason,
              retryable: detail.disposition === 'retryable',
              ...(detail.text ? { detail: detail.text } : {}),
              at,
            },
          },
          at,
        )
        break
      }
    }
  }

  // -- server→client requests: the approval inversion ------------------------

  /**
   * One inbound request from the server.
   *
   * EVERY BRANCH EITHER OPENS AN ASK OR ANSWERS THE REQUEST. A request that fell
   * through both would park the turn forever, because Codex applies no deadline
   * of its own — so the default arm answers with a JSON-RPC error rather than
   * staying silent, which lets the agent proceed (or fail) instead of hanging on
   * a question nobody can see.
   */
  function onServerRequest(
    session: DriverSession,
    request: { id: number | string; method: string; params: unknown },
  ): void {
    const at = iso()
    const base = { requestId: request.id, sessionId: session.sessionId, askedAt: at }
    const params = (request.params ?? {}) as Record<string, unknown>
    // WHAT THE SERVER SAID IT WOULD ACCEPT, read once and carried onto the ask.
    // Absent on requests that carry no decision list (the MCP elicitation), and
    // `offersDecision` treats absence as "the plain decisions only".
    const offers = Array.isArray(params.availableDecisions)
      ? (params.availableDecisions as readonly unknown[])
      : undefined

    if (request.method === CODEX_SERVER_REQUESTS.commandApproval) {
      openAsk(
        session,
        request.id,
        commandApprovalAsk({ ...base, params: params as never }),
        at,
        offers,
      )
      return
    }
    if (request.method === CODEX_SERVER_REQUESTS.fileChangeApproval) {
      openAsk(
        session,
        request.id,
        fileChangeApprovalAsk({ ...base, params: params as never }),
        at,
        offers,
      )
      return
    }
    if (request.method === CODEX_SERVER_REQUESTS.permissionsApproval) {
      openAsk(
        session,
        request.id,
        permissionsApprovalAsk({ ...base, params: params as never }),
        at,
        offers,
      )
      return
    }
    if (request.method === CODEX_SERVER_REQUESTS.elicitation) {
      openAsk(session, request.id, elicitationAsk({ ...base, params: request.params }), at)
      return
    }
    /**
     * A REQUEST THIS DRIVER DOES NOT UNDERSTAND.
     *
     * Answered with an error, deliberately, and this is the one place where
     * refusing beats staying silent. Elsewhere in this file an unanswerable ask
     * is left OPEN so the session stays visibly blocked — but that only works
     * for asks a SURFACE can see. This one has no mapping, so no surface would
     * ever show it and no human could ever answer it; leaving it open would park
     * the turn with nothing anywhere reporting why.
     */
    session.client.respondError(
      request.id,
      -32601,
      `podium's codex driver does not implement '${request.method}'`,
    )
  }

  function openAsk(
    session: DriverSession,
    requestId: number | string,
    interaction: PendingInteraction,
    at: string,
    /** What the server said it would accept. Carried through so `answer()` can
     *  check every decision against it, not only the always-allow. */
    availableDecisions?: readonly unknown[],
  ): void {
    session.asks.set(interaction.id, { interaction, requestId, availableDecisions })
    const need = interaction.kind === 'permission' ? 'permission' : 'question'
    const summary = interaction.kind === 'permission' ? interaction.payload.inputSummary : undefined
    emit(session, { t: 'interaction', ev: { ev: 'asked', interaction } }, at)
    emit(
      session,
      {
        t: 'state',
        change: { kind: 'needs_user', need, ...(summary ? { summary } : {}), at },
      },
      at,
    )
    /**
     * AND THE PROJECTION MOVES WITH IT — the same must-fix W5's review found,
     * avoided here rather than repeated.
     *
     * `emit()` stamps, logs and wakes; it does not fold. So without this the
     * event stream would say `needs_user` while `state()` and `snapshot().state`
     * still said `working`, and a blocked session would raise no attention: the
     * badge stays "working" for as long as the human takes to answer, and every
     * surface that reads the phase stays quiet. Two observers of one driver
     * disagreeing about whether a session needs a user is the exact failure the
     * causal contract exists to prevent, and spec §4's claim — that a blocked
     * session IS a session with an open interaction — has to hold on both
     * readers or it holds on neither.
     *
     * The fold lives HERE rather than in `emit()` for the same reason it does in
     * the opencode driver: emit is total over the event union, and folding there
     * would make it a second reducer for the whole vocabulary. Only the places
     * that already own a phase assign `session.state`.
     */
    session.state = {
      phase: 'needs_user',
      since: at,
      nativeSubagentCount: 0,
      need: { kind: need, ...(summary ? { summary } : {}) },
    }
  }

  function closeAsk(
    session: DriverSession,
    id: string,
    at: string,
    answeredBy: 'policy' | 'superagent' | 'human',
  ): void {
    if (!session.asks.delete(id)) return
    session.answered.add(id)
    emit(session, { t: 'interaction', ev: { ev: 'answered', id, answeredBy, at } }, at)
    /**
     * THE ASK CLOSED, SO THE PHASE MUST LEAVE `needs_user` — and it goes back to
     * what the SESSION is actually doing, not to a fixed value.
     *
     * Another ask still open means still blocked. Otherwise the turn Codex is
     * running (or is not) decides it, which `busy()` already records. Leaving
     * the phase at `needs_user` would strand a session that just got its answer;
     * hardcoding `idle` would report a running turn as finished — and for this
     * driver that second mistake is the likelier one, because answering an
     * approval is precisely the moment a turn RESUMES.
     */
    if (session.asks.size > 0) return
    session.state = {
      phase: busy(session) ? 'working' : 'idle',
      since: at,
      nativeSubagentCount: 0,
    }
  }

  // -- the turn fence --------------------------------------------------------

  /**
   * THE MARK A STOPPED TURN LEAVES BEHIND (POD-3090).
   *
   * Codex answers a stop as a completion carrying `status: 'interrupted'`, so
   * the mapping sees the provider's own word and this driver infers nothing.
   * Called from BOTH fence arms because a stop can also reach us classified as a
   * failure; the mapping returns nothing for every result that is not an
   * interrupt, which is why the call is unconditional.
   *
   * EXACTLY ONCE IS INHERITED, NOT RE-IMPLEMENTED: `closeTurn` claims
   * `fencedTurnIds` before anything below it runs, so a duplicate
   * `turn/completed` never reaches here — and the item id carries the epoch, so
   * even a replayed stream presents one stop as one record.
   */
  function publishInterruptMark(
    session: DriverSession,
    result: HeadlessTurnResult,
    at: string,
  ): void {
    const item = headlessInterruptMark({
      family: 'codex',
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
   * ABSORBING, AND ONLY THE PROVIDER OPENS IT. `turn/completed` is Codex saying
   * the turn ended and carrying its own verdict — `interrupted` when it was
   * stopped, `completed` otherwise — so unlike opencode this driver never has to
   * INFER whether an interrupt took effect. `interrupt()` does not call this; it
   * asks Codex to stop and waits for the same notification every other
   * completion arrives on, which is what "fences only on provider confirmation"
   * means in code rather than in a comment.
   */
  function closeTurn(session: DriverSession, turn: CodexTurn): void {
    if (session.fencedTurnIds.has(turn.id)) return
    session.fencedTurnIds.add(turn.id)
    const at = iso(turn.completedAt ? turn.completedAt * 1000 : undefined)
    session.openTurnId = undefined
    session.pendingTurnId = undefined

    /**
     * THE PROJECTION IS FOLDED FROM THE CHANGE THAT IS EMITTED (POD-2811).
     *
     * The line below this block used to read
     * `session.state = { phase: 'idle', ... }`, UNCONDITIONALLY — including for
     * `turn.status === 'failed'`, immediately after emitting a `turn_failed`
     * carrying Codex's own reason, disposition and error text. The daemon's badge
     * is `handle.state()`, "the driver's own folded projection"
     * (`apps/daemon/src/runtime/codex-driver.ts`), so a turn that DIED rendered
     * on the home board as one that FINISHED.
     *
     * That is not a near miss of the catalogue's §6 row — it is the exact shape
     * it names: "a turn that died rendering as finished". POD-2811 measured the
     * sibling of this bug on opencode, where the phase at least went red and only
     * the error class was dropped; here the phase itself was wrong, so a provider
     * failure was indistinguishable from a completed answer.
     *
     * Same fix as opencode's `closeTurn` and the same one grok-acp's `foldState`
     * has always had: build the change once, emit it, and reduce it into the
     * projection with the reducer every consumer downstream uses. A phase written
     * by hand beside an emitted change is a second reducer, and it drifts.
     */
    let change: AgentStateEvent
    if (turn.status === 'failed') {
      const detail = describeTurnError(turn.error)
      publishInterruptMark(session, { kind: 'failed', reason: detail.reason }, at)
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
      change = {
        kind: 'turn_failed',
        errorClass: detail.reason,
        retryable: detail.disposition === 'retryable',
        ...(detail.text ? { detail: detail.text } : {}),
        at,
      }
    } else {
      const verdict = turnStatusToVerdict(turn.status, session.asks.size > 0)
      publishInterruptMark(session, { kind: 'completed', verdict }, at)
      emit(
        session,
        { t: 'turn', ev: { ev: 'completed', turnEpoch: session.turnEpoch, verdict } },
        at,
      )
      change = idleToStateEvent(verdict, at)
    }
    emit(session, { t: 'state', change }, at)
    session.state = reduceAgentState(session.state, change, at)
    for (const wake of [...session.idleWaiters]) wake()
    session.idleWaiters.clear()
    // A steer that was waiting for this turn to open will never get it now.
    for (const wake of [...session.turnOpenWaiters]) wake()
    session.turnOpenWaiters.clear()
    /**
     * NOTHING TO RESUME AT THIS BOUNDARY ANY MORE (POD-2745).
     *
     * A turn closing used to be the moment a deferred fine upgrade could finally
     * be applied: reaching `fine` was a reconnect, a reconnect abandons an open
     * turn, so the demand had to wait here for a safe gap. Which meant the turn
     * a viewer was actually watching — the one they opened the chat during — was
     * always the turn that streamed nothing, and on a session started with an
     * initial prompt that is the FIRST turn, the one people judge the feature by.
     *
     * The handshake no longer decides the level, so there is no upgrade, no
     * deferral, and no boundary to wait for: a fine watch is live the instant
     * `watch()` increments the count, mid-turn or not.
     */
    void drainQueue(session)
  }

  const busy = (session: DriverSession): boolean =>
    session.openTurnId !== undefined || session.pendingTurnId !== undefined

  // -- sending ---------------------------------------------------------------

  /**
   * TWO KINDS, TWO VEHICLES — AND THE OBVIOUS ONE FOR FILES DOES NOT WORK.
   *
   * This mapped every attachment to `localImage` and refused anything that was
   * not an image, on the strength of a declaration reading "Codex accepts image
   * attachments only". POD-2819 measured that against the app-server protocol
   * and it is false: handed a variant it does not know, the server answers
   * `expected one of text, image, localImage, audio, localAudio, skill,
   * mention`.
   *
   * `mention` is the variant that looks made for this — `{ name, path }`, the
   * `@`-mention codex's own TUI builds — AND IT IS DROPPED. The server accepts
   * the part and the model is never shown it. That was measured on the rollout
   * JSONL `thread/start` names, which records the exact input the model was
   * sent: in three shapings of a mention the staged path appears in the prompt
   * zero times, and with the path written into the TEXT it appears. So a file
   * rides in the text, which is also what the terminal driver does and what
   * POD-2777 measured codex passing with on its PTY.
   *
   * ONE `\n`-JOINED TEXT PART RATHER THAN TWO PARTS, because two text parts is
   * a second turn's worth of ambiguity for no gain, and this is the exact shape
   * the web composer produces today (`paths.join('\n') + '\n' + text`).
   *
   * Images keep the typed part: `localImage` puts PIXELS in front of the model,
   * which a path cannot, and that half was never broken.
   */
  const codexInput = (input: TurnInput) => {
    const attachments = input.attachments ?? []
    const images = attachments.filter((attachment) => attachment.kind === 'image')
    const files = attachments.filter((attachment) => attachment.kind !== 'image')
    const text = [...files.map((attachment) => attachment.path), input.text]
      .filter(Boolean)
      .join('\n')
    return [
      ...images.map((attachment) => ({ type: 'localImage', path: attachment.path })),
      { type: 'text', text, text_elements: [] },
    ]
  }

  /** Open a NEW turn. The response IS the acceptance. */
  async function deliver(
    session: DriverSession,
    input: TurnInput,
    origin: SendOptions['origin'] = 'human',
  ): Promise<void> {
    const overrides = input.overrides?.supported ? input.overrides.value : undefined
    const model = overrides?.model ?? modelOf(session.spec)
    const effort = overrides?.effort ?? session.spec.model.effort
    const result = await session.client.call<{ turn?: { id?: string } }>(CODEX_METHODS.turnStart, {
      threadId: session.threadId,
      input: codexInput(input),
      ...(model ? { model } : {}),
      ...(effort && effort !== 'auto' ? { effort } : {}),
    })
    /**
     * THE RESPONSE IS THE ACK AND *NOT* THE OPEN TURN.
     *
     * Measured: `turn/start` answers with a `Turn` whose status is `inProgress`
     * BEFORE the `turn/started` notification arrives, and a `turn/steer` sent in
     * that window is refused with "no active turn to steer". So the id is parked
     * as PENDING here and only becomes the open turn when Codex says it has
     * started. Treating the ack as the open turn is what would make a steer
     * race, and the race is silent because the refusal looks like "the turn
     * already ended".
     */
    session.pendingTurnId = result.turn?.id
    session.turnEpoch += 1
    session.state = { phase: 'working', since: iso(), nativeSubagentCount: 0 }
    /**
     * THE EPOCH IS DURABLE FROM THE MOMENT THE TURN OPENS, not from the moment
     * an event happens to be emitted. Both carriers are written here — the
     * in-process stream position and the journal — because leaving it to
     * `emit()` made the epoch's durability depend on a notification ARRIVING,
     * and a supervisor restart in the window between the ack and the first
     * notification rebound the session at an older epoch. W5's review caught
     * exactly this with its snapshot→adopt round-trip.
     */
    streamPositions.set(session.binding.process.key, {
      seq: session.seq,
      turnEpoch: session.turnEpoch,
    })
    persist(session)
    emit(session, { t: 'turn', ev: { ev: 'started', turnEpoch: session.turnEpoch, origin } }, iso())
  }

  /** The session's sticky model, if it names one. `auto` means Codex's own
   *  default, which is not ours to override. */
  function modelOf(spec: SessionSpec): string | undefined {
    const raw = spec.model.model
    return raw && raw !== 'auto' ? raw : undefined
  }

  /**
   * The MCP declaration, forwarded to the host or omitted entirely.
   *
   * A `Declared<T>` that says UNSUPPORTED means this session has no MCP config —
   * not that it has an empty one — so the field is absent rather than present
   * and falsy. The host's argv builder branches on presence, and an empty inline
   * config would make it mount nothing while looking like it mounted something.
   */
  function mcpOf(spec: SessionSpec): {
    mcpServers?: { transport: 'path'; path: string } | { transport: 'inline'; config: string }
  } {
    return spec.mcpServers.supported ? { mcpServers: spec.mcpServers.value } : {}
  }

  /**
   * THE ONE CALL TO THE HOST'S PORT, AND THE ONE GUARD AROUND IT
   * (POD-2297 review, 2).
   *
   * `endSession` is the FIRST statement of `stop`/`kill`/`hibernate`, and this
   * port is not cheap: the daemon's implementation fsyncs a durable outbox, so
   * ENOSPC, EDQUOT, EIO and a reportId collision all reach here as exceptions.
   * Letting one propagate would skip `client.close()`, `endpoint.stop()` and the
   * map deletes that follow — a live `codex app-server` child with nobody holding it,
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
   * ledger has already recorded as never delivered, which is the silent loss
   * again with a dead-letter row on top of it.
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
   * one place its queue's fate is stated.
   *
   * Every caller used to be a bare `session.disposed = true`: `stop`, `kill`,
   * `hibernate`, `forget`, the runtime's own `dispose`, and the child closing
   * the link under us. All six discarded whatever was parked in the queue, and
   * a `queued` receipt is exactly the custody POD-2291 hands the driver — so all
   * six now say so on the way out.
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
    for (const wake of [...session.turnOpenWaiters]) wake()
    session.turnOpenWaiters.clear()
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
    while (session.queue.length > 0 && !busy(session) && !session.disposed) {
      // A queued turn must not jump an open ask: the session is blocked, and
      // sending into it would bury the question the user has to answer.
      if (session.asks.size > 0) return
      const next = session.queue.shift()
      if (!next) return
      try {
        await deliver(session, next.input, next.options.origin)
      } catch {
        /**
         * THE SEND ITSELF FAILED, AND THE CALLER IS LONG GONE.
         *
         * Still no turn EVENT: the contract is explicit that a consumer told a
         * turn failed believes a turn ran, and this one never opened. What is
         * owed is a RECEIPT CORRECTION — the caller holds a `queued` that was
         * true when issued and is now permanently false — and that is what
         * `abandonTurn` is (POD-2297). Until it existed this `return` was the
         * whole handler and the turn simply ceased to exist.
         *
         * ONLY `next` IS REPORTED. The rest of the queue is still in the queue
         * and may yet drain if the link recovers; if it does not, the disposal
         * that follows reports them as `teardown`. Declaring them lost here
         * would dead-letter turns this driver may still deliver.
         */
        abandonTurn(session, next, 'delivery-failed')
        return
      }
    }
  }

  const waitFor = (
    session: DriverSession,
    set: Set<() => void>,
    predicate: () => boolean,
    timeoutMs: number,
  ): Promise<boolean> =>
    new Promise((resolve) => {
      if (predicate()) {
        resolve(true)
        return
      }
      const done = (value: boolean): void => {
        set.delete(waker)
        clearTimeout(timer)
        resolve(value)
      }
      const waker = (): void => done(predicate())
      const timer = setTimeout(() => done(false), timeoutMs)
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      set.add(waker)
      void session
    })

  const waitForIdle = (session: DriverSession, timeoutMs: number): Promise<boolean> =>
    waitFor(session, session.idleWaiters, () => !busy(session), timeoutMs)

  const waitForOpenTurn = (session: DriverSession, timeoutMs: number): Promise<boolean> =>
    waitFor(session, session.turnOpenWaiters, () => session.openTurnId !== undefined, timeoutMs)

  // -- handle construction ---------------------------------------------------

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
        await host.detachClient?.({ sessionId: session.sessionId })
        session.client.close()
        await session.endpoint.stop()
        handles.delete(session.sessionId)
        sessions.delete(session.sessionId)
      },

      async hibernate() {
        // NEVER REFUSES, and the capability says why: `thread/start` mints the
        // thread id before the first turn, so a resume ref exists from the
        // moment the handle does. The child dies, the conversation does not —
        // it is a rollout file that outlives it, which is exactly what makes a
        // server-family session cheap to park.
        if (!session.binding.resume) return { reason: 'no_resume_ref' as const }
        endSession(session)
        await host.detachClient?.({ sessionId: session.sessionId })
        session.client.close()
        await session.endpoint.stop()
        handles.delete(session.sessionId)
        sessions.delete(session.sessionId)
        return { ok: true as const }
      },

      async kill() {
        endSession(session)
        await host.detachClient?.({ sessionId: session.sessionId })
        session.client.close()
        await session.endpoint.kill()
        host.journal.clear(session.sessionId)
        streamPositions.delete(session.binding.process.key)
        handles.delete(session.sessionId)
        sessions.delete(session.sessionId)
      },

      async health(): Promise<SessionHealth> {
        return sessionHealth({
          // THE CONNECTION IS THE LIVENESS SIGNAL. A closed client means the child is
          // gone or unreachable, which are the same thing for this transport.
          alive: !session.disposed,
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
          interactions: [...session.asks.values()].map((ask) => ask.interaction),
          ...(session.draft ? { draft: session.draft } : {}),
          at: iso(),
        }
      },

      async export(): Promise<SessionArchive> {
        const resume: ResumeRef = session.binding.resume ?? {
          kind: 'codex-thread',
          value: session.threadId,
        }
        /**
         * BYTE-FAITHFUL, AND THAT IS NOT A BOAST — it is what having one file
         * per thread buys. Codex writes each thread to its own rollout JSONL, so
         * the archive is those exact bytes and `codex resume <id>` on the
         * destination reads the same format. W5 had to declare `byteFaithful:
         * false` because opencode's sessions share one sqlite database with no
         * per-session file to copy.
         */
        const bytes = session.rolloutPath
          ? await host.readRollout?.(session.rolloutPath)
          : undefined
        return {
          harness: 'codex',
          formatVersion: 1,
          resume,
          files: bytes
            ? [
                {
                  // Archive-relative, never absolute: an absolute path is a
                  // promise about the DESTINATION machine the source cannot
                  // make.
                  path: `codex/${session.threadId}/rollout.jsonl`,
                  bytes,
                },
              ]
            : [],
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
        // ORDER MATTERS AND IS NOT ARBITRARY. An open ask blocks EVERY delivery,
        // including a queue, because the session is stopped waiting for a human
        // and a turn stacked behind that ask buries it.
        if (session.asks.size > 0) {
          return refuse('needs_user', `${session.asks.size} interaction(s) awaiting an answer`)
        }
        if (
          session.lease?.kind === 'human-controller' &&
          options.principal?.ref !== session.lease.holder
        ) {
          // A human holds the session. Headless drivers QUEUE rather than
          // interleave, and this driver has a real queue — so the nudge lands
          // after the takeover ends instead of being thrown away.
          session.queue.push({ input, options })
          return {
            outcome: 'queued',
            position: session.queue.length,
            deliveredAs: 'queue',
            at: iso(),
          }
        }

        const wanted = options.delivery

        /**
         * STEER: THE ONE DELIVERY NO OTHER DRIVER IN THE FLEET IMPLEMENTS.
         *
         * Only meaningful into a turn that is actually open. Three outcomes, and
         * all three are honest:
         *   - the turn opens in time and Codex accepts the steer → `steer`;
         *   - no turn is running at all → this is an ordinary new turn, so it
         *     falls through and is delivered as `when-ready` would have been;
         *   - Codex refuses the precondition (the turn ended between our check
         *     and the call — a real race, not a hypothetical) → the words go on
         *     the queue and the receipt says `queue`, never `steer`.
         */
        if (wanted === 'steer' && busy(session)) {
          const open = await waitForOpenTurn(session, STEER_OPEN_TIMEOUT_MS)
          const turnId = session.openTurnId
          if (open && turnId) {
            try {
              await session.client.call(CODEX_METHODS.turnSteer, {
                threadId: session.threadId,
                expectedTurnId: turnId,
                input: codexInput(input),
              })
              return {
                outcome: 'accepted',
                // THE SAME EPOCH. A steer joins the open turn rather than
                // opening one, so advancing the epoch would tell every consumer
                // a new turn began and orphan the events still arriving under
                // the old one.
                turnEpoch: session.turnEpoch,
                deliveredAs: 'steer',
                provenBy: 'protocol-ack',
                at: iso(),
              }
            } catch (err) {
              if (!(err instanceof CodexRpcError && err.turnPreconditionFailed)) {
                return refuse('not_running', String(err))
              }
              // The turn ended underneath us. Fall through to the queue, which
              // is what a steer with no turn to steer actually is.
            }
          }
          session.queue.push({ input, options })
          return {
            outcome: 'queued',
            position: session.queue.length,
            // THE DOWNGRADE, REPORTED. `deliveredAs` exists to prevent exactly
            // the silent substitution this line refuses to make.
            deliveredAs: 'queue',
            at: iso(),
          }
        }

        if (wanted === 'queue' && busy(session)) {
          session.queue.push({ input, options })
          return {
            outcome: 'queued',
            position: session.queue.length,
            deliveredAs: 'queue',
            at: iso(),
          }
        }
        if (wanted === 'queue' && session.queue.length > 0) {
          session.queue.push({ input, options })
          return {
            outcome: 'queued',
            position: session.queue.length,
            deliveredAs: 'queue',
            at: iso(),
          }
        }

        if (wanted === 'interrupt' && busy(session)) {
          await interruptOpenTurn(session)
          // Wait for Codex's own confirmation that the turn ended before typing
          // over it. Manufacturing the fence here is exactly what
          // `fenceOnProviderConfirmation` promises not to do.
          await waitForIdle(session, WHEN_READY_TIMEOUT_MS)
        } else if (busy(session)) {
          const idle = await waitForIdle(session, WHEN_READY_TIMEOUT_MS)
          if (!idle) return refuse('busy', 'a turn was still open when the ready window closed')
          if (session.asks.size > 0) return refuse('needs_user')
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
        if (session.disposed) return refuse('not_running')

        try {
          await deliver(session, input, options.origin)
        } catch (err) {
          return refuse('not_running', String(err))
        }
        return {
          outcome: 'accepted',
          turnEpoch: session.turnEpoch,
          // `steer` cannot reach here: it either steered and returned above, or
          // it queued. Every other delivery is what it says it is.
          deliveredAs: wanted === 'steer' ? 'when-ready' : wanted,
          /** The `turn/start` response. The only proof this driver declares, and
           *  the only one it needs. */
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
        if (session.disposed || !busy(session)) return
        await interruptOpenTurn(session)
      },

      async answer(
        interactionId: string,
        answer: unknown,
        options?: AnswerOptions,
      ): Promise<InteractionAnswerOutcome> {
        const ask = session.asks.get(interactionId)
        if (!ask) {
          /**
           * ALREADY-ANSWERED vs UNKNOWN is a real distinction and this driver
           * can draw it, WITHOUT the server round-trip W5 needed. An ask here is
           * an open JSON-RPC request on a connection we own: there is no second party
           * that could have raised one we have not seen, so a `refreshInteractions`
           * against the server would be asking a question whose answer we
           * already hold.
           */
          return session.answered.has(interactionId)
            ? { ok: false, reason: 'already-answered' }
            : { ok: false, reason: 'unknown-interaction' }
        }
        const action = answerAction(
          ask.interaction,
          normalizeAnswer(ask.interaction, answer),
          ask.availableDecisions,
        )
        if (action.call === 'refuse') {
          // A refusal here leaves the ask OPEN and the JSON-RPC request
          // unanswered, which is the point: the session stays visibly blocked
          // rather than reporting an answer that never reached the agent.
          return { ok: false, reason: 'not-yet-supported' }
        }
        try {
          session.client.respond(ask.requestId, action.result)
        } catch {
          return { ok: false, reason: 'not-yet-supported' }
        }
        /**
         * CLOSED HERE, NOT ONLY ON `serverRequest/resolved`.
         *
         * Codex does send that notification, and `ingest` folds it — but closing
         * here too makes `answer()` idempotent from the caller's point of view
         * the instant it returns, rather than "once a notification arrives". A
         * caller that answered and immediately re-read `interactions()` would
         * otherwise still see the ask it just answered. `closeAsk` is a no-op on
         * an id already gone, so the notification arriving second costs nothing.
         */
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
        return [...session.asks.values()].map((ask) => ask.interaction)
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

      /**
       * Refcounted, and FILTERED RATHER THAN NEGOTIATED (spec §5, POD-2745).
       *
       * A PURE COUNT, TAKING EFFECT IMMEDIATELY, which is the whole point. This
       * used to negotiate: `optOutNotificationMethods` is a real protocol knob
       * and muting deltas at the server is strictly cheaper than receiving and
       * discarding them, so the driver used it. But that knob is sent once, at
       * the handshake, so it pinned the level to the CONNECTION — and lifting it
       * meant a reconnect, which abandons an in-flight turn and any outstanding
       * approval. The upgrade could therefore only land in an idle gap, so the
       * turn a viewer opened the chat DURING never streamed. On a session
       * started with an initial prompt that is the first turn there is, and the
       * only one most people ever watch closely, which is why the feature read
       * as broken rather than as having an edge case.
       *
       * WHAT IT COSTS NOW, stated rather than waved at: on a session nobody is
       * watching, `item/agentMessage/delta` still crosses the local pipe from
       * the app-server child and is dropped by the `watchers.fine` guard in
       * `ingest` — before a `seq`, before an emit, before a journal write, and
       * so before anything reaches the daemon, the server or a client. The waste
       * is bytes on a pipe between two processes on one machine, roughly 200 of
       * them per fragment, and it does not scale with viewers, tokens billed, or
       * anything that leaves the host. Reasoning and plan fragments — the bulk
       * of what codex emits — stay muted at the server at every level, since
       * nothing here parses them.
       *
       * AND NOTHING IS ONE-WAY ANY MORE. There is no connection state to leave
       * behind, so the last viewer leaving genuinely stops emission rather than
       * leaving a `fine` connection running until the process ends.
       */
      async watch(level: WatchLevel): Promise<() => void> {
        session.watchers[level] += 1
        let released = false
        return () => {
          // IDEMPOTENT. A viewer that disconnected twice must not drive the
          // refcount negative and leave a fine watch on forever.
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
          const items = await readThreadItems(session)
          /**
           * `before` is the newest window — the same default the on-switch read
           * uses, and what a `history({ limit })` with no anchor means.
           *
           * THE ANCHOR IS A POSITION, NOT A STRING, because `ProviderCursor
           * .components` is `Record<string, number>` by schema. Codex's thread
           * items are a BOUNDED, fully-ordered list, so an index into that order
           * is a real cursor rather than a stand-in. A cursor from another
           * thread carries a different `segmentId` and is refused rather than
           * compared, which is the whole reason the segment is on the cursor.
           */
          if (!range.from) return items.slice(-range.limit)
          if (range.from.segmentId !== session.threadId) return items.slice(-range.limit)
          const anchor = range.from.components.item
          if (anchor === undefined) return items.slice(-range.limit)
          return items.slice(anchor + 1, anchor + 1 + range.limit)
        },
      },

      // ---- attach and lease ----
      async attach(req: AttachRequest): Promise<AttachEndpoint | Refusal> {
        /**
         * THE LEASE IS CHECKED BEFORE THE CLIENT IS STARTED, and both halves of
         * that sentence were wrong here until POD-2085's attach property caught
         * it — the same defect POD-2059 found in the opencode driver, inherited
         * by mirroring its structure.
         *
         * WRONG HALF ONE: this took the lease UNCONDITIONALLY, so a second
         * take-over silently displaced the first — while `lease.acquire()`, a
         * screen below in this same file, refuses that exact case with
         * `lease_held`. One verb handing out for free what its sibling refuses is
         * worse than neither enforcing it, because callers read the refusal and
         * believe it. "Exactly one human-controller holds it" is what makes "the
         * user attached and started typing" and "the steward tried to nudge"
         * impossible to interleave.
         *
         * WRONG HALF TWO: the refusal has to land BEFORE the client terminal
         * starts. Refusing afterwards leaves an orphaned TUI attached to a
         * session it was just denied control of.
         *
         * THE GUARD IS "A DIFFERENT HOLDER", NOT "A LEASE EXISTS". A dropped
         * client reconnecting is the ordinary case, and locking the holder out
         * with their own lease would strand the one person entitled to be there.
         */
        if (req.mode === 'takeover' && session.lease && session.lease.holder !== req.holder) {
          return { reason: 'lease_held', detail: `held by ${session.lease.holder}` }
        }
        if (req.mode === 'takeover' && (busy(session) || session.asks.size > 0)) {
          return {
            reason: busy(session) ? 'busy' : 'needs_user',
            detail: 'Codex can hand its single writer to the native TUI only while idle',
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
        let client: Awaited<ReturnType<NonNullable<typeof host.attachClient>>>
        try {
          /**
           * A BLANK CODEX THREAD IS NOT RESUMABLE YET.
           *
           * `thread/start` returns a persistent thread id and rollout path, but
           * pinned Codex 0.147 does not create the rollout until the first turn
           * or a metadata write. Native-first sessions therefore used to launch
           * the stock TUI as `codex resume <id>` and immediately die with "No
           * saved session found". Naming the thread is Codex's own non-turn
           * persistence operation: it creates the rollout without inventing a
           * user/model message. Do it only when the host proves the rollout is
           * absent, so Chat-first sessions keep Codex's normal inferred name.
           */
          if (
            session.rolloutPath &&
            host.rolloutExists &&
            !(await host.rolloutExists(session.rolloutPath))
          ) {
            await session.client.call(CODEX_METHODS.threadSetName, {
              threadId: session.threadId,
              name: `Podium ${session.sessionId.slice(0, 8)}`,
            })
          }
          client = await host.attachClient?.({
            sessionId: session.sessionId,
            threadId: session.threadId,
            clientAddress: session.endpoint.clientAddress,
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
          // The server family's variant: Codex's OWN TUI pointed at this
          // thread, hosted beside the session rather than being it.
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
           * RELEASING THE LEASE IS A DRAIN EDGE — the same bug the opencode
           * driver had, and this driver inherited it by mirroring that file's
           * structure (POD-2059's review, fixed there in bec3f550).
           *
           * A `queue` that arrived while a human held the take-over lease is
           * parked here rather than refused: the contract's note says headless
           * drivers queue rather than interleave, and W3's F6 is explicit that
           * the nudge lands AFTER the takeover ends. But `drainQueue` otherwise
           * runs only from `closeTurn`, so on an IDLE session the queued turn
           * waits for a turn edge that may never come — the human releases,
           * nothing is running, and the nudge sits there until some unrelated
           * turn happens to complete.
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

      async configure(_request: ConfigureRequest) {
        return {
          reason: 'unsupported' as const,
          detail: 'model and effort are set at thread start and per turn on this driver',
        }
      },

      async usage(): Promise<UsageSnapshot | Refusal> {
        // FROM THE STREAM, NOT A POLL. Codex pushes `thread/tokenUsage/updated`
        // unprompted, so the freshest answer is the one already folded — and an
        // RPC here would be a second source for a number we are given.
        return (
          session.usage ??
          {
            // Not a zero-filled snapshot: a session that has not run a turn has
            // no usage, and reporting zeros would read as "this turn was free".
          }
        )
      },
    }

    return handle
  }

  /** Ask Codex to stop the open turn. Idempotent-ish: a precondition failure
   *  means the turn already ended, which is the outcome we wanted. */
  async function interruptOpenTurn(session: DriverSession): Promise<void> {
    const turnId = session.openTurnId ?? session.pendingTurnId
    if (!turnId) return
    try {
      await session.client.call(CODEX_METHODS.turnInterrupt, {
        threadId: session.threadId,
        turnId,
      })
    } catch (err) {
      if (err instanceof CodexRpcError && err.turnPreconditionFailed) return
      // A failed interrupt is not a failed session; the fence simply never
      // arrives, which is what `interrupt()` returning nothing already means.
    }
  }

  /** The thread's items, as transcript items. `thread/read` is the only history
   *  read this driver makes, and it is made on demand rather than cached. */
  async function readThreadItems(session: DriverSession): Promise<TranscriptItem[]> {
    try {
      const result = await session.client.call<{ thread?: { turns?: unknown[] } }>(
        CODEX_METHODS.threadRead,
        { threadId: session.threadId },
      )
      const turns = Array.isArray(result.thread?.turns) ? result.thread.turns : []
      const items: TranscriptItem[] = []
      for (const turn of turns) {
        const turnItems =
          typeof turn === 'object' &&
          turn !== null &&
          Array.isArray((turn as { items?: unknown }).items)
            ? ((turn as { items: unknown[] }).items as Record<string, unknown>[])
            : []
        for (const item of turnItems) {
          if (typeof item?.type !== 'string' || typeof item?.id !== 'string') continue
          items.push(...threadItemToItems(item as never, undefined))
        }
      }
      return items
    } catch {
      // A history read that fails returns nothing rather than throwing: the
      // caller asked for a window of transcript, and an empty window is a
      // recoverable answer where an exception would take down a chat render.
      return []
    }
  }

  /**
   * Coerce the contract's `unknown` answer into the typed vocabulary.
   *
   * THE CONFORMANCE CORPUS ANSWERS WITH SHORTHAND — `{decision:'allow'}` for a
   * permission — because it is written against every driver at once and predates
   * the typed vocabulary POD-2020 landed. Rather than make the corpus
   * driver-specific, the shorthand is widened HERE, where the ask's kind is
   * known. A payload that is already typed passes through untouched.
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
    if (ask.kind === 'elicitation') {
      return { kind: 'elicitation', action: 'accept', content: {} }
    }
    return { kind: 'recovery', choice: 'full-resume' }
  }

  // -- connection ------------------------------------------------------------

  /**
   * Open a client over an endpoint and complete the handshake at `level`.
   *
   * THE HANDSHAKE IS THE READINESS PROBE. There is no separate health check for
   * this family: `initialize` either answers or the child is not usable, so a
   * handle never comes back before it can be driven.
   */
  async function connect(endpoint: CodexServerEndpoint): Promise<CodexConnection> {
    const make = host.makeClient ?? createCodexClient
    /**
     * THE HANDLERS ARE INDIRECTED THROUGH A MUTABLE SINK, on purpose.
     *
     * The client must exist before the session does — the handshake and
     * `thread/start` both run on it, and the thread id they produce is an input
     * to the session. But notifications and, worse, server→client REQUESTS can
     * arrive in that window. So the client is built with handlers that read a
     * box, and `wire()` fills the box once the session is real.
     */
    const sink: CodexSink = {}
    const client = make({
      transport: endpoint.transport,
      onNotification: (note) => sink.note?.(note),
      onServerRequest: (request) => {
        if (sink.request) {
          sink.request(request)
          return
        }
        // A server→client request before the session is wired would otherwise
        // park a turn forever, since Codex applies no deadline of its own.
        // Refusing lets the agent proceed or fail; dropping it would hang.
        client.respondError(request.id, -32603, 'podium session is not ready to answer')
      },
      onClose: () => sink.closed?.(),
    })
    try {
      await client.handshake({
        clientInfo: { name: 'podium', title: 'Podium', version: '1' },
        capabilities: {
          // Codex gates newer methods behind this; the driver reads only shapes it
          // pinned, so opting in costs nothing and keeps the surface uniform.
          experimentalApi: true,
          requestAttestation: false,
          /**
           * MUTED FOR THE CONNECTION'S LIFE, AND THAT IS WHY THE WATCH LEVEL IS
           * NOT HERE (POD-2745). This list is sent once, at the handshake, so
           * anything on it can only be un-muted by making a new connection —
           * and a new connection abandons an in-flight turn and any outstanding
           * approval. A watch level changes whenever a viewer opens or closes a
           * chat, so it cannot ride a knob that cannot change with it; the
           * driver gates fragments on `watchers.fine` instead, in the ingest arm
           * below, before a fragment costs a `seq`, an emit or a journal write.
           *
           * So what is left on this list is only what the driver never reads at
           * ANY level — reasoning and plan fragments, which have no ingest arm.
           * Nothing the coarse observation plane needs is on it, `turn/completed`
           * and `item/completed` above all, since a fence that was opted out of
           * is a session that never goes idle.
           */
          optOutNotificationMethods: [...DELTA_NOTIFICATIONS],
        },
      })
      return { client, sink }
    } catch (err) {
      client.close()
      throw err
    }
  }

  /** Point a connection's callbacks at a live session. */
  function wire(session: DriverSession, connection: CodexConnection): void {
    connection.sink.note = (note) => ingest(session, note)
    connection.sink.request = (request) => onServerRequest(session, request)
    connection.sink.closed = () => {
      /**
       * THE CHILD WENT AWAY ON ITS OWN.
       *
       * Only reported when the driver did not ask for it: `stop()`, `kill()` and
       * `hibernate()` all set `disposed` before closing, so an expected ending
       * never reaches this line. What is left is a crash or an OOM, which is a
       * PROCESS fact and belongs on the process channel — not a turn failure,
       * because the contract is explicit that conflating a dead process with a
       * failed turn is how ghost sessions happen.
       *
       * `classification: 'crashed'` rather than 'clean': this driver cannot see
       * the exit code from inside the protocol link, and a child that closed it
       * while Podium still held the session is not a clean exit from the
       * session's point of view whatever its status line said.
       */
      if (session.disposed) return
      const ev: ProcessEvent = {
        ev: 'exited',
        code: null,
        signal: null,
        classification: 'crashed',
      }
      emit(session, { t: 'process', ev }, iso())
      endSession(session)
    }
  }

  async function attachSession(input: {
    sessionId: SessionId
    spec: SessionSpec
    endpoint: CodexServerEndpoint
    connection: CodexConnection
    threadId: CodexThreadId
    rolloutPath: string | undefined
    bindingVersion: number
    observerGeneration: number
  }): Promise<AgentSessionHandle> {
    const carried = streamPositions.get(input.endpoint.process.key)
    const journalled = host.journal.read(input.sessionId)
    const session: DriverSession = {
      sessionId: input.sessionId,
      spec: input.spec,
      endpoint: input.endpoint,
      connection: input.connection,
      client: input.connection.client,
      threadId: input.threadId,
      rolloutPath: input.rolloutPath ?? journalled?.rolloutPath,
      binding: {
        sessionId: input.sessionId,
        driver: CODEX_APP_SERVER_DRIVER_ID,
        family: 'server',
        harness: 'codex',
        workdir: input.spec.workdir,
        resume: { kind: 'codex-thread', value: input.threadId },
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
      openTurnId: undefined,
      pendingTurnId: undefined,
      fencedTurnIds: new Set(),
      asks: new Map(),
      answered: new Set(),
      queue: [],
      lease: null,
      draft: '',
      watchers: { coarse: 0, fine: 0 },
      log: [],
      wakers: new Set(),
      state: { phase: 'idle', since: iso(), nativeSubagentCount: 0 },
      disposed: false,
      idleWaiters: new Set(),
      turnOpenWaiters: new Set(),
      usage: undefined,
      title: undefined,
    }
    registerSession(input.sessionId, session)
    wire(session, input.connection)
    persist(session)

    const handle = buildHandle(session)
    handles.set(input.sessionId, handle)
    return handle
  }

  /**
   * Assert the session is riding the ChatGPT subscription rather than an
   * inherited API key.
   *
   * WHY THIS IS A DRIVER CONCERN AND NOT ONLY A SPAWN ONE. The daemon strips
   * `OPENAI_API_KEY` and friends from the child's env, which is the mechanism;
   * this is the VERIFICATION, and the two are not the same thing. Codex resolves
   * credentials from several places (env, `~/.codex/auth.json`, a config-named
   * store), so an env strip proves what we did, not what Codex chose. The
   * acceptance criterion is that the subscription demonstration is "proven NOT
   * to ride an inherited API key", and only asking the server can prove that.
   *
   * REPORTED, NOT ENFORCED: an `apikey` session still works, and refusing to
   * start one would break the perfectly legitimate API-key user. The report goes
   * to the HOST rather than onto the event stream, because `ProcessEvent` has
   * three arms — `exited`, `oomKilled`, `adopted` — and none of them means "this
   * session is on a different credential than expected". Widening a vocabulary
   * every consumer branches on, so that one driver can carry one diagnostic,
   * costs more than it buys; the fact goes to whoever owns surfacing instead.
   */
  async function assertAuthMode(session: DriverSession): Promise<void> {
    try {
      const status = await session.client.getAuthStatus()
      host.reportAuthMode?.({
        sessionId: session.sessionId,
        authMethod: status.authMethod ?? undefined,
        subscription: status.authMethod === CHATGPT_AUTH_METHOD,
      })
    } catch {
      // A failed probe is not a failed session. Saying nothing beats claiming an
      // auth mode we could not read.
    }
  }

  async function createWithId(
    sessionId: SessionId,
    spec: SessionSpec,
  ): Promise<AgentSessionHandle> {
    const endpoint = await host.launch({
      sessionId,
      workdir: spec.workdir,
      ...(spec.env ? { env: spec.env } : {}),
      ...mcpOf(spec),
    })
    const connection = await connect(endpoint)
    /**
     * `thread/start` BEFORE the first turn is what gives this family
     * `resumeRefTiming: 'spawn'` — and therefore a `hibernate()` that never has
     * to refuse. It also returns the rollout `path`, which is what makes
     * `export()` byte-faithful.
     */
    const started = await connection.client.call<{
      thread?: { id?: string; path?: string | null }
    }>(CODEX_METHODS.threadStart, {
      cwd: spec.workdir,
      ...(modelOf(spec) ? { model: modelOf(spec) } : {}),
    })
    const threadId = started.thread?.id
    if (!threadId) {
      connection.client.close()
      await endpoint.kill()
      throw new Error('codex app-server did not return a thread id from thread/start')
    }
    const handle = await attachSession({
      sessionId,
      spec,
      endpoint,
      connection,
      threadId,
      rolloutPath: started.thread?.path ?? undefined,
      bindingVersion: 1,
      observerGeneration: 1,
    })
    const session = sessions.get(sessionId)
    if (session) await assertAuthMode(session)
    if (spec.initialPrompt) {
      await handle.send({ text: spec.initialPrompt }, { origin: 'human', delivery: 'when-ready' })
    }
    return handle
  }

  /** Start a fresh app-server and rejoin an existing thread on it. The one
   *  primitive behind `resume()`, `adopt()` and the fine-watch upgrade. */
  async function resumeThread(input: {
    sessionId: SessionId
    spec: SessionSpec
    threadId: CodexThreadId
    bindingVersion: number
    observerGeneration: number
  }): Promise<AgentSessionHandle> {
    const endpoint = await host.launch({
      sessionId: input.sessionId,
      workdir: input.spec.workdir,
      ...(input.spec.env ? { env: input.spec.env } : {}),
      ...mcpOf(input.spec),
    })
    const connection = await connect(endpoint)
    const resumed = await connection.client.call<{
      thread?: { id?: string; path?: string | null }
    }>(CODEX_METHODS.threadResume, { threadId: input.threadId })
    return attachSession({
      sessionId: input.sessionId,
      spec: input.spec,
      endpoint,
      connection,
      // The RESUMED thread's own id. Codex returns the thread it loaded, and
      // trusting our input over its answer is how a driver ends up addressing a
      // thread the server does not think it opened.
      threadId: resumed.thread?.id ?? input.threadId,
      rolloutPath: resumed.thread?.path ?? undefined,
      bindingVersion: input.bindingVersion,
      observerGeneration: input.observerGeneration,
    })
  }

  const adoptedSpec = (workdir: string, model: ModelPolicy = {}): SessionSpec => ({
    harness: 'codex',
    selection: {
      auth: 'subscription',
      platform: 'linux',
      available: [CODEX_APP_SERVER_DRIVER_ID],
    },
    workdir,
    // NOT `{}` — see {@link CodexJournalEntry.model}. Instructions and MCP
    // below stay unsupported because the resumed thread genuinely carries its
    // own; the model does not, it is sent per turn.
    model,
    instructions: { supported: false, reason: 'adopted session carries its own context' },
    mcpServers: { supported: false, reason: 'adopted session carries its own config' },
  })

  const driver: RuntimeDriver = {
    id: CODEX_APP_SERVER_DRIVER_ID,
    harness: 'codex',
    family: 'server',
    capabilities: () => capabilities,

    async create(spec: SessionSpec): Promise<AgentSessionHandle> {
      return createWithId(host.mintSessionId(), spec)
    },

    async resume(ref: ResumeRef, spec: SessionSpec): Promise<AgentSessionHandle> {
      const sessionId = host.mintSessionId()
      const previous = host.journal.read(sessionId)?.bindingVersion ?? 0
      return resumeThread({
        sessionId,
        spec,
        threadId: ref.value,
        bindingVersion: previous + 1,
        observerGeneration: previous + 1,
      })
    },

    /**
     * REBIND AFTER A SUPERVISOR RESTART — by resuming, because there is nothing
     * left to rebind to. The full argument is in this file's header: the child
     * remains lifetime-tethered to the daemon's stdin even though JSON-RPC rides
     * its Unix listener, so it dies with the daemon. The thread on disk survives.
     *
     * THE JOURNAL IS STILL CHECKED FOR EXACT IDENTITY, and that is not
     * ceremonial: a binding whose journal entry names a different process key
     * describes a DIFFERENT incarnation of this session, and resuming its thread
     * would attach this session id to someone else's conversation — the same
     * failure the contract's "exact identity or nothing" rule exists to prevent,
     * arriving by a different route.
     */
    async adopt(binding: SessionBinding): Promise<AgentSessionHandle> {
      const journalled = host.journal.read(binding.sessionId)
      if (!journalled) {
        throw new Error(
          `codex-app-server cannot adopt ${binding.sessionId}: no binding journal entry to rebind from`,
        )
      }
      if (journalled.process.key !== binding.process.key) {
        throw new Error(
          `codex-app-server cannot adopt ${binding.sessionId}: journal names process ${journalled.process.key}, binding names ${binding.process.key}`,
        )
      }
      const handle = await resumeThread({
        sessionId: binding.sessionId,
        spec: adoptedSpec(journalled.workdir, journalled.model),
        threadId: journalled.threadId,
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
    handleFor: (sessionId) => handles.get(sessionId),
    bindings: () => [...handles.values()].map((handle) => handle.binding),
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
      // The HANDLE dies; the PROCESS does not — not because it survives, but
      // because killing it is not `forget`'s job. What a supervisor restart
      // looks like from in here.
      endSession(session)
      session.client.close()
      sessions.delete(sessionId)
      handles.delete(sessionId)
    },
    dispose: () => {
      for (const session of sessions.values()) {
        endSession(session)
        session.client.close()
      }
      sessions.clear()
      handles.clear()
      streamPositions.clear()
    },
  }
}
