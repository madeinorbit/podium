// Single source of truth for embedding the janitor worker into the compiled Podium binary.
// Bun does not discover Worker entrypoints automatically, so scripts/build-bun.ts adds this
// path explicitly and worker-client.ts resolves the same path from Bun's virtual filesystem.

/** Repo-relative path passed to `bun build --compile` as an extra entrypoint. */
export const JANITOR_WORKER_ENTRY = 'apps/janitor/src/janitor-worker.ts'

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
