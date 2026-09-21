export * from './capabilities.js'
export {
  type ClaudeSdkChildHandle,
  type ClaudeSdkChildOptions,
  type ClaudeSdkChildTurnInput,
  type ClaudeSdkTurnEmit,
  type ClaudeSdkTurnOutcome,
  HeadlessTurnFailure,
  runClaudeSdkChildTurn,
} from './child-turn.js'
// NOTE: ./child-turn.js also declares `ClaudeSdkInterruptAck` and
// `ClaudeSdkTurnHandle` for the parent side of the child pipe, but those names
// already mean the driver's turn types from ./runtime.js — re-exporting both
// would silently drop one pair. The child's handle type above is the one
// supervisors need; the driver's stays authoritative for its own level.
export * from './classify.js'
export * from './host-protocol.js'
export * from './runtime.js'
export {
  type ClaudeSdkSessionDeps,
  createClaudeSdkSessionRuntime,
  type DaemonClaudeSdkRuntime,
  claudeSdkHarnessKind,
  emitClaudeBinding,
  ensureClaudeBindingPublished,
} from './session.js'
// NOTE: ./claude-sdk-host.js is intentionally NOT exported here. It loads
// `@anthropic-ai/claude-agent-sdk` at module scope, and this barrel is
// imported by the supervisor process — reaching the SDK from here would put
// third-party agent code in the process that supervises every session.
// The supervisor spawns the host as a child; tests import it by relative path.
