/**
 * `bun:jsc`, declared here because nothing else in this repo needs it.
 *
 * Bun's builtins have no types in this dependency set — every other `bun:`
 * import in the tree is in a `.bun.test.ts` file, which tsgo does not compile —
 * and `loop-profile-capture.ts` is the first PRODUCTION module to import one.
 * Installing Bun's full type package to type two functions would put a second
 * global `Bun` namespace into every program in the repo.
 *
 * Only the two calls that module makes are declared. A fuller copy of Bun's API
 * would be a second source of truth that drifts silently: this one is wrong the
 * moment it is used, which is the failure mode to prefer.
 */
declare module 'bun:jsc' {
  /** Arm the sampling profiler. There is no matching stop — see the module comment. */
  export function startSamplingProfiler(directory?: string): void
  /** Return AND DRAIN the traces sampled since the previous call. */
  export function samplingProfilerStackTraces(): unknown
}
