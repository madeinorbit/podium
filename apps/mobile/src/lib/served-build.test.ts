import { describe, expect, it, vi } from 'vitest'
import { readServedBuild, servesNewerBuild } from './served-build'

describe('servesNewerBuild', () => {
  it('offers a refresh when the server serves a build this page is not running', () => {
    expect(servesNewerBuild('0.1.1-edge.1', { appVersion: '0.1.1-edge.2' })).toBe(true)
  })

  it('stays quiet when the served build is the one already running', () => {
    expect(servesNewerBuild('0.1.1-edge.1', { appVersion: '0.1.1-edge.1' })).toBe(false)
  })

  it('stays quiet when either side cannot say what it is', () => {
    // An unstamped page reports the honest `dev`; that is not grounds to tell
    // anyone their page is old.
    expect(servesNewerBuild('dev', { appVersion: '0.1.1-edge.2' })).toBe(false)
    expect(servesNewerBuild('', { appVersion: '0.1.1-edge.2' })).toBe(false)
    expect(servesNewerBuild('0.1.1-edge.1', {})).toBe(false)
    expect(servesNewerBuild('0.1.1-edge.1', undefined)).toBe(false)
  })
})

describe('readServedBuild', () => {
  it('asks the server rather than the cache, and returns the served version', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ appVersion: '0.1.1-edge.2', sourceSha: 'abc' }),
    })) as unknown as typeof fetch

    expect(await readServedBuild(fetchImpl, '/mobile/podium-build.json')).toEqual({
      appVersion: '0.1.1-edge.2',
    })
    expect(fetchImpl).toHaveBeenCalledWith('/mobile/podium-build.json', { cache: 'no-store' })
  })

  it('treats every failure as silence, never as a new build', async () => {
    // The body PARSES and names a version: the only thing that can make this
    // undefined is the status check. A stub with no `json` would pass whether
    // that check existed or not — it would throw its way to the same answer.
    const notFound = vi.fn(async () => ({
      ok: false,
      json: async () => ({ appVersion: '0.1.1-edge.9' }),
    })) as unknown as typeof fetch
    expect(await readServedBuild(notFound)).toBeUndefined()

    const offline = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await readServedBuild(offline)).toBeUndefined()

    const garbage = vi.fn(async () => ({
      ok: true,
      json: async () => 'not an object',
    })) as unknown as typeof fetch
    expect(await readServedBuild(garbage)).toBeUndefined()
  })

  it('reports a stamp with no version as present-but-unversioned', async () => {
    const unversioned = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sourceSha: 'abc' }),
    })) as unknown as typeof fetch
    expect(await readServedBuild(unversioned)).toEqual({})
  })
})
