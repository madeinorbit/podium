/**
 * @podium/core
 *
 * Internal domain model and zod schemas shared across Podium apps. Consumed as
 * TypeScript source by the apps; not published.
 *
 * Browser-safe by construction: apps/web imports this barrel, so members that pull
 * in Node-only builtins must NOT be re-exported here as runtime values. `config`
 * (node:fs/os/path) and `loop-metrics` (node:perf_hooks) live behind the
 * `@podium/core/config` and `@podium/core/loop-metrics` subpaths — mirroring
 * `@podium/core/sqlite`. Their *types* are still re-exported below (erased at build,
 * so they never reach the browser bundle). `git` and `settings` are isomorphic.
 */

export type { PodiumConfig, PodiumMode } from './config.js'
export * from './git.js'
// run-registry (node:fs) lives behind the `@podium/core/run-registry` subpath; types only here.
export type { RunRecord, RunRole } from './run-registry.js'
export * from './settings.js'
