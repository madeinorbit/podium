/**
 * Root identity of the exact web + mobile files a fresh client build produced.
 *
 * The per-site manifests travel with the bundle for inspection. This digest is
 * deliberately captured OUTSIDE the archive before packaging, so the archive
 * cannot rewrite both its bytes and the proof the release gate trusts.
 */
import { isAbsolute, join } from 'node:path'
import {
  CLIENT_BUILD_MANIFEST_FILE,
  CLIENT_ROOT_DIGEST_FILE,
  clientBuildRootDigest,
  clientBuildRootDigestFromSites,
} from '../packages/runtime/src/client-build-provenance'

export {
  CLIENT_BUILD_MANIFEST_FILE,
  CLIENT_ROOT_DIGEST_FILE,
  clientBuildRootDigest,
  clientBuildRootDigestFromSites,
}

/**
 * The expected client identity is release-process state, not operator input. Keep the
 * old spellings as explicit refusals so a stale workflow or test cannot silently turn
 * the archive back into its own authority.
 */
export function assertNoCallerSuppliedClientRootDigest(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    argv.some(
      (value) => value === '--client-root-digest' || value.startsWith('--client-root-digest='),
    )
  ) {
    throw new Error(
      '--client-root-digest is forbidden: the release flow captures client provenance itself',
    )
  }
  if (env.PODIUM_EXPECTED_CLIENT_ROOT_DIGEST) {
    throw new Error(
      'PODIUM_EXPECTED_CLIENT_ROOT_DIGEST is forbidden: the release flow captures client provenance itself',
    )
  }
}

function main(): void {
  const raw = process.argv[2]
  if (!raw) {
    console.error('usage: client-build-root-digest.ts <directory-containing-web-and-mobile>')
    process.exit(2)
  }
  const root = isAbsolute(raw) ? raw : join(process.cwd(), raw)
  try {
    console.log(clientBuildRootDigest(root))
  } catch (error) {
    console.error(`[client-build-root-digest] ${(error as Error).message}`)
    process.exit(1)
  }
}

if (import.meta.main) main()
