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

/**
 * Whether `url` is a module inside a bun-compiled standalone binary. Bun's virtual
 * filesystem root is `/$bunfs` on POSIX but `B:\~BUN` on WINDOWS — and there
 * import.meta.url is `file:///B:/%7EBUN/root/<binary>.exe` with the `~`
 * PERCENT-ENCODED (probed on windows-latest; Bun.main carries the raw form), so
 * match both spellings. Checking only `/$bunfs/` made the compiled Windows daemon
 * take the run-from-source branch and crash-loop on
 * `ModuleNotFound B:\~BUN\root\discovery-worker.ts`.
 */
export function isCompiledBunfsUrl(url: string): boolean {
  const u = url.toLowerCase()
  return u.includes('/$bunfs/') || u.includes('~bun') || u.includes('%7ebun')
}

/**
 * What to hand `new Worker(...)` for the embedded worker inside the compiled
 * binary (`.ts` transpiled to `.js`). Probed on windows-latest inside a real
 * compiled binary: the ONLY form that resolves there is the raw
 * `B:/~BUN/root/…` path with FORWARD slashes — the backslash path and the
 * `file:///B:/…` URL both ENOENT, and `/$bunfs` forms are POSIX-only.
 */
export function discoveryWorkerEmbeddedTarget(
  platform: NodeJS.Platform = process.platform,
): string {
  const rel = DISCOVERY_WORKER_ENTRY.replace(/\.ts$/, '.js')
  return platform === 'win32' ? `B:/~BUN/root/${rel}` : `file:///$bunfs/root/${rel}`
}
