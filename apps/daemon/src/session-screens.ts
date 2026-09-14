/**
 * PER-SESSION SCREEN STATE — the daemon's headless model and mode per live
 * session (POD-3918 P1b).
 *
 * Two halves with different owners:
 *
 * - The MODE comes from {@link ScreenModeTracker}: DECSET/DECRST 1049 read
 *   off the output stream. The server mirrors the same signal for its replay
 *   decision (see `terminal.ts`); this module owns the daemon's copy.
 * - The MODEL is a headless VT screen (`createHeadlessScreen`) fed every live
 *   frame and resized exactly when the program is, so at any moment it holds
 *   what the program drew, at the size it drew it. That is what makes the
 *   alternate same-size serialisation a first frame instead of a guess.
 *
 * INVARIANT: the model tracks the PROGRAM size, never the viewer size. It is
 * resized only by {@link trackSessionSize}, which is called where a size is
 * really applied (bridge birth, resize dispatch, the reopen handler's own
 * size-first apply). An alternate canvas is never reflowed to fit a viewer:
 * the different-size case resizes the program first and uses the old-size
 * serialisation only as a placeholder until the repaint lands.
 */

import type { Geometry, SessionId } from '@podium/model'
import { createHeadlessScreen, type ScreenReader } from './composer-sync'
import { ScreenModeTracker, type ScreenMode } from './screen-mode'
import type { DaemonContext } from './control/context'

/** The size a model is born at when nothing applied one yet. */
const DEFAULT_MODEL_SIZE = { cols: 80, rows: 24 } as const

export interface SessionScreenState {
  tracker: ScreenModeTracker
  model: ScreenReader | undefined
  /** The grid the model was fed at — what the program drew. */
  modelSize: Geometry | undefined
}

/** This daemon's per-session screen state, created on first use. */
export function sessionScreensFor(ctx: DaemonContext): Map<SessionId, SessionScreenState> {
  return (ctx.sessionScreens ??= new Map<SessionId, SessionScreenState>())
}

export function sessionScreenFor(
  ctx: DaemonContext,
  sessionId: SessionId,
): SessionScreenState | undefined {
  return ctx.sessionScreens?.get(sessionId)
}

function stateFor(ctx: DaemonContext, sessionId: SessionId): SessionScreenState {
  const screens = sessionScreensFor(ctx)
  let state = screens.get(sessionId)
  if (!state) {
    state = { tracker: new ScreenModeTracker(), model: undefined, modelSize: undefined }
    screens.set(sessionId, state)
  }
  return state
}

function modelFor(state: SessionScreenState): ScreenReader {
  if (!state.model) {
    const size = state.modelSize ?? DEFAULT_MODEL_SIZE
    state.model = createHeadlessScreen(size.cols, size.rows)
  }
  return state.model
}

/**
 * Feed one output chunk: advance the mode and paint the model. Idempotent per
 * byte — every funnel (bridge frames, headed client frames) calls this, and
 * feeding the same bytes twice only repaints the same cells.
 */
export function trackSessionOutput(ctx: DaemonContext, sessionId: SessionId, data: Uint8Array): ScreenMode {
  const state = stateFor(ctx, sessionId)
  const mode = state.tracker.write(data)
  modelFor(state).write(data)
  return mode
}

/**
 * The program was put at this size: record it and re-grid the model to match.
 * Call where the size is really applied, never for a viewer ask on its own.
 */
export function trackSessionSize(
  ctx: DaemonContext,
  sessionId: SessionId,
  cols: number,
  rows: number,
): void {
  const state = stateFor(ctx, sessionId)
  state.modelSize = { cols, rows }
  modelFor(state).resize(cols, rows)
}

/** Read the model's rendered rows for a first-frame serialisation. */
export function snapshotLines(
  ctx: DaemonContext,
  sessionId: SessionId,
): { mode: ScreenMode; lines: string[] } | undefined {
  const state = sessionScreenFor(ctx, sessionId)
  if (!state?.model) return undefined
  return { mode: state.tracker.current, lines: state.model.lines(false) }
}

/** The session is gone: its model died with it (a restart rebuilds approx). */
export function forgetSessionScreen(ctx: DaemonContext, sessionId: SessionId): void {
  const state = ctx.sessionScreens?.get(sessionId)
  if (!state) return
  try {
    state.model?.dispose()
  } catch {
    // Disposal is best-effort bookkeeping on a teardown path.
  }
  ctx.sessionScreens?.delete(sessionId)
}

/**
 * Serialise model rows into the bytes a fresh viewer renders as its first
 * frame.
 *
 * Alternate frames enter through leave-then-enter (`1049l 1049h`): on a
 * fresh viewer the leave is a no-op and the enter puts it on the canvas the
 * rows were drawn for; on a viewer stuck in a dead alternate buffer the
 * leave gets it out first, so a repeated snapshot can never double-save and
 * strand a later program exit. The program's own eventual `1049l` balances
 * the one `1049h` here.
 *
 * Rendered rows can carry a literal ESC cell (a program that prints one);
 * painting it raw would inject a sequence into the viewer's stream, so it is
 * stripped: the snapshot is a picture of the canvas, not a program.
 */
export function snapshotFirstFrame(mode: ScreenMode, lines: string[]): Uint8Array {
  const safe = lines.map((line) => line.replaceAll('\x1b', ''))
  const body = safe.join('\r\n')
  const prefix = mode === 'alternate' ? '\x1b[?1049l\x1b[?1049h\x1b[H' : '\x1b[2J\x1b[H'
  return Buffer.from(prefix + body, 'latin1')
}
