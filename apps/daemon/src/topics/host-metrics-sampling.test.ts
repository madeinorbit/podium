import { asMachineId, type HostMetricsWire } from '@podium/model'
import { topicKey } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostMetricsSampling, hostMetricsFrame } from './host-metrics-sampling'
import { TopicWatchRegistry } from './watch-registry'

const SELF = asMachineId('m-self')
const INTERVAL = 5_000
const KEY = topicKey('machine.metrics', SELF)

function fixture(background = true) {
  const watches = new TopicWatchRegistry()
  const push = vi.fn()
  const sampling = createHostMetricsSampling({
    machineId: SELF,
    intervalMs: INTERVAL,
    background,
    watches,
    push,
  })
  return { watches, push, sampling }
}

describe('host-metrics sampling (ADR 7 Amendment 2 D22)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('on a topics.v1 link with no demand, takes no sample over a full interval', () => {
    const f = fixture()
    f.sampling.linkUp(true)
    vi.advanceTimersByTime(INTERVAL * 3)
    expect(f.push).not.toHaveBeenCalled()
  })

  it('samples at once and every interval while demanded, and stops on topicWatch off', () => {
    const f = fixture()
    f.sampling.linkUp(true)
    f.watches.apply(KEY, true)
    expect(f.push).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(INTERVAL * 2)
    expect(f.push).toHaveBeenCalledTimes(3)
    // Desired state: a repeated on is a no-op.
    f.watches.apply(KEY, true)
    expect(f.push).toHaveBeenCalledTimes(3)
    f.watches.apply(KEY, false)
    vi.advanceTimersByTime(INTERVAL * 3)
    expect(f.push).toHaveBeenCalledTimes(3)
  })

  it('a new link starts with no demand: a watch from the old link does not keep sampling', () => {
    const f = fixture()
    f.sampling.linkUp(true)
    f.watches.apply(KEY, true)
    f.sampling.linkUp(true)
    f.push.mockClear()
    vi.advanceTimersByTime(INTERVAL * 2)
    expect(f.push).not.toHaveBeenCalled()
  })

  it('never samples for another machine', () => {
    const f = fixture()
    f.sampling.linkUp(true)
    f.watches.apply(topicKey('machine.metrics', 'm-other'), true)
    vi.advanceTimersByTime(INTERVAL * 2)
    expect(f.push).not.toHaveBeenCalled()
  })

  it('on an older link keeps the pre-topics always-on timer', () => {
    const f = fixture()
    f.sampling.linkUp(false)
    vi.advanceTimersByTime(INTERVAL * 2)
    expect(f.push).toHaveBeenCalledTimes(2)
    // Moving to a topics link stops it.
    f.sampling.linkUp(true)
    vi.advanceTimersByTime(INTERVAL * 2)
    expect(f.push).toHaveBeenCalledTimes(2)
  })

  it('close stops every sampler', () => {
    const f = fixture()
    f.sampling.linkUp(false)
    f.watches.apply(KEY, true)
    f.sampling.close()
    f.push.mockClear()
    vi.advanceTimersByTime(INTERVAL * 3)
    expect(f.push).not.toHaveBeenCalled()
  })
})

describe('hostMetricsFrame', () => {
  const sample: HostMetricsWire = {
    hostname: 'h',
    sampledAt: '2026-11-08T00:00:00.000Z',
    memory: { totalBytes: 2, availableBytes: 1, swapTotalBytes: 0, swapFreeBytes: 0 },
  }

  it('is a topicPublish on a topics.v1 link and the pre-topics frame otherwise', () => {
    expect(hostMetricsFrame(SELF, sample, true)).toEqual({
      type: 'topicPublish',
      key: KEY,
      payload: sample,
    })
    expect(hostMetricsFrame(SELF, sample, false)).toEqual({ type: 'hostMetrics', ...sample })
  })
})

describe('TopicWatchRegistry', () => {
  it('refuses a producer for a server-produced kind', () => {
    expect(() => new TopicWatchRegistry().register('machine.condition', () => () => {})).toThrow()
  })

  it('ignores unknown and unproduced keys without throwing', () => {
    const watches = new TopicWatchRegistry()
    expect(() => watches.apply('future.kind:x', true)).not.toThrow()
    expect(() => watches.apply(KEY, true)).not.toThrow()
    expect(watches.isRunning(KEY)).toBe(false)
  })
})
