/** These source trees include host capabilities that crash browser chunks
 * during evaluation (POD-2176). Only the exact audited browser leaves below
 * may be bundled; optional routes are checked as well as the startup graph. */
const BROWSER_HOSTILE_SOURCES = [
  // Operator replay reads local credentials and must never be a product import.
  'file-viewer-replay.ts',
  'packages/runtime/src/sqlite/',
  'packages/harness/src/',
] as const

/** Exact leaves reached through declared browser entrypoints. The source and
 * bundler browser-reach audits check their complete closure for Node imports. */
const BROWSER_HOSTILE_EXCEPTIONS = [
  'packages/harness/src/browser.ts',
  'packages/harness/src/store/cursor-codec.ts',
  'packages/harness/src/store/stream-identity.ts',
  // cursor-codec re-exports the pure codec from this grammar leaf (POD-2320).
  'packages/harness/src/transcript-types.ts',
  // Pure composer readiness rules and descriptors reached through src/browser.ts.
  'packages/harness/src/adapters/bundled-descriptors.generated.ts',
  'packages/harness/src/adapters/codex/composer.ts',
  // Interview cards use only pure JSON/string helpers.
  'packages/harness/src/adapters/codex/interview.ts',
  // Cursor model/effort ids use pure string helpers, reached through browser.ts.
  'packages/harness/src/adapters/cursor/model-variants.ts',
  'packages/harness/src/adapters/shared/json-util.ts',
  // Version floors are pure data and string parsing.
  'packages/harness/src/version-policy.ts',
  // Retired driver-id aliases: an import-free leaf reached through browser.ts.
  'packages/harness/src/driver-alias.ts',
] as const

export function browserHostileSources(sources: readonly string[]): string[] {
  return [
    ...new Set(
      sources.filter((source) => {
        const normalized = source.replaceAll('\\', '/')
        return (
          BROWSER_HOSTILE_SOURCES.some((fragment) => normalized.includes(fragment)) &&
          !BROWSER_HOSTILE_EXCEPTIONS.some((allowed) => normalized.endsWith(allowed))
        )
      }),
    ),
  ].sort()
}
