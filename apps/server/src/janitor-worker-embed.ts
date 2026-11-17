// Single source of truth for embedding the janitor worker into the compiled Podium binary.
// Bun does not discover Worker entrypoints automatically, so scripts/build-bun.ts adds this
// path explicitly and janitor-host.ts resolves the same path from Bun's virtual filesystem.
//
// The entry is the server's since POD-6993: the janitor reads the store through the
// store's query definitions, which only the server holds, so the server's entry runs
// the janitor package's worker loop with the server's database opener.

/** Repo-relative path passed to `bun build --compile` as an extra entrypoint. */
export const JANITOR_WORKER_ENTRY = 'apps/server/src/janitor-worker.ts'

/** Whether a module URL belongs to a Bun standalone executable's virtual filesystem. */
export function isCompiledBunfsUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return lower.includes('/$bunfs/') || lower.includes('~bun') || lower.includes('%7ebun')
}

/** Target accepted by `new Worker(...)` for the explicitly embedded entrypoint. */
export function janitorWorkerEmbeddedTarget(platform: NodeJS.Platform = process.platform): string {
  const relative = JANITOR_WORKER_ENTRY.replace(/\.ts$/, '.js')
  return platform === 'win32' ? `B:/~BUN/root/${relative}` : `file:///$bunfs/root/${relative}`
}

/**
 * The janitor worker's entry for this process: the embedded path inside a compiled
 * binary, the source file beside this module otherwise.
 */
export function janitorWorkerTarget(moduleUrl: string = import.meta.url): URL | string {
  if (isCompiledBunfsUrl(moduleUrl)) {
    const target = janitorWorkerEmbeddedTarget()
    // Bun 1.4 requires URL objects for file URLs; Windows embedded paths must stay strings.
    return target.startsWith('file://') ? new URL(target) : target
  }
  return new URL('./janitor-worker.ts', moduleUrl)
}
