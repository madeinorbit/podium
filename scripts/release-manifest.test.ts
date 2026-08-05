import { UpdateTarget } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { buildManifest } from './release-manifest'

const platforms = [
  {
    target: 'linux-x86_64',
    url: 'https://x.test/a.tgz',
    signature: 'sig',
    bytes: new Uint8Array([1, 2, 3]),
  },
]

function headlessDigest(manifest: ReturnType<typeof buildManifest>, target = 'linux-x86_64') {
  const artifact = manifest.artifacts.headless
  return artifact?.delivery === 'feed' ? artifact.platforms[target]?.digest : undefined
}

describe('buildManifest', () => {
  it('keeps the shape existing consumers already read', () => {
    // `podium update` and the Tauri updater both read this today. Every addition
    // is additive; nothing may be renamed or retyped.
    const m = buildManifest({ version: '0.4.2', platforms, notes: null, critical: false })
    expect(m).toMatchObject({
      version: '0.4.2',
      platforms: { 'linux-x86_64': { url: 'https://x.test/a.tgz', signature: 'sig' } },
    })
    expect(m.platforms['linux-x86_64']).toEqual({
      url: 'https://x.test/a.tgz',
      signature: 'sig',
    })
  })

  it('adds a content digest per platform artifact', () => {
    const m = buildManifest({ version: '0.4.2', platforms, notes: null, critical: false })
    const artifact = m.artifacts.headless
    expect(artifact?.delivery).toBe('feed')
    if (artifact?.delivery !== 'feed') throw new Error('expected feed artifact')
    expect(artifact.platforms['linux-x86_64']?.digest).toMatch(/^sha256-[A-Za-z0-9+/=]+$/)
  })

  it('produces the same digest for the same bytes and a different one otherwise', () => {
    const a = buildManifest({ version: '0.4.2', platforms, notes: null, critical: false })
    const b = buildManifest({ version: '0.4.3', platforms, notes: null, critical: false })
    const c = buildManifest({
      version: '0.4.2',
      platforms: [{ ...platforms[0]!, bytes: new Uint8Array([9]) }],
      notes: null,
      critical: false,
    })
    expect(headlessDigest(a)).toBe(headlessDigest(b))
    expect(headlessDigest(a)).not.toBe(headlessDigest(c))
  })

  it('carries the web digest so the dialog can tell a web-only release apart', () => {
    const m = buildManifest({
      version: '0.4.2',
      platforms,
      notes: null,
      critical: false,
      webDigest: 'sha256-web',
    })
    expect(m.web).toEqual({ digest: 'sha256-web' })
    expect(m.artifacts.web).toEqual({ digest: 'sha256-web' })
  })

  it('carries notes when there are any', () => {
    const m = buildManifest({
      version: '0.4.2',
      platforms,
      notes: { summary: 'Faster reconnects.' },
      critical: false,
    })
    expect(m.notes?.summary).toBe('Faster reconnects.')
  })

  it('omits notes entirely when there are none, rather than emitting an empty object', () => {
    const m = buildManifest({ version: '0.4.2', platforms, notes: null, critical: false })
    expect(m.notes).toBeUndefined()
  })

  it('emits critical as a boolean field, never as a prose prefix', () => {
    const m = buildManifest({ version: '0.4.2', platforms, notes: null, critical: true })
    expect(m.critical).toBe(true)
    expect(JSON.stringify(m)).not.toContain('CRITICAL:')
  })

  it('emits minRequired only when an operator set it', () => {
    const without = buildManifest({
      version: '0.4.2',
      platforms,
      notes: null,
      critical: false,
    })
    expect(without.critical).toBeUndefined()
    expect(without.minRequired).toBeUndefined()

    const with_ = buildManifest({
      version: '0.4.2',
      platforms,
      notes: null,
      critical: false,
      minRequired: { mobile: { ios: '0.3.9' } },
    })
    expect(with_.minRequired?.mobile?.ios).toBe('0.3.9')
  })

  it('never derives minRequired from the version being cut', () => {
    // Raising the floor strands users whose replacement has not shipped yet, and
    // for a store build is irreversible. It is an operator decision, always.
    const m = buildManifest({ version: '0.4.2', platforms, notes: null, critical: false })
    expect(m.minRequired).toBeUndefined()
  })

  it('emits every prepared platform in the target descriptor', () => {
    const m = buildManifest({
      version: '0.4.2',
      platforms: [
        ...platforms,
        {
          target: 'linux-aarch64',
          url: 'https://x.test/a-arm64.tgz',
          signature: 'sig-arm',
          bytes: new Uint8Array([4, 5, 6]),
        },
      ],
      notes: null,
      critical: false,
    })
    const artifact = m.artifacts.headless
    expect(artifact?.delivery).toBe('feed')
    if (artifact?.delivery !== 'feed') throw new Error('expected feed artifact')
    expect(Object.keys(artifact.platforms)).toEqual(['linux-x86_64', 'linux-aarch64'])
    expect(artifact.platforms['linux-aarch64']?.digest).toMatch(/^sha256-[A-Za-z0-9+/=]+$/)
  })

  it('validates as the Phase 1 UpdateTarget while retaining the feed shape', () => {
    const built = buildManifest({ version: '0.4.2', platforms, notes: null, critical: false })
    const parsed = UpdateTarget.parse(built)
    const artifact = parsed.artifacts.headless
    expect(artifact?.delivery).toBe('feed')
    if (artifact?.delivery !== 'feed') throw new Error('expected feed artifact')
    expect(artifact.platforms['linux-x86_64']?.digest).toBe(headlessDigest(built))
    expect(parsed.critical).toBe(false)
  })
})
