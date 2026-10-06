import { describe, expect, it } from 'vitest'
import { bareClockReads, checkClockReads } from './check-clock-reads'

describe('clock read fence', () => {
  it('rejects ordinary, optional, indexed and aliased clock reads', () => {
    expect(bareClockReads(`
      const ticker = pool.clock;
      const alias = ticker;
      clock.current;
      pool.clock?.current;
      pool['clock']['current'];
      alias.current;
      function read(time: DeadlineClock) { return time.current }
    `)).toHaveLength(5)
  })
  it('allows tracked time, explicit deadline maintenance and ordinary React refs', () => {
    expect(bareClockReads(`pool.clock.trackedNow(); pool.clock.peekNow(); now.current; ref.current;`)).toEqual([])
  })
  it('keeps product readers behind the clock API', () => {
    expect(checkClockReads()).toEqual([])
  })
})
