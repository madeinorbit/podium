/**
 * HOW A REOPENING VIEWER IS REPAINTED — a pure decision (POD-3918 P1b,
 * rewritten by POD-4723 / design rev 3). Kept solely for old-server
 * compatibility (SPEC v4 B3); picture-capable links never call it.
 *
 * A reopen NEVER touches the program (design rev 3, "Repaint"): a same-size
 * SIGWINCH repaints nothing in a Node TUI such as Claude, and the only way to
 * force one was the shrink-and-restore nudge, which is what put ptys back at
 * a stale size. The program is signalled by a real size change only. What a
 * viewer needs comes from what the daemon already holds:
 *
 * - Alternate screen, live model: serialise the headless model and send that
 *   as the first frame (`snapshot`). The model follows the kernel's size
 *   events, so it is at the size the program drew — the size the viewer is
 *   drawing at too, because the server's copy is the same kernel size.
 * - Normal screen: the byte stream IS the history. When the server kept
 *   nothing (`replayRequired`) the host ring replays its tail
 *   (`ring-replay`); without a ring, the live model's picture is the next
 *   best thing (`snapshot`). Otherwise the viewer's emulator already holds
 *   the history and nothing is sent (`none`).
 * - A dead model (a daemon restart before the screen was rebuilt) has no
 *   picture to give; alternate NEVER replays the ring, whose bytes may have
 *   been drawn at another size.
 */

import type { ScreenMode } from './screen-mode.js'

export interface ReopenInputs {
  mode: ScreenMode
  /** False after a daemon restart: the model died with the old process. */
  modelAlive: boolean
  /** Whether the bridge offers a host-ring `replay`. */
  ringReplayable: boolean
  /** The server kept nothing for the attaching page. */
  replayRequired: boolean
}

export type ReopenDecision = { kind: 'snapshot' } | { kind: 'ring-replay' } | { kind: 'none' }

export function decideReopenScreen(input: ReopenInputs): ReopenDecision {
  if (input.mode === 'alternate') return input.modelAlive ? { kind: 'snapshot' } : { kind: 'none' }
  if (!input.replayRequired) return { kind: 'none' }
  if (input.ringReplayable) return { kind: 'ring-replay' }
  return input.modelAlive ? { kind: 'snapshot' } : { kind: 'none' }
}
