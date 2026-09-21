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
 * - The Driver handle registry stays in the machine runtime for now: handles
 *   are still keyed per session and never shared, which is the ownership fact
 *   that matters; moving the map is a separate mechanical step.
 * - The applied-size RECORD (`AppliedGeometryRecord`) stays daemon-wide: the
 *   bind builder reads it, and the Terminal mirrors the same fact in
 *   `terminal.applied`. One fact, two readers, written at the same apply sites.
 * - The screen lives here (created on first use, surviving park/reattach,
 *   dropped when the terminal goes away) and the Terminal holds it while
 *   attached — so Draft Sync and the observers keep reading the ONE
 *   TerminalScreen, and no second emulator is created anywhere.
 */

import type { Geometry, SessionId } from '@podium/model'
import { TerminalScreen } from '@podium/process/screen'
import type { Terminal } from '../terminal/terminal.js'

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
  timer?: unknown
  /** An adopted master must ACK one replay redraw without forwarding it. */
  suppressNextReplayRedraw?: boolean
  /** The parked master evolved while no relay was attached: repaint on return. */
  replayRequired?: boolean
  /** The next client continues the same surface: no scrollback-clear anchor. */
  preserveReplayOnRelaunch?: boolean
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

  /** The client-terminal policy, while a native client is attached, parked
   *  warm, or starting. Undefined otherwise; the relay disarms its timer first. */
  client: ClientTerminalPolicy | undefined = undefined

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
  }
}
