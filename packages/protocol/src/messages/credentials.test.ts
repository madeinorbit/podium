import { describe, expect, it } from 'vitest'
import { PortableCredentialBundle, PortableCredentialKind } from './credentials.js'

describe('PortableCredentialKind derivation (4.2)', () => {
  it('keeps the same members in the same order on the same wire', () => {
    // The harness members derive from the closed set; 'claude-code-state' is a
    // bundle name, not a harness, and stays local. Order is pinned: it feeds
    // export-dialog listings, not just validation.
    expect([...PortableCredentialKind.options]).toEqual([
      'claude-code',
      'claude-code-state',
      'codex',
      'grok',
    ])
    for (const kind of ['claude-code', 'claude-code-state', 'codex', 'grok'] as const) {
      expect(PortableCredentialKind.safeParse(kind).success).toBe(true)
    }
    for (const kind of ['opencode', 'cursor', 'pi', 'shell', '']) {
      expect(PortableCredentialKind.safeParse(kind).success).toBe(false)
    }
  })

  it('still bounds bundles to the credential kinds', () => {
    const bundle = PortableCredentialBundle.parse({
      kind: 'codex',
      contentBase64: 'e30=',
    })
    expect(bundle.kind).toBe('codex')
    expect(
      PortableCredentialBundle.safeParse({ kind: 'opencode', contentBase64: 'e30=' }).success,
    ).toBe(false)
  })
})
