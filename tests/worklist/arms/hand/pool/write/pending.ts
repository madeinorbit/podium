/**
 * POD-4586 (Hc1) — the hand-rolled arm's pending log: the reference L1c log.
 *
 * The arm uses the shared reference implementation
 * (`shared/src/pending-log.ts` `createPendingLog`) as its transaction log.
 * A log of its own would have to pass the same `write-contract.test.ts`
 * sequences (added to that file's `LOGS` list); using the reference keeps one
 * executable form of rules W4–W10. This module is the import site the write
 * layer and its tests share, so a future arm-owned log changes one place.
 */

export { createPendingLog, ECHO_TTL_MS } from '../../../../shared/src/pending-log'
export type { PendingLog } from '../../../../shared/src/pending-log'
