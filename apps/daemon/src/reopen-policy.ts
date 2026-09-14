/**
 * WHICH REOPEN STRATEGY — the four policy cases, as a pure decision
 * (POD-3918 P1b).
 *
 * THE POLICY, STATED PRECISELY:
 *
 * - Alternate screen, SAME size as the model: serialise the headless model
 *   and send that as the first frame, then go live. No replay of stale bytes
 *   (`snapshot-then-live`).
 * - Alternate screen, DIFFERENT size: a model cannot produce a correct screen
 *   at a size the program never drew. Send the size FIRST, let the program
 *   repaint, and use the model serialisation only as a placeholder until the
 *   first repaint frame arrives (`resize-repaint-with-placeholder`). DONE WHEN
 *   4 is satisfied by the program's repaint, never by the model alone.
 * - Normal screen: the byte stream IS the history. The server replays its
 *   log and the daemon replays the host ring only when the server kept
 *   nothing (`ring-replay`); otherwise the repaint nudge is enough because
 *   the viewer's emulator already holds the history (`repaint-only`). The
 *   bytes reach the model at their PRODUCED size first — the live model is
 *   fed continuously and resized only when the program is — so the emulator
 *   reflows instead of rewrapping from scratch.
 * - Daemon restart: the model is gone and must be rebuilt from the host
 *   ring, which carries no size history, so the rebuild assumes one size for
 *   the whole tail. POD-3925 (host size side table) fixes that; until it
 *   lands the restart case is approximate (`resize-repaint`, `repaint` and
 *   `ring-replay` below are all taken with a gone model).
 *
 * Alternate NEVER replays the ring, however deep the debt: those bytes were
 * produced at a possibly different size and the program owns the canvas.
 */

import type { Geometry } from '@podium/model'
import type { ScreenMode } from './screen-mode'

export interface ReopenInputs {
  mode: ScreenMode
  /** The grid the model was fed at (what the program drew). */
  modelSize: Geometry | undefined
  /** The grid the reopening viewer needs. */
  viewerSize: Geometry | undefined
  /** False after a daemon restart: the model died with the old process. */
  modelAlive: boolean
  /** Whether the bridge offers a host-ring `replay`. */
  ringReplayable: boolean
  /** The server kept nothing for the attaching page. */
  replayRequired: boolean
}

export type ReopenDecision =
  | { kind: 'snapshot-then-live' }
  | { kind: 'resize-repaint-with-placeholder' }
  | { kind: 'resize-repaint' }
  | { kind: 'repaint' }
  | { kind: 'ring-replay' }
  | { kind: 'repaint-only' }

function sameSize(a: Geometry | undefined, b: Geometry | undefined): boolean {
  if (!a || !b) return false
  return a.cols === b.cols && a.rows === b.rows
}

export function decideReopenScreen(input: ReopenInputs): ReopenDecision {
  if (input.mode === 'alternate') {
    if (input.modelAlive) {
      // An unknown model size is not a same size: trusting it would paint a
      // canvas the program never drew. Size first, model as placeholder.
      if (!input.modelSize || !sameSize(input.modelSize, input.viewerSize)) {
        return { kind: 'resize-repaint-with-placeholder' }
      }
      return { kind: 'snapshot-then-live' }
    }
    // Restart-approximate: no model to serialise, so the program's repaint at
    // the agreed size is the whole of the first frame.
    if (input.viewerSize && !sameSize(input.modelSize, input.viewerSize)) {
      return { kind: 'resize-repaint' }
    }
    return { kind: 'repaint' }
  }
  if (input.replayRequired && input.ringReplayable) return { kind: 'ring-replay' }
  return { kind: 'repaint-only' }
}
