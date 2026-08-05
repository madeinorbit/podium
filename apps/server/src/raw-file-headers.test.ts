// apps/server/src/raw-file-headers.test.ts
import { describe, expect, it } from 'vitest'
import { rawFileHeaders } from './raw-file-headers'

describe('rawFileHeaders', () => {
  it('sandboxes HTML into an opaque origin while leaving it scriptable', () => {
    const csp =
      rawFileHeaders({ contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache' })[
        'content-security-policy'
      ] ?? ''
    expect(csp).toContain('sandbox')
    expect(csp).toContain('allow-scripts')
    expect(csp).not.toContain('allow-same-origin')
  })

  it('sandboxes anything the browser loads as a top-level document (SVG)', () => {
    const h = rawFileHeaders({
      contentType: 'image/svg+xml',
      cacheControl: 'no-cache',
      secFetchDest: 'document',
    })
    expect(h['content-security-policy']).toContain('sandbox')
  })

  it('leaves subresource loads alone so the markdown preview still embeds SVG', () => {
    const h = rawFileHeaders({
      contentType: 'image/svg+xml',
      cacheControl: 'no-cache',
      secFetchDest: 'image',
    })
    expect(h['content-security-policy']).toBeUndefined()
  })

  it('always pins the type and forbids sniffing', () => {
    const h = rawFileHeaders({ contentType: 'image/png', cacheControl: 'immutable' })
    expect(h['content-type']).toBe('image/png')
    expect(h['cache-control']).toBe('immutable')
    expect(h['x-content-type-options']).toBe('nosniff')
  })
})
