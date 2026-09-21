/**
 * THE TERMINAL — the surface over one process (POD-4434, layers §1b/§2).
 *
 * One attachment + one screen + the applied size, referring to (never owning)
 * the process it shows. The Session owns the process (its durable label, kept
 * alive on the host across daemon restarts); the Terminal owns the live
 * attachment over it — the connection object whose disposal DETACHES, never
 * reaps. Parking drops the Terminal and keeps the process; resume rebuilds a
 * Terminal over the same process from the host's replay cursor.
 *
 * THE ONLY implementation of opening, adopting, parking, reaping and closing
 * anything with a pty, together with the Session: the headed bridge path
 * (`control/session.ts`) and the native-client path (`runtime/opencode-attach.ts`)
 * both construct their surface through {@link Terminal.attach} and retire it
 * through {@link Terminal.park}. There is exactly one Terminal per Session at
 * a time, because the terminal stream is keyed by session id.
 *
 * IMPORT DIRECTION (layers table): may import DurableAttachment, TerminalScreen
 * and protocol terminal frames. Must never import the durable door, any
 * driver, agent-runtime or harness manifests — a surface cannot open or reap
 * a process, and knows nothing about what the bytes mean.
 */

import type { Geometry } from '@podium/model'
import { type DurableAttachment, withHardRepaint } from '@podium/process/screen'
import type { TerminalScreen } from '@podium/process/screen'

/**
 * The fan-out one Terminal drives. The Terminal feeds its screen and calls
 * these; the caller (bridge wiring or client-terminal relay) owns what each
 * sink does with the bytes. Screen feeding stays OUTSIDE the Terminal on
 * purpose: the headed and native relays feed the session screen through their
 * own funnels today (wireBridge's observer/scheduler tap, the session-addressed
 * frames relay), and moving those funnels is not this issue's work — the rule
 * this object enforces is that both paths HOLD the same one screen, never a
 * second emulator.
 */
export interface TerminalEvents {
  onFrame(data: Uint8Array): void
  onTitle?(title: string): void
  onExit?(code: number): void
}

/**
 * Which surface this Terminal is: the headed agent/shell pty, or the native
 * client TUI of a server-family session. Exactly one Terminal per session, and
 * the kind tells the resize/redraw/input handlers which arm a live surface
 * takes: a headed surface applies synchronously like a bridge always did, a
 * client surface acknowledges through the client-terminal host. The input
 * paths likewise only ever take a headed surface for automation bytes — a
 * client TUI accepts human keystrokes only.
 */
export type TerminalKind = 'headed' | 'client'

export interface TerminalOptions {
  /** Which surface this is. Defaults to the headed agent/shell pty. */
  kind?: TerminalKind
  /**
   * Reattaching a shell: `redraw()` defaults to the hard Ctrl-L repaint (idle
   * shells ignore the SIGWINCH nudge). TUIs repaint on resize and must not get
   * a stray ^L in their input — leave it off for them. An explicit
   * `redraw({ hard })` always wins. This is the shell hard-repaint-on-reattach
   * rule, as a Terminal option rather than a second attach path.
   */
  hardRepaint?: boolean
}

/**
 * A Terminal over a process the caller keeps owning.
 *
 * `screen` is the session's ONE TerminalScreen (owned by the Session, held
 * here while attached so observers and drivers read it through the Terminal).
 * `applied` mirrors the size this surface put the program at — the Terminal
 * never decides one, the apply sites record it here next to the record they
 * already write.
 */
export class Terminal {
  readonly attachment: DurableAttachment
  readonly screen: TerminalScreen
  readonly kind: TerminalKind
  /** The grid this surface put the program at, when it put it at one. */
  applied: Geometry | undefined

  private readonly unwire: Array<() => void> = []
  private settled = false

  private constructor(
    attachment: DurableAttachment,
    screen: TerminalScreen,
    events: TerminalEvents,
    kind: TerminalKind,
  ) {
    this.kind = kind
    this.attachment = attachment
    this.screen = screen
    this.unwire.push(
      attachment.onFrame((frame) => {
        if (!this.settled) events.onFrame(frame.data)
      }),
    )
    if (events.onTitle) {
      const onTitle = events.onTitle
      this.unwire.push(attachment.onTitle((title) => {
        if (!this.settled) onTitle(title)
      }))
    }
    if (events.onExit) {
      const onExit = events.onExit
      this.unwire.push(attachment.onExit((code) => {
        if (!this.settled) onExit(code)
      }))
    }
  }

  /**
   * THE ONE function that constructs a Terminal (POD-4434): headed open and
   * reattach and native client open/re-adopt all come through here. Takes the
   * live attachment and the session's screen; opens nothing, reaps nothing.
   */
  static attach(
    attachment: DurableAttachment,
    screen: TerminalScreen,
    events: TerminalEvents,
    opts: TerminalOptions = {},
  ): Terminal {
    const live = opts.hardRepaint ? withHardRepaint(attachment, true) : attachment
    return new Terminal(live, screen, events, opts.kind ?? 'headed')
  }

  get pid(): number {
    return this.attachment.pid
  }

  get adopted(): boolean | undefined {
    return this.attachment.adopted
  }

  /** Kernel-reported size after the last acknowledgement, when the backend says. */
  get readSize(): Geometry | undefined {
    return this.attachment.appliedGeometry
  }

  get live(): boolean {
    return !this.settled
  }

  write(data: Uint8Array): void {
    if (this.settled) return
    this.attachment.writeBytes(data)
  }

  /** Legacy base64 input boundary (the driver bridge port). */
  writeBase64(dataBase64: string): void {
    if (this.settled) return
    this.attachment.write(dataBase64)
  }

  resize(cols: number, rows: number): void {
    if (this.settled) return
    this.attachment.resize(cols, rows)
  }

  /**
   * Resize and answer what the backend ACKNOWLEDGED. Answers NOW (a plain
   * Geometry) where the backend offers no acknowledgement — the fire-and-forget
   * resize IS the apply there. Answers LATER (a promise) where one can differ.
   * `undefined` when the acknowledgement never arrived: the caller must hold
   * the request, not record the ask.
   */
  resizeAcknowledged(
    cols: number,
    rows: number,
  ): Geometry | Promise<Geometry | undefined> | undefined {
    if (this.settled) return undefined
    if (!this.attachment.resizeAcknowledged) {
      this.attachment.resize(cols, rows)
      return { cols, rows }
    }
    return this.attachment.resizeAcknowledged(cols, rows)
  }

  redraw(opts?: { hard?: boolean }): void {
    if (this.settled) return
    this.attachment.redraw(opts)
  }

  /** Queue a repaint until the transport acknowledges attachment, where supported. */
  redrawWhenReady(): void {
    if (this.settled) return
    this.attachment.redrawWhenReady?.()
  }

  /** Host-only replay port for the joint-restart hole; false when unsupported. */
  async replay(tailBytes: number): Promise<boolean> {
    if (this.settled) return false
    const replay = (
      this.attachment as DurableAttachment & {
        replay?: (tailBytes: number) => Promise<void>
      }
    ).replay
    if (!replay) return false
    await replay.call(this.attachment, tailBytes)
    return true
  }

  get replayable(): boolean {
    return (
      typeof (
        this.attachment as DurableAttachment & {
          replay?: (tailBytes: number) => Promise<void>
        }
      ).replay === 'function'
    )
  }

  /**
   * PARK: drop the Terminal, keep the process. Unwires every callback and
   * disposes the attachment — a DETACH on the host, an attach-client exit on
   * abduco — while the durable master and the program inside it live on. The
   * screen, the labels, the pending resize and the replay cursor stay with the
   * Session; resume rebuilds a Terminal over the same process.
   */
  park(): void {
    if (this.settled) return
    this.settled = true
    for (const off of this.unwire.splice(0)) {
      try {
        off()
      } catch {
        // Unwiring is best-effort bookkeeping on a teardown path.
      }
    }
    try {
      this.attachment.dispose()
    } catch {
      // The connection is already gone; the master it left behind is what parks.
    }
  }
}
