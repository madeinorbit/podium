/** Explicit compile entry: Bun does not discover node worker targets. */
export const SYNC_WORKER_ENTRY = 'apps/server/src/sync-worker/sync-worker.ts'
export function isCompiledSyncWorkerUrl(url: string): boolean {
  return /\/\$bunfs\/|~bun|%7ebun/i.test(url)
}
export function syncWorkerEmbeddedTarget(platform: NodeJS.Platform = process.platform): string {
  const path = SYNC_WORKER_ENTRY.replace(/\.ts$/, '.js')
  return platform === 'win32' ? `B:/~BUN/root/${path}` : `file:///$bunfs/root/${path}`
}
