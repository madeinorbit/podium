/**
 * The Replica role of the sync kernel (POD-369, Phase 2 / POD-289).
 *
 * A pure state machine over injected ports: no transport, no storage engine, no
 * server wiring. POD-307/374/375 supply durable storage adapters (ADR 6), POD-308
 * maps the wire onto these kernel types, POD-370 owns the outbox, POD-372 derives
 * the optimistic overlay from the reducer port and POD-351/POD-311 supply the
 * reducers themselves. Nothing here imports a merge policy, and
 * nothing here evaluates visibility — the Replica applies the slice the Authority
 * computed (ADR 1 D1, ADR 2 Amendment 1 D12.7).
 */
export * from './memory-store'
export * from './overlay'
export * from './overlay-projection'
export * from './ports'
export * from './replica'
export * from './transition-table'
export * from './types'
