// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
// Single source of truth for embedding the old-plaintext worker into the compiled Podium
// binary. Bun does not discover Worker entrypoints, so scripts/build-bun.ts adds this path
// explicitly and `legacyPlaintextWorkerTarget` resolves the same path from Bun's virtual
// filesystem.

import { isCompiledBunfsUrl } from '../janitor-worker-embed'

/** Repo-relative path passed to `bun build --compile` as an extra entrypoint. */
export const LEGACY_PLAINTEXT_WORKER_ENTRY = 'apps/server/src/store/legacy-plaintext-worker.ts'

/** The worker's entry for this process: embedded in a compiled binary, the source file otherwise. */
export function legacyPlaintextWorkerTarget(
  moduleUrl: string = import.meta.url,
  platform: NodeJS.Platform = process.platform,
): URL | string {
  if (isCompiledBunfsUrl(moduleUrl)) {
    const relative = LEGACY_PLAINTEXT_WORKER_ENTRY.replace(/\.ts$/, '.js')
    // Bun requires URL objects for file URLs; Windows embedded paths stay strings.
    return platform === 'win32'
      ? `B:/~BUN/root/${relative}`
      : new URL(`file:///$bunfs/root/${relative}`)
  }
  return new URL('./legacy-plaintext-worker.ts', moduleUrl)
}
