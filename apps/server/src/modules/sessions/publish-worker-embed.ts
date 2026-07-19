/** Repo-relative extra entrypoint embedded into the unified compiled Podium binary. */
export const PUBLISH_WORKER_ENTRY = 'apps/server/src/modules/sessions/publish-worker.ts'

/** Detect Bun's POSIX and percent-encoded/raw Windows standalone virtual roots. */
export function isCompiledBunfsUrl(url: string): boolean {
  const normalized = url.toLowerCase()
  return (
    normalized.includes('/$bunfs/') || normalized.includes('~bun') || normalized.includes('%7ebun')
  )
}

export function publishWorkerEmbeddedTarget(platform: NodeJS.Platform = process.platform): string {
  const relative = PUBLISH_WORKER_ENTRY.replace(/\.ts$/, '.js')
  return platform === 'win32' ? `B:/~BUN/root/${relative}` : `file:///$bunfs/root/${relative}`
}
