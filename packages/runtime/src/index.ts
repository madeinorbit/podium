/**
 * @podium/runtime
 *
 * Node-runtime plumbing shared across Podium apps (config, sqlite shims,
 * connectivity, auth-store, …) — NOT the model. Entity types and pure business
 * logic live in @podium/model instead. Consumed as TypeScript source by the
 * apps; not published.
 *
 * The `git.ts` re-export shim is GONE (POD-299): it forwarded
 * `normalizeOriginUrl` to what is now @podium/model, and nothing outside its own
 * test imported it from here. Import git-remote identity from @podium/model.
 *
 * Browser-safe by construction: apps/web imports this barrel, so members that pull
 * in Node-only builtins must NOT be re-exported here as runtime values. `config`
 * (node:fs/os/path) and `loop-metrics` (node:perf_hooks) live behind the
 * `@podium/runtime/config` and `@podium/runtime/loop-metrics` subpaths — mirroring
 * `@podium/runtime/sqlite`. Their *types* are still re-exported below (erased at build,
 * so they never reach the browser bundle). `settings` is isomorphic.
 */

export type { PodiumConfig, PodiumMode } from './config'
// run-registry (node:fs) lives behind the `@podium/runtime/run-registry` subpath; types only here.
export type { RunRecord, RunRole } from './run-registry'
export * from './settings'
