import type { FileScope } from '@podium/client-core/values'
import { asArtifactId } from '@podium/model/browser'

/**
 * The Artifacts index's sentinel (POD-2078), dependency-free so every guard can
 * import it — the URL builders included — without pulling in the store.
 *
 * The index rides an artifact-scoped file tab whose artifact id names no stored
 * artifact. Anything that turns a scope's artifact id into bytes (a read, an
 * asset or download URL, the file viewers) must ask `isArtifactsTabScope` first,
 * so the sentinel never reaches a fetch or renders as a broken file. The store
 * mints opaque ids that never start with `@`, so no real artifact matches.
 */
export const ARTIFACTS_TAB_ARTIFACT_ID = asArtifactId('@artifacts')

export function isArtifactsTabScope(scope: FileScope): boolean {
  return scope.kind === 'artifact' && scope.artifactId === ARTIFACTS_TAB_ARTIFACT_ID
}
