/**
 * The AUTHORITY role of the sync kernel (POD-305, phase 2.1).
 *
 * The one role that arbitrates (ADR 1 D1). POD-306 builds the Replica and Outbox
 * against the other side of this seam; `../replica/` is direction-locked so it
 * cannot reach in here, and that asymmetry is the whole point of the phase.
 */
export * from './arbitration'
export * from './authority'
export * from './change-lifecycle'
export * from './ports'
export * from './scoping'
