/**
 * The common peer handshake — ADR 5 D3 (framing), D4 (reserved node surface) and
 * D5 (role-specific auth strategy modules).
 *
 * Framing is COMMON to every role and lives in `./envelope`, `./negotiation`,
 * `./acceptor` (gateway end) and `./dialer` (daemon end). Authentication is where
 * roles legitimately differ and lives in `./strategies`, one module per row of
 * ADR 5 D5's table, selected by a registry lookup rather than a conditional.
 */

export * from './acceptor'
export * from './conformance'
export * from './delegation-chain'
export * from './dialer'
export * from './envelope'
export * from './legacy-daemon-frames'
export * from './negotiation'
export * from './strategies/agent-relay-delegation'
export * from './strategies/console-cookie'
export * from './strategies/machine-local-secret'
export * from './strategies/machine-pair-code'
export * from './strategies/machine-principal'
export * from './strategies/machine-token'
export * from './strategies/node-reserved'
export * from './strategies/operator-channel'
export * from './strategies/registry'
export * from './strategies/system'
export * from './strategies/types'
