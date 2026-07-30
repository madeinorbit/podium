/**
 * Plane ports — ADR 7 (`docs/adr/0007-plane-inventory.md`) and its Amendment 1.
 *
 * Three planes: control (durable), stream (live), bulk (paged). `command` is a
 * message CLASS inside the control port, not a fourth plane. One routing
 * primitive backs both control-plane per-principal scoping and stream-plane
 * per-room fan-out, with durability as a parameter (Amendment 1 D13).
 */

export * from './bulk-port'
export * from './control-port'
export * from './inventory'
export * from './plane'
export * from './port-rule'
export * from './presence-rooms'
export * from './principal'
export * from './routing'
export * from './scoped-feed'
export * from './stream-port'
