import { describe, expect, it } from 'vitest'
import { createLiveReadCensus } from '../../apps/web/harness/live-read-census'

describe('live sidebar read windows', () => {
  it('excludes startup and late background work from the finished click', () => {
    let at = 2
    const census = createLiveReadCensus(() => at)
    census.record('session:summary')
    at = 10
    census.record('issue:summary')
    at = 15
    census.record('session:load')
    at = 25
    census.record('session:summary')
    expect(census.between(10, 20)).toEqual({
      counts: { 'issue:summary': 1, 'session:load': 1 },
      bucketMs: 1,
    })
    expect(census.counts()['session:summary']).toBe(2)
  })

  it('reports the conservative one-millisecond boundary bucket', () => {
    let at = 10.1
    const census = createLiveReadCensus(() => at)
    census.record('issue:summary')
    at = 10.9
    census.record('issue:summary')
    at = 11
    census.record('issue:summary')
    expect(census.between(10.5, 10.7)).toEqual({
      counts: { 'issue:summary': 2 },
      bucketMs: 1,
    })
  })

  it('bounds retained history during a long capture without losing total counts', () => {
    let at = 0
    const census = createLiveReadCensus(() => at, 100)
    for (; at < 20_000; at++) census.record('session:summary')
    expect(census.bucketCount).toBe(101)
    expect(census.between(0, 100).counts).toEqual({})
    expect(census.counts()).toEqual({ 'session:summary': 20_000 })
    expect(census.between(19_990, 19_999).counts).toEqual({ 'session:summary': 10 })
  })
})
