import { describe, expect, it } from 'vitest'
import { buildStampLines, formatBuildStamp, originHost, probeServerVersion } from './build-stamp'

const NBSP = '\u00A0'

describe('originHost', () => {
  it('keeps host and port, drops the scheme and path', () => {
    expect(originHost('http://ludovico:18787')).toBe('ludovico:18787')
    expect(originHost('https://podium.example.com/')).toBe('podium.example.com')
  })

  it('passes through anything that is not a URL', () => {
    expect(originHost('ludovico:18787')).toBe('ludovico:18787')
  })
})

describe('formatBuildStamp', () => {
  it('names the host and both versions once the server has answered', () => {
    expect(
      formatBuildStamp({
        httpOrigin: 'http://ludovico:18787',
        server: { status: 'ok', version: 'dev+1863b42' },
        app: 'dev',
      }),
    ).toBe('ludovico:18787 · server dev+1863b42 · app dev')
  })

  it('marks the server unknown while the first probe is out', () => {
    expect(
      formatBuildStamp({
        httpOrigin: 'http://ludovico:18787',
        server: { status: 'pending' },
        app: '0.4.1',
      }),
    ).toBe('ludovico:18787 · server ? · app 0.4.1')
  })

  it('marks the server unknown when it answers without a version', () => {
    expect(
      formatBuildStamp({
        httpOrigin: 'http://ludovico:18787',
        server: { status: 'ok' },
        app: 'dev',
      }),
    ).toBe('ludovico:18787 · server ? · app dev')
  })

  it('leads with offline and labels the stale version as last', () => {
    expect(
      formatBuildStamp({
        httpOrigin: 'http://ludovico:18787',
        server: { status: 'offline', lastVersion: 'dev+1863b42' },
        app: 'dev',
      }),
    ).toBe('offline · last server dev+1863b42 · app dev')
  })

  it('says offline with no version when it never got one', () => {
    expect(
      formatBuildStamp({
        httpOrigin: 'http://ludovico:18787',
        server: { status: 'offline' },
        app: 'dev',
      }),
    ).toBe('offline · server ? · app dev')
  })

  it('still reports the app version when no server is configured', () => {
    expect(
      formatBuildStamp({ httpOrigin: undefined, server: { status: 'pending' }, app: 'dev' }),
    ).toBe('not configured · app dev')
    expect(formatBuildStamp({ httpOrigin: '   ', server: { status: 'pending' }, app: 'dev' })).toBe(
      'not configured · app dev',
    )
  })
})

describe('buildStampLines', () => {
  const lines = (text: string) => text.split('\n')

  it('puts the host on its own line and the versions on the next', () => {
    expect(
      lines(
        buildStampLines({
          httpOrigin: 'http://ludovico:18787',
          server: { status: 'ok', version: 'dev+1863b42' },
          app: 'dev',
        }),
      ),
    ).toEqual([`ludovico:18787`, `server${NBSP}dev+1863b42 · app${NBSP}dev`])
  })

  it('never leaves a breakable space inside a segment', () => {
    const text = buildStampLines({
      httpOrigin: 'http://ludovico:18787',
      server: { status: 'offline', lastVersion: 'dev+1863b42' },
      app: '0.4.1',
    })
    expect(lines(text)).toEqual([
      'offline',
      `last${NBSP}server${NBSP}dev+1863b42 · app${NBSP}0.4.1`,
    ])
    // The only ordinary spaces left are the ones flanking a separator: those are
    // the wrap points, and there is nowhere else a line can break.
    for (const segment of text.replace(/\n/g, ' · ').split(' · ')) {
      expect(segment).not.toContain(' ')
    }
  })

  it('still splits when there are only two segments', () => {
    expect(
      lines(buildStampLines({ httpOrigin: undefined, server: { status: 'pending' }, app: 'dev' })),
    ).toEqual([`not${NBSP}configured`, `app${NBSP}dev`])
  })
})

describe('probeServerVersion', () => {
  const ok = (body: unknown) =>
    (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch

  it('reads appVersion off /version', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      return { ok: true, json: async () => ({ appVersion: 'dev+1863b42', wireVersion: 2 }) }
    }) as unknown as typeof fetch
    expect(await probeServerVersion('http://ludovico:18787/', fetchImpl)).toEqual({
      version: 'dev+1863b42',
    })
    expect(calls).toEqual(['http://ludovico:18787/version'])
  })

  it('reports a reachable server that names no version as reachable', async () => {
    expect(await probeServerVersion('http://h', ok({ wireVersion: 2 }))).toEqual({
      version: undefined,
    })
  })

  it('is undefined when the server is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    expect(await probeServerVersion('http://h', fetchImpl)).toBeUndefined()
  })

  it('is undefined on a non-200', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch
    expect(await probeServerVersion('http://h', fetchImpl)).toBeUndefined()
  })

  it('is undefined when the body is not JSON', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => {
        throw new Error('not json')
      },
    })) as unknown as typeof fetch
    expect(await probeServerVersion('http://h', fetchImpl)).toBeUndefined()
  })
})
