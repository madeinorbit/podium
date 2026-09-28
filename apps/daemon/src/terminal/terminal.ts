/**
 * THE TERMINAL — the surface over one process (POD-4434, layers §1b/§2).
 *
 * One attachment + one screen, referring to (never owning)
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
import type { DurableAttachment } from '@podium/process/screen'
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
  /**
   * THE SIZE EVENT (POD-4723, design rev 3): the kernel's size, as the host
   * stated it (WELCOME, RESIZED). Fired once at attach with the size the
   * connection already holds — WELCOME usually arrives before the Terminal
   * exists — and then on every RESIZED. Never fired by an ask, and never on a
   * backend that cannot read its size back.
   */
  onSize?(size: Geometry): void
}

/**
 * Which surface this Terminal is: the headed agent/shell pty, or the native
 * client TUI of a server-family session. Exactly one Terminal per session.
 * Sizing does not branch on it (POD-4723: one ask, one size event for both);
 * the input paths do — they only ever take a headed surface for automation
 * bytes, since a client TUI accepts human keystrokes only.
 */
export type TerminalKind = 'headed' | 'client'

export interface TerminalOptions {
  /** Which surface this is. Defaults to the headed agent/shell pty. */
  kind?: TerminalKind
}

/**
 * A Terminal over a process the caller keeps owning.
 *
 * `screen` is the session's ONE TerminalScreen (owned by the Session, held
 * here while attached so observers and drivers read it through the Terminal).
 * It holds no size of its own: {@link size} reads the connection's, which only
 * the host writes (POD-4723).
 */
export class Terminal {
  readonly attachment: DurableAttachment
  readonly screen: TerminalScreen
  readonly kind: TerminalKind

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
    if (events.onSize && attachment.onSize) {
      const onSize = events.onSize
      this.unwire.push(attachment.onSize((size) => {
        if (!this.settled) onSize(size)
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
    const terminal = new Terminal(attachment, screen, events, opts.kind ?? 'headed')
    // The WELCOME a spawn or reattach awaited has already stated the size: say
    // it once now, through the same event every later RESIZED takes.
    const size = attachment.size?.()
    if (size && events.onSize) events.onSize(size)
    return terminal
  }

  get pid(): number {
    return this.attachment.pid
  }

  get adopted(): boolean | undefined {
    return this.attachment.adopted
  }

  /**
   * The kernel's size as the host last stated it; `undefined` before WELCOME,
   * after parking, and on a backend that cannot read it back (POD-4723).
   */
  size(): Geometry | undefined {
    if (this.settled) return undefined
    return this.attachment.size?.()
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

  /**
   * THE ASK: put the program at this size. It moves nothing here — the size
   * event does. Rejects with the host's refusal (or a closed connection) so
   * the caller can log it; does nothing when parked, and returns nothing on a
   * backend with no acknowledgement.
   */
  resize(cols: number, rows: number): Promise<void> | void {
    if (this.settled) return
    return this.attachment.resize(cols, rows)
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
