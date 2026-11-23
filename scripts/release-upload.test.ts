import { describe, expect, it } from 'vitest'
import { publishReleaseAssets } from './release-upload'

describe('manifest-last release publication', () => {
  it.each([
    'edge',
    'dev',
    'v1.2.3',
  ])('keeps the previous %s target fetchable until the new manifest is visible', (tag) => {
    const remote = new Map([
      ['podium-update.json', 'old'],
      ['fixed.tar.gz', 'old'],
    ])
    let advertised = 'fixed.tar.gz'
    const calls: string[][] = []
    publishReleaseAssets(
      {
        tag,
        artifacts: ['versioned.tar.gz', 'versioned.tar.gz.sig'],
        manifest: 'podium-update.json',
        aliases: ['fixed.tar.gz'],
      },
      (args) => {
        calls.push(args)
        expect(remote.has(advertised)).toBe(true)
        expect(remote.get(advertised)).toBe(advertised === 'fixed.tar.gz' ? 'old' : 'new')
        for (const name of args.slice(3, -1)) remote.set(name, 'new')
        if (args.includes('podium-update.json')) {
          expect(remote.get('versioned.tar.gz')).toBe('new')
          expect(remote.get('versioned.tar.gz.sig')).toBe('new')
          advertised = 'versioned.tar.gz'
        }
      },
    )
    expect(calls.map((args) => args.slice(3, -1))).toEqual([
      ['versioned.tar.gz', 'versioned.tar.gz.sig'],
      ['podium-update.json'],
      ['fixed.tar.gz'],
    ])
    expect(remote.get('fixed.tar.gz')).toBe('new')
  })

  it('does not replace the manifest or old aliases after an artifact upload fails', () => {
    const calls: string[][] = []
    expect(() =>
      publishReleaseAssets(
        {
          tag: 'edge',
          artifacts: ['new.tar.gz'],
          manifest: 'podium-update.json',
          aliases: ['old.tar.gz'],
        },
        (args) => {
          calls.push(args)
          throw new Error('upload failed')
        },
      ),
    ).toThrow('upload failed')
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toContain('podium-update.json')
    expect(calls[0]).not.toContain('old.tar.gz')
  })
})
