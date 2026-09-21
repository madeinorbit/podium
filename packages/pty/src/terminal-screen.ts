/**
 * One screen per session — the object that owns what a process is showing
 * (P2c of POD-3915).
 *
 * WHAT IT OWNS: the applied size (the program's grid — the single-session
 * value the daemon's `AppliedGeometryRecord` used to hold per id), the byte
 * log and its window (new: a bounded cache of recent output bytes; the host,
 * not this object, owns history while the process lives), one screen model
 * (a headless VT emulator fed at the produced size), the 1049 screen mode,
 * and the repaint-versus-replay policy.
 *
 * WHAT IT IS NOT: an attachment. An `DurableAttachment` is created per attachment —
 * attach and you get one, detach and it is gone. A screen belongs to the
 * session; the attachment is merely the current way of reaching it. Feed this
 * object from each attachment in turn via {@link TerminalScreen.attach} (or
 * {@link TerminalScreen.push} directly) and it survives the detach/reattach
 * cycle with model, mode, applied size and log intact.
 *
 * PLACEMENT: harness-agnostic. Names no SessionId, no protocol frame, no
 * daemon context — only `Geometry` from `@podium/model`, which `session.ts`
 * already speaks. Usable from a test that never creates a Podium session.
 */

import { StringDecoder } from 'node:string_decoder'
import type { Geometry } from '@podium/model'
import { createTitleScanner } from './osc-title.js'
import { decideReopenScreen, type ReopenDecision } from './reopen-policy.js'
import { type ScreenMode, ScreenModeTracker } from './screen-mode.js'
import { createHeadlessScreen, type ScreenReader } from './screen-model.js'

/**
 * Serialise model rows into the bytes a fresh viewer renders as its first
 * frame. Pure: the method below reads the screen's own mode and lines and
 * calls this.
 *
 * Alternate frames enter through leave-then-enter (`1049l 1049h`): on a
 * fresh viewer the leave is a no-op and the enter puts it on the canvas the
 * rows were drawn for; on a viewer stuck in a dead alternate buffer the
 * leave gets it out first, so a repeated snapshot can never double-save and
 * strand a later program exit. Rendered rows carrying a literal ESC cell are
 * stripped: the snapshot is a picture of the canvas, not a program.
 */
export function snapshotFirstFrame(mode: ScreenMode, lines: string[]): Buffer {
  const safe = lines.map((line) => line.replaceAll('\x1b', ''))
  const body = safe.join('\r\n')
  const prefix = mode === 'alternate' ? '\x1b[?1049l\x1b[?1049h\x1b[H' : '\x1b[2J\x1b[H'
  return Buffer.from(prefix + body, 'latin1')
}

/** How much recent output the byte log keeps: several screens of a TUI. */
export const TERMINAL_SCREEN_BYTE_LOG_BYTES = 256 * 1024

/** The size a model is born at when nothing applied one yet. */
const DEFAULT_MODEL_SIZE = { cols: 80, rows: 24 } as const

/** Minimal frame source an attachment offers: sequenced raw-byte frames. */
export interface TerminalScreenFrame {
  seq: number
  data: Uint8Array
}

/** Just enough of an attachment to feed a screen: it emits frames. */
export interface TerminalScreenAttachment {
  onFrame(cb: (frame: TerminalScreenFrame) => void): () => void
}

export interface TerminalScreenOptions {
  cols: number
  rows: number
  /** Byte-log window cap. Defaults to {@link TERMINAL_SCREEN_BYTE_LOG_BYTES}. */
  byteLogBytes?: number
}

export interface TerminalScreenReopenOptions {
  /** The grid the reopening viewer needs. */
  viewerSize: Geometry | undefined
  /** Whether the bridge offers a host-ring `replay`. */
  ringReplayable: boolean
  /** The server kept nothing for the attaching page. */
  replayRequired: boolean
}

export class TerminalScreen {
  private readonly screen: ScreenReader
  private readonly tracker = new ScreenModeTracker()
  private readonly titleScanner = createTitleScanner()
  private readonly decoder = new StringDecoder('utf8')
  private readonly titleCbs = new Set<(title: string) => void>()
  private lastTitle: string | undefined
  private readonly logCap: number
  private readonly log: Buffer[] = []
  private logBytes = 0
  /** The grid the program was put at — what it drew. */
  private applied: Geometry | undefined
  private disposed = false

  constructor(opts: TerminalScreenOptions) {
    this.logCap = opts.byteLogBytes ?? TERMINAL_SCREEN_BYTE_LOG_BYTES
    const size = opts.cols > 0 && opts.rows > 0 ? opts : DEFAULT_MODEL_SIZE
    this.screen = createHeadlessScreen(size.cols, size.rows)
    this.applied = opts.cols > 0 && opts.rows > 0 ? { cols: opts.cols, rows: opts.rows } : undefined
  }

  /** The grid the program was put at, or nothing when no size was applied yet. */
  get appliedSize(): Geometry | undefined {
    return this.applied ? { ...this.applied } : undefined
  }

  /** The grid the model was fed at — what the program drew. */
  get modelSize(): Geometry | undefined {
    return this.applied ? { ...this.applied } : undefined
  }

  /** Which screen the program is currently painting. */
  get mode(): ScreenMode {
    return this.tracker.current
  }

  /** False once disposed: there is no model to serialise. */
  get alive(): boolean {
    return !this.disposed
  }

  /** How many log bytes are currently windowed. */
  get bufferedBytes(): number {
    return this.logBytes
  }

  /**
   * Feed one output chunk: advance the mode, paint the model, append the byte
   * log window, and scan the title. Idempotent per byte — every funnel calls
   * this, and feeding the same bytes twice only repaints the same cells.
   */
  push(data: Uint8Array): ScreenMode {
    if (this.disposed) return this.tracker.current
    const mode = this.tracker.write(data)
    this.screen.write(data)
    this.appendLog(data)
    for (const raw of this.titleScanner.push(this.decoder.write(Buffer.from(data)))) {
      const title = raw.replace(/\p{Cc}/gu, '').trim()
      if (!title || title === this.lastTitle) continue
      this.lastTitle = title
      for (const cb of [...this.titleCbs]) cb(title)
    }
    return mode
  }

  /**
   * The program was put at this size: record it and re-grid the model to
   * match. Call where the size is really applied, never for a viewer ask on
   * its own. INVARIANT: the model tracks the PROGRAM size, never the viewer
   * size — an alternate canvas is never reflowed to fit a viewer.
   */
  setAppliedSize(cols: number, rows: number): void {
    if (this.disposed) return
    this.applied = { cols, rows }
    this.screen.resize(cols, rows)
  }

  /** Read the model's rendered rows for a first-frame serialisation. */
  lines(dropDim = false): string[] {
    return this.screen.lines(dropDim)
  }

  /** Resolve once all pushed bytes are parsed into the model. */
  flush(): Promise<void> {
    return this.screen.flush()
  }

  /**
   * The shared model itself, for the composer and the screen observer to READ.
   * Non-owning: readers call `lines()`/`flush()` only — the screen owns the
   * feed (`push`/`attach`), the grid (`setAppliedSize`) and the lifecycle
   * (`dispose`). The daemon's readers take this with `ownsScreen === false`
   * so detaching a reader never kills the session's model.
   */
  get model(): ScreenReader {
    return this.screen
  }

  /** Live terminal title (OSC 0/1/2) the agent set, emitted on each change. */
  onTitle(cb: (title: string) => void): () => void {
    this.titleCbs.add(cb)
    return () => this.titleCbs.delete(cb)
  }

  /**
   * Feed this screen from an attachment until detached. The detach function
   * stops the feed; model, mode, applied size and log survive it, and a later
   * {@link attach} to the next attachment resumes where it left off. That is
   * the per-session / per-attachment split: attachments come and go, the
   * screen stays.
   */
  attach(source: TerminalScreenAttachment): () => void {
    const off = source.onFrame((frame) => {
      this.push(frame.data)
    })
    return off
  }

  /**
   * The last `n` log bytes, oldest first — the window a normal-screen replay
   * reflows from. Empty when nothing was ever pushed.
   */
  tailBytes(n: number): Uint8Array {
    if (n <= 0 || this.logBytes === 0) return new Uint8Array(0)
    const want = Math.min(n, this.logBytes)
    const out = Buffer.allocUnsafe(want)
    let pos = want
    for (let i = this.log.length - 1; i >= 0 && pos > 0; i -= 1) {
      const chunk = this.log[i]!
      const take = Math.min(chunk.length, pos)
      chunk.subarray(chunk.length - take).copy(out, pos - take)
      pos -= take
    }
    return out
  }

  /**
   * Serialise model rows into the bytes a fresh viewer renders as its first
   * frame — {@link snapshotFirstFrame} over this screen's own mode and lines.
   */
  snapshotFirstFrame(): Buffer {
    return snapshotFirstFrame(this.tracker.current, this.screen.lines(false))
  }

  /**
   * Which reopen strategy for a viewer at this size — the policy from
   * POD-3918, owned here alongside the model it decides about. The caller
   * still performs the dispatch (resize through the bridge, enqueue the
   * snapshot, replay the ring): this answers WHAT, never HOW.
   */
  decideReopen(opts: TerminalScreenReopenOptions): ReopenDecision {
    return decideReopenScreen({
      mode: this.tracker.current,
      modelSize: this.applied ? { ...this.applied } : undefined,
      viewerSize: opts.viewerSize,
      modelAlive: !this.disposed,
      ringReplayable: opts.ringReplayable,
      replayRequired: opts.replayRequired,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.titleCbs.clear()
    this.log.length = 0
    this.logBytes = 0
    this.screen.dispose()
  }

  private appendLog(data: Uint8Array): void {
    if (this.logCap <= 0) return
    const chunk = Buffer.from(data)
    if (chunk.length === 0) return
    this.log.push(chunk)
    this.logBytes += chunk.length
    // Sliding window at byte granularity: drop whole oldest chunks, then trim
    // the front of the new oldest so exactly the last `logCap` bytes survive.
    let excess = this.logBytes - this.logCap
    while (excess > 0 && this.log.length > 0) {
      const oldest = this.log[0]!
      if (oldest.length <= excess) {
        this.log.shift()
        this.logBytes -= oldest.length
        excess -= oldest.length
      } else {
        this.log[0] = Buffer.from(oldest.subarray(excess))
        this.logBytes -= excess
        excess = 0
      }
    }
  }
}
