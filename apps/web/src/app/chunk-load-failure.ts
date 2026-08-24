/**
 * "THE PAGE FOUND OUT BY FAILING" — recognising that shape (POD-2721).
 *
 * When a lazily-imported route cannot be fetched, every browser reports it as a
 * plain `TypeError` whose message is the only structured thing about it. The
 * sandbox produced three of these in ninety seconds:
 *
 *   TypeError: Failed to fetch dynamically imported module:
 *     http://100.113.194.89:32772/assets/SettingsView-WmDcr0IH.js
 *
 * ---------------------------------------------------------------------------
 * THIS IS A HINT, NEVER A VERDICT
 * ---------------------------------------------------------------------------
 *
 * A chunk failing does NOT mean the app was replaced. It also happens when the
 * network dropped mid-navigation, when a proxy mangled a response, and — the
 * case worth protecting — when the server has a genuine asset-serving bug.
 * Reloading on this alone would turn every one of those into a loop, which is
 * precisely the failure POD-2608 already paid for.
 *
 * So this function only decides whether it is worth ASKING the server what it is
 * serving. The answer to "was this page replaced" comes from comparing bundle
 * identities (`classifyAssets`), and nothing here can substitute for it.
 */

/**
 * The wordings browsers use for a failed dynamic import. Chrome and Safari say
 * "dynamically imported module"; Firefox says "error loading dynamically
 * imported module"; Vite's preload helper rethrows as "Unable to preload CSS"
 * or a `Failed to fetch dynamically imported module` of its own.
 */
const CHUNK_FAILURE_PATTERNS = [
  /dynamically imported module/i,
  /error loading dynamically imported/i,
  /failed to fetch dynamically imported/i,
  /unable to preload css/i,
  /^loading chunk \S+ failed/i,
  /importing a module script failed/i,
]

/** Does this message look like a code chunk that could not be fetched? */
export function looksLikeChunkLoadFailure(message: string | null | undefined): boolean {
  if (!message) return false
  return CHUNK_FAILURE_PATTERNS.some((pattern) => pattern.test(message))
}
