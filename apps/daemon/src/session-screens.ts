/**
 * PER-SESSION SCREEN STATE — one TerminalScreen per session (POD-3922 P2c).
 *
 * The screen belongs to the SESSION; the attachment is merely the current way
 * of reaching it. Since POD-4434 the screen lives ON the DaemonSession
 * (`apps/daemon/src/session/`): entries are created on first use (first output
 * byte or first applied size), fed by every output funnel and every apply site,
 * and dropped only when the session's terminal goes away (`forgetSessionScreen`
 * on the bridge-exit path). A detach/reattach cycle never drops one — the next
 * attachment resumes feeding the same screen, which is what makes the reopen
 * policy reconstitute from what the program drew rather than from a fresh
 * emulator.
 *
 * This module is the call-shape the daemon already speaks: every function
 * below delegates to the session, so observers, Draft Sync and the reopen
 * policy keep reading the ONE TerminalScreen with no call-site churn.
 *
 * The per-session VALUE lives in `@podium/process/screen` (`TerminalScreen`:
 * applied size, byte log, one model, 1049 mode, repaint policy) because none
 * of that names a SessionId, a protocol frame or the daemon context. The
 * OWNERSHIP lives on the Session because it does. `snapshotFirstFrame` is
 * re-exported from the package so the one serialisation has one home.
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

export interface SessionScreenState {
  screen: TerminalScreen
}

/** This session's screen state, without creating it. */
export function sessionScreenFor(
  ctx: DaemonContext,
  sessionId: SessionId,
): SessionScreenState | undefined {
  const screen = ctx.sessions.get(sessionId)?.peekScreen()
  return screen ? { screen } : undefined
}

/** This session's screen, creating it at the default size on first use. */
export function terminalScreenFor(ctx: DaemonContext, sessionId: SessionId): TerminalScreen {
  return ctx.sessions.ensure(sessionId).screen()
}

/**
 * Feed one output chunk: advance the mode and paint the model. Idempotent per
 * byte — every funnel (bridge frames, headed client frames) calls this, and
 * feeding the same bytes twice only repaints the same cells.
 */
export function trackSessionOutput(ctx: DaemonContext, sessionId: SessionId, data: Uint8Array): ScreenMode {
  return ctx.sessions.ensure(sessionId).screen().push(data)
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
  ctx.sessions.ensure(sessionId).screen().setAppliedSize(cols, rows)
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
  ctx.sessions.get(sessionId)?.dropScreen()
}

/** Backwards-compatible alias: the grid the screen's model was fed at. */
export function sessionModelSize(
  ctx: DaemonContext,
  sessionId: SessionId,
): Geometry | undefined {
  return sessionScreenFor(ctx, sessionId)?.screen.modelSize
}
