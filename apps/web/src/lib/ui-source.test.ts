import { describe, expect, it } from 'vitest'
import { navigationSample, uiSource } from './ui-source'

const browser = { protocol: 'https:', hostname: 'podium.example' }
const fromNetwork = { workerStart: 0, transferSize: 4_213 }

describe('uiSource', () => {
  it('names the baked document whatever the timing says', () => {
    expect(uiSource({ protocol: 'tauri:', hostname: 'localhost' }, fromNetwork).kind).toBe('baked')
    expect(uiSource({ protocol: 'https:', hostname: 'tauri.localhost' }, fromNetwork).kind).toBe(
      'baked',
    )
  })

  it('reads a network-served document as the live server', () => {
    expect(uiSource(browser, fromNetwork)).toEqual({ kind: 'live', label: 'Live server' })
  })

  it('reads a worker-answered document with no bytes on the wire as the cache', () => {
    expect(uiSource(browser, { workerStart: 12.5, transferSize: 0 }).kind).toBe('cache')
  })

  it('keeps a worker that went to the network on the live server', () => {
    expect(uiSource(browser, { workerStart: 12.5, transferSize: 4_213 }).kind).toBe('live')
  })

  it('answers unknown rather than live when there is no timing entry', () => {
    expect(uiSource(browser, undefined)).toEqual({ kind: 'unknown', label: 'Not reported' })
  })
})

describe('navigationSample', () => {
  it('takes the first navigation entry', () => {
    const perf = { getEntriesByType: () => [{ workerStart: 3, transferSize: 9 }] }
    expect(navigationSample(perf as unknown as Performance)).toEqual({
      workerStart: 3,
      transferSize: 9,
    })
  })

  it('declines an entry missing either field, and a missing performance object', () => {
    const partial = { getEntriesByType: () => [{ workerStart: 3 }] }
    expect(navigationSample(partial as unknown as Performance)).toBeUndefined()
    expect(
      navigationSample({ getEntriesByType: () => [] } as unknown as Performance),
    ).toBeUndefined()
    expect(navigationSample(undefined)).toBeUndefined()
  })
})
