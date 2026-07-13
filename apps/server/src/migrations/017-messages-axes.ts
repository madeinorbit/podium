import type { SqlDatabase } from '@podium/runtime/sqlite'

/**
 * Unified agent messaging phase 2 (#237) [spec:SP-34d7] — full axis handling:
 *  - `hop`: server-maintained chain-depth counter. A message sent from a turn
 *    that was itself message-triggered carries hop = trigger.hop + 1; past
 *    depth 5 the lifecycle clamps to `wait` (ping-pong loops die out).
 *  - `clamped_from`: JSON record of what the sender REQUESTED when the clamp
 *    matrix / a containment brake downgraded it (downgrade-never-reject —
 *    the row's urgency/lifecycle columns always hold the EFFECTIVE values).
 */
export function up(db: SqlDatabase): void {
  db.exec(`
    ALTER TABLE messages ADD COLUMN hop INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE messages ADD COLUMN clamped_from TEXT;
  `)
}
