/**
 * @podium/protocol — wire types + codecs for agent/terminal sessions.
 */
export * from './delegation'
// Branded entity ids and the two legacy composite-key helpers live in
// @podium/model (POD-361) — the L0 root, where a brand is reachable from every
// layer, which is what let the entity schemas adopt them. They are NOT
// republished here: POD-362 and POD-363 re-pointed the server, daemon, clients
// and CLI at @podium/model, and POD-333 re-pointed the remainder and deleted the
// compatibility block those issues left behind. `planes/routing` still
// re-exports model's `EntityRef`, which is a wire type this package defines its
// routing over rather than a held-open import path.
export * from './edge'
export * from './features'
export * from './handshake'
export * from './issue-read-limits'
export * from './locks'
export * from './maintenance'
export * from './messages'
export * from './perf'
export * from './planes'
export * from './refs'
export * from './relations'
export * from './schema-digest'
export * from './session-cookie'
export * from './titles'
export * from './update'
export * from './version'
