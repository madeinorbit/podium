/**
 * `@podium/client-core/logging` — the half of client log shipping that has no
 * runtime opinion: batching, backoff, the bounded queue, the crash payload.
 *
 * WHAT IS NOT HERE is the point. Every global-handler wiring lives in the app
 * that owns its globals — `window.onerror` + `unhandledrejection` in `apps/web`,
 * `ErrorUtils.setGlobalHandler` in `apps/mobile` — and hands its error to the
 * same {@link CrashReporter}. Nothing in this subpath reads `window`,
 * `document` or `navigator`, so the Expo bundle can import it unchanged.
 */

export { type CrashPayload, type CrashReporter, createCrashReporter } from './crash'
export {
  createForwardingSink,
  type ForwardingSink,
  type ForwardingSinkOptions,
  toForwarded,
} from './forward-sink'
export {
  type ClientLogging,
  type ClientLoggingOptions,
  installClientLogging,
  type LogTransport,
  type UnloadLogTransport,
} from './install'
export {
  applyServerLogLevel,
  createLevelController,
  DEFAULT_LEVEL_TTL_MS,
  type LevelController,
  type LogLevelCommand,
  type LogLevelStatus,
  logLevelStatus,
  MAX_LEVEL_TTL_MS,
  setActiveLevelController,
} from './level-command'
export {
  flushLogsBeforeUnload,
  reportCrash,
  setActiveCrashReporter,
  setActiveLogFlusher,
} from './runtime'
