import { describe, expect, it, vi } from 'vitest'
import { indexRevisionFrom, readServedWorkerIdentity } from './sw-identity'

/**
 * Telling two workers apart when they share a scriptURL (POD-3224 follow-up).
 *
 * The regex is reading a MINIFIED artifact from a toolchain whose output shape
 * nobody pins, so the tolerated variants are asserted rather than assumed — a
 * pattern that only matches today's bundler is a field that goes quietly missing
 * after a dependency bump, which is the failure this whole issue is about.
 */
describe('indexRevisionFrom', () => {
  it('reads the revision as vite-plugin-pwa actually emits it', () => {
    // Copied from the served /home/mgw/.local/share/podium/web/sw.js.
    const script =
      'c82a4cdfff43b5575c55d"},{url:"index.html",revision:"0466dc1c13415219dec67aa62ebe1275"},{url:"icon.sv'
    expect(indexRevisionFrom(script)).toBe('0466dc1c13415219dec67aa62ebe1275')
  })

  it('tolerates single quotes, spacing and the reversed field order', () => {
    expect(indexRevisionFrom("{url: 'index.html', revision: 'abc123'}")).toBe('abc123')
    expect(indexRevisionFrom('{revision:"def456",url:"index.html"}')).toBe('def456')
  })

  it('answers undefined rather than guessing when there is no manifest', () => {
    expect(indexRevisionFrom('self.addEventListener("install", () => {})')).toBeUndefined()
    // A precache entry for a DIFFERENT file must not be mistaken for this one.
    expect(indexRevisionFrom('{url:"other.html",revision:"nope"}')).toBeUndefined()
  })
})

describe('readServedWorkerIdentity', () => {
  const respond = (body: string, ok = true) =>
    vi.fn(
      async () => ({ ok, status: ok ? 200 : 404, text: async () => body }) as unknown as Response,
    )

  it('describes the served script by revision and size', async () => {
    const doFetch = respond('{url:"index.html",revision:"rev-1"}')
    const identity = await readServedWorkerIdentity('/sw.js', doFetch as unknown as typeof fetch)

    expect(identity.indexRevision).toBe('rev-1')
    expect(identity.bytes).toBe(35)
    // The point of the fetch: what the SERVER has now, not what a cache kept.
    expect(doFetch).toHaveBeenCalledWith('/sw.js', { cache: 'no-store' })
  })

  it('hashes the bytes when a secure context provides crypto.subtle', async () => {
    const identity = await readServedWorkerIdentity(
      '/sw.js',
      respond('{url:"index.html",revision:"rev-1"}') as unknown as typeof fetch,
    )
    // happy-dom provides SubtleCrypto; if it ever stops, the revision above is
    // the answer that survives, which is why there are two.
    if (globalThis.crypto?.subtle) {
      expect(identity.hash).toMatch(/^[0-9a-f]{12}$/)
    }
  })

  it('reports a failure as an answer — during a restart this is the normal case', async () => {
    const identity = await readServedWorkerIdentity('/sw.js', (async () => {
      throw new Error('Failed to fetch')
    }) as unknown as typeof fetch)
    expect(identity.error).toBe('Failed to fetch')
    expect(identity.hash).toBeUndefined()
  })

  it('reports a non-OK response rather than hashing an error page', async () => {
    const identity = await readServedWorkerIdentity(
      '/sw.js',
      respond('<html>502</html>', false) as unknown as typeof fetch,
    )
    expect(identity.error).toBe('HTTP 404')
  })
})
