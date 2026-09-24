/**
 * POD-4573 (Mc1) — the MobX arm's pending log: the reference L1c log.
 *
 * The arm uses the shared reference implementation
 * (`shared/src/write-contract.ts` `createPendingLog`) as its transaction log.
 * A log of its own would have to pass the same `write-contract.test.ts`
 * sequences (added to that file's `LOGS` list); using the reference keeps one
 * executable form of rules W4–W10. This module is the import site the write
 * layer and its tests share, so a future arm-owned log changes one place.
 */

export { createPendingLog, ECHO_TTL_MS } from '../../../../shared/src/write-contract'
export type { PendingLog } from '../../../../shared/src/write-contract'
