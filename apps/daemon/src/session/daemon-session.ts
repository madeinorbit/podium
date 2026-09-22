/**
 * THE DAEMON-SIDE SESSION MIRROR (POD-4434, layers §1b/§2): one object per
 * session that OWNS its durable process label(s), its Terminal if any, its
 * screen, its held resize and its replay cursor — replacing the per-session
 * maps on DaemonContext (bridges, durableLabels, pendingResizes, the screen
 * registry).
 *
 * OWNERSHIP (layers page §1b): the Session owns every process, the Terminal
 * and the Driver; the Terminal is over a process; the Driver uses a Terminal
 * (headed) or an address (headless). Nothing changes owner in park, resume,
 * upgrade or native attach.
 *
 * SCOPE NOTES, stated so the next lane does not re-litigate them:
 * - The Driver handle lives ON the entry (`driver` below): handles are still
 *   keyed per session and never shared, which is the ownership fact that
 *   matters; the terminal driver's per-session index is moving onto this slot
 *   as the mechanical follow-up (POD-4512).
 * - The applied-size RECORD (`AppliedGeometryRecord`) stays daemon-wide: the
 *   bind builder reads it, and the Terminal mirrors the same fact in
 *   `terminal.applied`. One fact, two readers, written at the same apply sites.
 * - The screen lives here (created on first use, surviving park/reattach,
 *   dropped when the terminal goes away) and the Terminal holds it while
 *   attached — so Draft Sync and the observers keep reading the ONE
 *   TerminalScreen, and no second emulator is created anywhere.
 */

import { randomUUID } from 'node:crypto'
import type {
  AbandonedQueuedTurn,
  AgentSessionHandle,
  EngineBindUnrecoverable,
} from '@podium/harness/driver/host'
import { createLogger } from '@podium/logger'
import type { Geometry, SessionId } from '@podium/model'
import type { DaemonMessage, QueueDrainAbandonedReason } from '@podium/protocol/daemon'
import { TerminalScreen } from '@podium/process/screen'
import type { Terminal } from '../terminal/terminal.js'

const log = createLogger('daemon:session')

/** The size a screen is born at when nothing applied one yet. */
const DEFAULT_MODEL_SIZE = { cols: 80, rows: 24 } as const

export interface DaemonSessionInit {
  sessionId: SessionId
  /** The primary durable label, when an authoritative source set one. */
  label?: string
}

/**
 * Client-terminal policy for a server-family session (POD-4505): what the
 * native-client relay remembers between calls. Lives ON the entry so the
 * relay holds no per-session map; `watched`/`clientLabel` alongside it are
 * the pre-existing shared fields. `kind` stays a string so this layer takes
 * no harness dependency; the relay narrows it at its one use.
 */
export interface ClientTerminalPolicy {
  /** Durable label of this session's client master. Mirrored onto the entry's
   *  `clientLabel`; read here so teardown still names the master after the
   *  policy is retired. */
  label: string
  kind: string
  /** In-flight start, so two concurrent attaches produce ONE client. */
  starting?: Promise<Terminal>
  /** The one Native generation allowed to accept input, plus what arrived
   *  while its process was starting. Replaced on every start. */
  generation?: { acceptingInput: boolean; pendingInput: Uint8Array[]; pendingBytes: number }
  /** An adopted master must ACK one replay redraw without forwarding it. */
  suppressNextReplayRedraw?: boolean
  /** The parked master evolved while no relay was attached: repaint on return. */
  replayRequired?: boolean
  /** The next client continues the same surface: no scrollback-clear anchor. */
  preserveReplayOnRelaunch?: boolean
}

/**
 * THE ENGINE §4.8 KEPT ALIVE (POD-4490): a driver family reported
 * `EngineBindUnrecoverable` — the engine process is up, its protocol channel
 * is dead, and the family deliberately kept the process (never silently
 * orphaned, never quietly reaped) with the journal untouched.
 *
 * What is recorded here is the ERROR'S IDENTITY — the session, the address the
 * engine answers on, and the loopback credential where the transport has one —
 * so a later adopt-or-reap pass can find the survivor without guessing. The
 * secret rides the record, never the message and never the log: the surfaced
 * failure names the address, the credential stays in this field.
 */
export interface KeptEngineRecord {
  /** Where the live-but-undriveable engine answers (the error's address). */
  readonly address: string
  /** Fresh bind or adopt rebind: which surface went out with this record. */
  readonly during: 'launch' | 'adopt'
  /** Loopback credential, when the transport has one. Never logged. */
  readonly secret?: string
  /** When the lifecycle owner recorded it. */
  readonly at: string
}

/** What `DaemonSession.bindFailed` needs beyond the error itself. */
export interface BindFailureInput {
  /**
   * A PRIOR DRIVER'S queue, when one exists to drain — the `OnQueueAbandoned`
   * input minus the session id, reported through the same durable frame the
   * families' own `reportQueueAbandonment` emits.
   *
   * ABSENT IS THE COMMON CASE, and absent is correct, not a gap. Custody of a
   * turn lives exactly one place at a time: an unbound send is REFUSED, never
   * queued (`runtimeHandlers.runtimeSendRequest` answers `not_running` with no
   * handle), so a session no driver ever held has nothing to invalidate — and
   * reporting abandonment there would manufacture dead-letter rows for turns
   * the server still legitimately owns and may still deliver. Where a prior
   * driver holds queued turns its own teardown/displacement reports them
   * through the same port; this daemon never takes custody by inventing ids.
   */
  readonly abandoned?: {
    readonly turns: readonly AbandonedQueuedTurn[]
    readonly reason: QueueDrainAbandonedReason
  }
  /** Harness name for the abandonment log line (the `family` queue-report.ts logs). */
  readonly family: string
}

/** The wire the bind-failure report leaves on. */
export interface BindFailurePorts {
  send(msg: DaemonMessage): void
}

/** What `DaemonSession.bindFailed` did, stated so callers skip their own fallbacks. */
export interface BindFailureReport {
  /** `spawnError` (fresh) or `reattachFailed` (adopt) went out. Always true. */
  readonly surfaced: true
  /** A `runtimeQueueDrainAbandoned` frame went out: false when no turn id existed. */
  readonly abandonmentReported: boolean
  /** The kept engine was recorded from the error identity: false with no address. */
  readonly engineRecorded: boolean
}

export class DaemonSession {
  readonly sessionId: SessionId
  /**
   * Primary durable label — the process identity, set only from authoritative
   * sources (spawn/reattach/steal frames, wireBridge). NEVER a default: a
   * stamped default would trip the reattach identity guard for a session this
   * daemon never owned. Readers fall back to the daemon's label function.
   */
  label: string | undefined
  /**
   * Client-TUI label (`podium-<token>-attach-<id>`), once a native client was
   * opened for a server-family session. Never contains the session's own
   * label: memory attribution walks `/proc` by label substring, so a suffix
   * shape would bill the whole client TUI as the agent's memory.
   */
  clientLabel: string | undefined = undefined
  /** The ONE live surface. Set while attached; undefined while parked. */
  terminal: Terminal | undefined = undefined
  /** A viewer ask that arrived while no terminal could apply it (POD-628). */
  pendingResize: Geometry | undefined = undefined
  /**
   * The host ring resume reader: the seq after the last output byte this
   * daemon saw. Set while a host attachment is live; `tail` when unknown.
   */
  seqReader: (() => bigint | undefined) | undefined = undefined
  /**
   * Bumped every time the terminal is parked or dropped. Lets in-flight async
   * work (a spawn racing a close, a reattach racing a reattach) detect it lost.
   */
  epoch = 0
  /**
   * Whether a viewer currently renders this session. Drives the warm-TTL
   * policy: watched is not idle, and a watched terminal is never reclaimed
   * under pressure.
   */
  watched = false
  /**
   * The §4.8 survivor, when a bind failure kept one: the error's identity
   * (address, credential, phase), recorded so a later adopt-or-reap pass can
   * find the engine the family deliberately left running. Set only by
   * {@link DaemonSession.bindFailed}; `undefined` is the common case (bound
   * sessions, and failures that name no address, record nothing).
   */
  keptEngine: KeptEngineRecord | undefined = undefined

  /** The client-terminal policy, while a native client is attached, parked
   *  warm, or starting. Undefined otherwise. */
  client: ClientTerminalPolicy | undefined = undefined
  /** Whether Native is requested (admission: a stream descriptor alone grants no input). */
  nativeRequested = false
  /** In-flight attach/release transition, so concurrent reconciles produce ONE. */
  nativeTransition: Promise<void> | undefined = undefined
  /** Transient refusals spent (POD-2489); undefined = nothing owed. */
  nativeRetryCount: number | undefined = undefined

  /**
   * THE SESSION'S DRIVER (POD-4512, layers §1b / spec §4.6): the ONE live
   * driver handle for this session, replacing the machine runtime's
   * per-session handle index. Set when the session binds (terminal register,
   * server create/resume/adopt); undefined while unbound or after teardown.
   * Never shared between two entries — one handle, one slot — which is the
   * ownership fact the keyed map used to carry.
   */
  driver: AgentSessionHandle | undefined = undefined

  /**
   * THE §4.8 ENGINE POLICY (spec §4.8 steps 2–6): the per-session half of
   * engine ownership lives here — the kept-engine record and `bindFailed`
   * below. The process acts themselves (spawn, re-attach, probe, reap) live
   * on the session layer's daemon-wide `SessionEngineScope`
   * (`session/engines.ts`), handed to the families directly by the
   * composition root. The entry holds no scope and exposes no engine verb:
   * a forwarding delegate would add a hop and no decision.
   */

  private screenState: TerminalScreen | undefined = undefined

  constructor(init: DaemonSessionInit) {
    this.sessionId = init.sessionId
    this.label = init.label
  }

  /** The process identity: the owned label, else the daemon's default for the id. */
  labeled(labelFor: (sessionId: SessionId) => string): string {
    return this.label ?? labelFor(this.sessionId)
  }

  /** Whether a live surface is attached right now. */
  get attached(): boolean {
    return this.terminal !== undefined
  }

  /** This session's screen, creating it at the default size on first use. */
  screen(): TerminalScreen {
    let screen = this.screenState
    if (!screen) {
      screen = new TerminalScreen({ cols: DEFAULT_MODEL_SIZE.cols, rows: DEFAULT_MODEL_SIZE.rows })
      this.screenState = screen
    }
    return screen
  }

  /** The screen when one was already created, without creating it. */
  peekScreen(): TerminalScreen | undefined {
    return this.screenState
  }

  /**
   * PARK: drop the Terminal, keep the process. The attachment detaches (the
   * master and its program survive), while the labels, the screen, the held
   * resize and the replay cursor stay — resume rebuilds a Terminal over the
   * same process. Returns the dropped Terminal, if there was one.
   */
  park(): Terminal | undefined {
    const live = this.terminal
    this.terminal = undefined
    this.epoch += 1
    live?.park()
    return live
  }

  /**
   * The terminal went away with the program (bridge-exit path): the screen
   * died with it. A restart rebuilds approximately. Parked sessions keep
   * theirs — only the terminal-going-away path calls this.
   */
  dropScreen(): void {
    try {
      this.screenState?.dispose()
    } catch {
      // Disposal is best-effort bookkeeping on a teardown path.
    }
    this.screenState = undefined
  }

  /** The session is going away: drop the surface and forget per-session state. */
  clear(): void {
    this.park()
    this.dropScreen()
    this.pendingResize = undefined
    this.seqReader = undefined
    this.clientLabel = undefined
    this.client = undefined
    this.keptEngine = undefined
    this.nativeRequested = false
    this.nativeRetryCount = undefined
    // LAST, in the §4.8 step 6 order: the handle's own teardown runs against a
    // caller-held reference (stopSessionProcessOnce reads it before parking),
    // so forgetting the slot here cannot strand a teardown — it only stops a
    // later lookup from reaching a dead handle.
    this.driver = undefined
  }

  /**
   * THE §4.8 BIND-FAILURE ARM (POD-4490, spec §4.8 step 4): a driver family
   * reported `EngineBindUnrecoverable` — engine up, protocol dead, process
   * KEPT with the journal untouched. The lifecycle owner does three things:
   *
   * (a) INVALIDATE PENDING TURNS, when a prior driver's queue exists to
   * drain. The entries go out as a `runtimeQueueDrainAbandoned` frame — the
   * same durable, at-least-once receipt correction the families' own
   * `reportQueueAbandonment` emits, through the same `send` (the daemon's
   * outbox fsyncs it before it returns), with the same rules: turns with no
   * caller-supplied id are logged but not framed (a report naming nothing
   * corrects nothing; a synthetic id would correct a row that does not
   * exist), and no entries means no frame at all. See `BindFailureInput`
   * for why absent is correct rather than a gap.
   *
   * (b) RECORD THE KEPT ENGINE from the error identity (address, credential,
   * phase) on {@link DaemonSession.keptEngine}, so a later in-daemon pass
   * can adopt-or-reap the survivor instead of rediscovering it. Failures that
   * name no address record nothing: there is no survivor to find. Survives
   * the daemon's life, not a restart — cross-restart adoption still relies on
   * whatever the family journalled at launch.
   *
   * (c) SURFACE THE FAILURE on the frame the UI already renders: `spawnError`
   * for a fresh bind, `reattachFailed` for an adopt rebind (the fresh/adopt
   * split `engine-supervision.ts` documents). The message is the error's own —
   * it names the session, the phase and the address, and never the secret.
   *
   * THE LOG COMES FIRST, AND THAT ORDER IS LOAD-BEARING (the rule
   * `queue-report.ts` pins): `send` can throw (ENOSPC, a reportId collision),
   * and the only thing that makes a lost report recoverable is that the
   * abandonment was already said out loud. Do not move it below `send`.
   */
  bindFailed(
    error: EngineBindUnrecoverable,
    input: BindFailureInput,
    ports: BindFailurePorts,
  ): BindFailureReport {
    const turns = input.abandoned ? [...input.abandoned.turns] : []
    const turnIds = turns.flatMap((turn) => (turn.input.id ? [turn.input.id] : []))
    if (input.abandoned) {
      log.warn('queued turns were never delivered', {
        family: input.family,
        sessionId: this.sessionId,
        reason: input.abandoned.reason,
        turns: turns.length,
        turnIds,
        ...(turnIds.length === turns.length
          ? {}
          : { unattributed: turns.length - turnIds.length }),
      })
    } else {
      log.warn('engine is up but its protocol did not bind; keeping the engine', {
        sessionId: this.sessionId,
        family: input.family,
        during: error.during,
        ...(error.address ? { address: error.address } : {}),
      })
    }
    let abandonmentReported = false
    if (input.abandoned && turnIds.length > 0) {
      ports.send({
        type: 'runtimeQueueDrainAbandoned',
        reportId: randomUUID(),
        sessionId: this.sessionId,
        turnIds,
        reason: input.abandoned.reason,
      })
      abandonmentReported = true
    }
    let engineRecorded = false
    if (error.address) {
      this.keptEngine = {
        address: error.address,
        during: error.during,
        ...(error.secret !== undefined ? { secret: error.secret } : {}),
        at: new Date().toISOString(),
      }
      engineRecorded = true
    }
    if (error.during === 'adopt') {
      ports.send({ type: 'reattachFailed', sessionId: this.sessionId, reason: error.message })
    } else {
      ports.send({ type: 'spawnError', sessionId: this.sessionId, message: error.message })
    }
    return { surfaced: true, abandonmentReported, engineRecorded }
  }
}
