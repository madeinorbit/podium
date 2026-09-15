/**
 * Re-export shim (P2c): the reopen decision is a pure function over the mode,
 * the model size and the viewer size, so its canonical home is
 * `@podium/process/screen` where `TerminalScreen` owns it. This module
 * re-exports it so existing daemon importers keep working.
 */
export {
  type ReopenInputs,
  type ReopenDecision,
  decideReopenScreen,
} from '@podium/process/screen'
