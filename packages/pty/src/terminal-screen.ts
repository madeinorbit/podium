/**
 * One screen per session — the object that owns what a process is showing
 * (P2c of POD-3915).
 *
 * WHAT IT OWNS: the applied size (the program's grid — the single-session
 * value the daemon's `AppliedGeometryRecord` used to hold per id), one screen
 * model (a headless VT emulator fed at the produced size), the 1049 screen
 * mode and the title. Only the host retains output history.
 *
 * WHAT IT IS NOT: an attachment. An `DurableAttachment` is created per attachment —
 * attach and you get one, detach and it is gone. A screen belongs to the
 * session; the attachment is merely the current way of reaching it. Feed this
 * object from each attachment in turn via {@link TerminalScreen.attach} (or
 * {@link TerminalScreen.push} directly) and it survives the detach/reattach
 * cycle with model, mode and applied size intact.
 *
 * PLACEMENT: harness-agnostic. Names no SessionId, no protocol frame, no
 * daemon context — only `Geometry` from `@podium/model`, which `session.ts`
 * already speaks. Usable from a test that never creates a Podium session.
 */

import { StringDecoder } from 'node:string_decoder'
import type { Geometry } from '@podium/model'
import { createTitleScanner } from './osc-title.js'
import { type ScreenMode, ScreenModeTracker } from './screen-mode.js'
import { createHeadlessScreen, type HeadlessScreen, type ScreenReader } from './screen-model.js'

const ESC = '\x1b'
const BEL = '\x07'
/** The CSI finals a snapshot body keeps: SGR, cursor moves, erase-characters. */
const PAINT_FINALS = 'mABCDX'

/** Where the escape sequence starting at `at` ends (exclusive). */
function escapeEnd(body: string, at: number): number {
  const kind = body[at + 1]
  if (kind === '[') {
    // CSI: parameter and intermediate bytes, then one final byte (0x40-0x7e).
    let i = at + 2
    while (i < body.length && (body.charCodeAt(i) < 0x40 || body.charCodeAt(i) > 0x7e)) i += 1
    return Math.min(i + 1, body.length)
  }
  if (kind === ']') {
    // OSC: up to BEL or ST (ESC \).
    let i = at + 2
    while (i < body.length && body[i] !== BEL && body[i] !== ESC) i += 1
    if (body[i] === BEL) return i + 1
    return body[i] === ESC && body[i + 1] === '\\' ? i + 2 : i
  }
  return Math.min(at + 2, body.length)
}

/**
 * Keep only what paints: text, CR/LF/BS, and CSI SGR, cursor moves (A-D) and
 * erase-characters (X) with plain numeric parameters. Every other escape
 * sequence and C0 control is dropped, so a snapshot can never switch a mode,
 * a buffer, a title or anything else a program would.
 */
function paintOnly(body: string): string {
  let out = ''
  let i = 0
  while (i < body.length) {
    const ch = body.charAt(i)
    if (ch === ESC) {
      const end = escapeEnd(body, i)
      const seq = body.slice(i, end)
      if (/^.\[[0-9;]*.$/.test(seq) && PAINT_FINALS.includes(seq.charAt(seq.length - 1))) out += seq
      i = end
      continue
    }
    const code = body.charCodeAt(i)
    if ((code >= 0x20 && code !== 0x7f) || ch === '\r' || ch === '\n' || ch === '\b') out += ch
    i += 1
  }
  return out
}

/**
 * Frame a serialised model screen as the bytes a viewer renders as its
 * repaint. Pure: the method below reads the screen's own mode and serialised
 * active buffer and calls this.
 *
 * The body is the model's visible rows as SGR-coloured text with the cursor
 * put back (POD-4848) — since POD-4723 it is the FINAL picture until the
 * program writes again, so it must be faithful, not a plain-text placeholder.
 * It is encoded UTF-8: every glyph above U+00FF (⏵, box drawing, CJK, emoji)
 * survives.
 *
 * Alternate frames enter through leave-then-enter (`1049l 1049h`): on a
 * fresh viewer the leave is a no-op and the enter puts it on the canvas the
 * rows were drawn for; on a viewer stuck in a dead alternate buffer the
 * leave gets it out first, so a repeated snapshot can never double-save and
 * strand a later program exit. Both frames then reset the pen and home the
 * cursor, which is what the body assumes. The body passes {@link paintOnly}:
 * the snapshot is a picture of the canvas, never a program — no mode, buffer
 * switch, OSC or other control survives.
 */
export function snapshotFirstFrame(mode: ScreenMode, body: string): Buffer {
  const prefix = mode === 'alternate' ? '\x1b[?1049l\x1b[?1049h\x1b[m\x1b[H' : '\x1b[m\x1b[2J\x1b[H'
  return Buffer.from(prefix + paintOnly(body), 'utf8')
}

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
}

export class TerminalScreen {
  private readonly screen: HeadlessScreen
  private readonly tracker = new ScreenModeTracker()
  private readonly titleScanner = createTitleScanner()
  private readonly decoder = new StringDecoder('utf8')
  private readonly titleCbs = new Set<(title: string) => void>()
  private lastTitle: string | undefined
  /** The grid the program was put at — what it drew. */
  private applied: Geometry | undefined
  private disposed = false

  constructor(opts: TerminalScreenOptions) {
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

  /**
   * Feed one output chunk: advance the mode, paint the model and scan the title.
   * Every output funnel calls this once per chunk.
   */
  push(data: Uint8Array): ScreenMode {
    if (this.disposed) return this.tracker.current
    const mode = this.tracker.write(data)
    this.screen.write(data)
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
   * stops the feed; model, mode and applied size survive it, and a later
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
   * Old-server compatibility: {@link snapshotFirstFrame} over this screen's
   * own mode and serialised active buffer repaints a returning viewer.
   */
  snapshotFirstFrame(): Buffer {
    return snapshotFirstFrame(this.tracker.current, this.screen.serialize())
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.titleCbs.clear()
    this.screen.dispose()
  }
}
