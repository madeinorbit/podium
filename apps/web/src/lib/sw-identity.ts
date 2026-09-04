/**
 * WHICH SCRIPT A SERVICE WORKER IS RUNNING (POD-3224 follow-up).
 *
 * Every worker on this origin has the same `scriptURL` — `/sw.js` never changes
 * name, by design, because a worker that changed URL could not replace itself.
 * So the logs could see three workers and not tell whether they were three
 * builds or one build three times, which is exactly the question the first live
 * traces raised: every landing shows a worker taking control, and then ~400 ms
 * later an `updatefound` installing another one in ~45 ms with all-precache
 * hits — a shape that says "byte-identical duplicate" but could not be proved.
 *
 * Two independent answers, because each fails differently:
 *
 *  - `hash` — sha-256 of the served bytes, first 12 hex. Exact, and needs
 *    `crypto.subtle`, which only exists in a secure context.
 *  - `indexRevision` — the precache manifest's revision for `index.html`, read
 *    out of the script text. Weaker (it moves only when the HTML moves) but it
 *    needs no crypto and it is the BUILD identity, which is the thing an
 *    operator actually wants to compare across two workers.
 *
 * READ FROM THE PAGE, not from the worker. Nothing about the generated worker
 * changes, no build config moves, and there is no new file to keep in step.
 *
 * IT NEVER THROWS AND NEVER BLOCKS ANYTHING. Callers fire it and log whatever
 * comes back; a failure is itself an answer (`error`), and during a coordinator
 * restart — which is exactly when this gets called — failure is the normal case.
 */

export interface ServedWorkerIdentity {
  /** sha-256 of the served bytes, first 12 hex. Absent without `crypto.subtle`. */
  hash?: string
  /** The precache manifest's revision for `index.html` — the build identity. */
  indexRevision?: string
  /** Byte length of the served script, a free tiebreaker when the hash is absent. */
  bytes?: number
  /** Why there is no answer. Present instead of the above, never beside them. */
  error?: string
}

/**
 * `{url:"index.html",revision:"…"}` as workbox's `injectManifest` emits it.
 *
 * Tolerant of quote style and whitespace, and of the two field orders, because
 * this is reading a MINIFIED artifact produced by a toolchain we do not pin the
 * output shape of — a regex that only matches today's bundler is a field that
 * silently goes missing after a dependency bump.
 */
const INDEX_REVISION = [
  /url\s*:\s*["']index\.html["']\s*,\s*revision\s*:\s*["']([^"']*)["']/,
  /revision\s*:\s*["']([^"']*)["']\s*,\s*url\s*:\s*["']index\.html["']/,
]

export function indexRevisionFrom(script: string): string | undefined {
  for (const pattern of INDEX_REVISION) {
    const found = pattern.exec(script)
    if (found?.[1]) return found[1]
  }
  return undefined
}

async function sha256Prefix(bytes: Uint8Array): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle
  // Absent on a plain-http origin. The revision below still identifies the build,
  // which is why this is one of two answers rather than the only one.
  if (!subtle) return undefined
  const digest = await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}

/**
 * Fetch the served worker script and describe it.
 *
 * `cache: 'no-store'` because the point is what the SERVER has right now — a
 * cached copy would answer the question this exists to settle with the answer
 * that made it a question.
 */
export async function readServedWorkerIdentity(
  url = '/sw.js',
  doFetch: typeof fetch = fetch,
): Promise<ServedWorkerIdentity> {
  try {
    const response = await doFetch(url, { cache: 'no-store' })
    if (!response.ok) return { error: `HTTP ${response.status}` }
    const script = await response.text()
    const bytes = new TextEncoder().encode(script)
    const hash = await sha256Prefix(bytes)
    const indexRevision = indexRevisionFrom(script)
    return {
      ...(hash ? { hash } : {}),
      ...(indexRevision ? { indexRevision } : {}),
      bytes: bytes.byteLength,
    }
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}
