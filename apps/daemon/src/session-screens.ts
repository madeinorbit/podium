/**
 * PER-SESSION SCREEN STATE — one TerminalScreen per session (POD-3922 P2c).
 *
 * The screen belongs to the SESSION; the attachment is merely the current way
 * of reaching it. This module is the daemon's `Map<SessionId, TerminalScreen>`:
 * entries are created on first use (first output byte or first applied size),
 * fed by every output funnel and every apply site, and dropped only when the
 * session's terminal goes away (`forgetSessionScreen` on the bridge-exit path).
 * A detach/reattach cycle never drops one — the next attachment resumes
 * feeding the same screen, which is what makes the reopen policy reconstitute
 * from what the program drew rather than from a fresh emulator.
 *
 * The per-session VALUE lives in `@podium/process/screen` (`TerminalScreen`:
 * applied size, byte log, one model, 1049 mode, repaint policy) because none
 * of that names a SessionId, a protocol frame or the daemon context. The MAP
 * stays here because it does. `snapshotFirstFrame` is re-exported from the
 * package so the one serialisation has one home.
 */

import type { Geometry, SessionId } from '@podium/model'
import {
  snapshotFirstFrame,
  TerminalScreen,
  type ScreenMode,
} from '@podium/process/screen'
import type { DaemonContext } from './control/context'

export { snapshotFirstFrame }
export type { ScreenMode }

/** The size a screen is born at when nothing applied one yet. */
const DEFAULT_MODEL_SIZE = { cols: 80, rows: 24 } as const

export interface SessionScreenState {
  screen: TerminalScreen
}

/** This daemon's per-session screens, created on first use. */
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
    state = {
      screen: new TerminalScreen({ cols: DEFAULT_MODEL_SIZE.cols, rows: DEFAULT_MODEL_SIZE.rows }),
    }
    screens.set(sessionId, state)
  }
  return state
}

/** This session's screen, creating it at the default size on first use. */
export function terminalScreenFor(ctx: DaemonContext, sessionId: SessionId): TerminalScreen {
  return stateFor(ctx, sessionId).screen
}

/**
 * Feed one output chunk: advance the mode and paint the model. Idempotent per
 * byte — every funnel (bridge frames, headed client frames) calls this, and
 * feeding the same bytes twice only repaints the same cells.
 */
export function trackSessionOutput(ctx: DaemonContext, sessionId: SessionId, data: Uint8Array): ScreenMode {
  return stateFor(ctx, sessionId).screen.push(data)
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
  stateFor(ctx, sessionId).screen.setAppliedSize(cols, rows)
}

/** Read the model's rendered rows for a first-frame serialisation. */
export function snapshotLines(
  ctx: DaemonContext,
  sessionId: SessionId,
): { mode: ScreenMode; lines: string[] } | undefined {
  const state = sessionScreenFor(ctx, sessionId)
  if (!state || !state.screen.alive) return undefined
  return { mode: state.screen.mode, lines: state.screen.lines(false) }
}

/** The session is gone: its screen died with it (a restart rebuilds approx). */
export function forgetSessionScreen(ctx: DaemonContext, sessionId: SessionId): void {
  const state = ctx.sessionScreens?.get(sessionId)
  if (!state) return
  try {
    state.screen.dispose()
  } catch {
    // Disposal is best-effort bookkeeping on a teardown path.
  }
  ctx.sessionScreens?.delete(sessionId)
}

/** Backwards-compatible alias: the grid the screen's model was fed at. */
export function sessionModelSize(
  ctx: DaemonContext,
  sessionId: SessionId,
): Geometry | undefined {
  return sessionScreenFor(ctx, sessionId)?.screen.modelSize
}
