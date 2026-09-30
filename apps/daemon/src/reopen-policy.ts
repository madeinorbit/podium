/**
 * Re-export shim (P2c): the reopen decision is a pure function over the mode
 * and three booleans, so its canonical home is
 * `@podium/process/screen`. The daemon calls it only when the server link
 * lacks terminal.picture.v1 (SPEC v4 old-server compatibility).
 */
export {
  type ReopenInputs,
  type ReopenDecision,
  decideReopenScreen,
} from '@podium/process/screen'
