// Single source of truth for embedding the discovery worker into the `bun build --compile`
// daemon binary — shared by scripts/build-bun.ts (which adds the worker as an entrypoint) and
// worker-client.ts (which spawns it), so the two can never drift.
//
// Why this is needed: `new Worker(new URL('./discovery-worker.ts', import.meta.url))` is NOT
// auto-embedded by Bun's `--compile` (Bun 1.3.x) — the standalone binary then fails at runtime
// with `ModuleNotFound resolving "/$bunfs/root/discovery-worker.ts"`. So build-bun adds this
// file as an explicit extra entrypoint (bundling its whole dep graph), and worker-client spawns
// it from the path Bun embeds it at.
//
// Bun embeds an additional entrypoint at its path relative to the common ancestor of ALL
// entrypoints, rooted at `/$bunfs/root`, with `.ts` transpiled to `.js`. The daemon's main
// entry is scripts/daemon-compiled.ts, so the common ancestor is the repo root and the embedded
// path is the repo-relative worker path below. (The main entry, by contrast, always lands at
// `/$bunfs/root/<outfile-basename>`.)

/** Repo-relative path passed to `bun build --compile` as an extra entrypoint. */
export const DISCOVERY_WORKER_ENTRY = 'apps/daemon/src/discovery-worker.ts'

/** Absolute path the worker is embedded at inside the compiled daemon binary. */
export const DISCOVERY_WORKER_EMBEDDED_PATH = `/$bunfs/root/${DISCOVERY_WORKER_ENTRY.replace(/\.ts$/, '.js')}`
