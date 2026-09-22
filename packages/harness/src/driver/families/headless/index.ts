// packages/harness/src/driver/families/headless/index.ts
//
// THE HEADLESS FAMILY (POD-4614): one-shot superagent/shipwright turns, each a
// podium-host process started through the session layer's process owner, and
// the `RuntimeDriver 'headless'` that runs them behind the contract.
//
// `HeadlessTurnOutcome` stays family-internal: the contract already exports a
// type of that name (./headless-turn.ts, the procedure's terminal outcome).

export * from './runtime.js'
export {
  HEADLESS_TURN_RETENTION,
  type HostedTurnDeps,
  type HostedTurnInput,
  acknowledgeHostedTurn,
  runHostedHeadlessTurn,
} from './turn.js'
export {
  DEFAULT_HEADLESS_TURN_TIMEOUT_MS,
  type HeadlessEmit,
  HeadlessTurnError,
  type HeadlessTurnHandle,
  type HeadlessTurnHooks,
  type HeadlessTurnSpec,
  type HostedTurnIdentity,
} from './types.js'
export {
  assertHeadlessToolPolicy,
  buildHeadlessExec,
  composeHeadlessInvocation,
  type HeadlessInvocation,
  type HeadlessStdin,
  headlessFor,
} from './invocation.js'
export {
  createTurnLineSplitter,
  encodeTurnMarker,
  parseTurnMarker,
  TURN_MARKER_PREFIX,
  TURN_STDERR_PREFIX,
  TURN_WRAPPER_SCRIPT,
  type TurnMarker,
  turnIdentityHash,
  wrapTurnInvocation,
} from './wrapper.js'
export { createHeadlessProgressReader, foldHeadlessOutcome } from './fold.js'
