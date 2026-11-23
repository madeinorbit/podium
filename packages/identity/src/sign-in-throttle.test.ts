/**
 * The sign-in budget (POD-6754 finding F1 and its review): identifier churn
 * must not lift a live lock, a full lock table must deny nobody else, one
 * source cannot mint more than a few identifier locks, and memory stays
 * bounded.
 */
import { describe, expect, it } from 'vitest'
import { Lockouts, SignInThrottle, sourceKeyOf } from './sign-in'

const NOW = 1_000_000
const failTimes = (
  throttle: SignInThrottle,
  identifier: string,
  source: string | null,
  times: number,
  now = NOW,
) => {
  for (let attempt = 0; attempt < times; attempt += 1) throttle.failed(identifier, source, now)
}

describe('sign-in throttle', () => {
  it('keeps a locked identifier locked while other identifiers churn', () => {
    const throttle = new SignInThrottle()
    const victim = 'victim@example.test'
    failTimes(throttle, victim, '198.51.100.1', 8)
    expect(throttle.lockedFor(victim, '198.51.100.1', NOW)).toBe(300)

    // 10,000 failures for other identifiers, each from a source of its own.
    for (let noise = 0; noise < 10_000; noise += 1) {
      throttle.failed(`noise-${noise}@example.test`, `10.0.${noise >> 8}.${noise & 255}`, NOW)
    }

    expect(throttle.lockedFor(victim, '203.0.113.50', NOW)).toBe(300)
    expect(throttle.lockedFor(victim, '203.0.113.50', NOW + 300_000)).toBe(0)
  })

  it('a full lock table denies no identifier it has not locked', () => {
    // Every lock slot is taken by an attacker's made-up addresses.
    const throttle = new SignInThrottle({ identifier: { maxLocks: 2 } })
    failTimes(throttle, 'made-up-1@example.test', null, 8)
    failTimes(throttle, 'made-up-2@example.test', null, 8)
    expect(throttle.size.identifiers.locks).toBe(2)
    // A member nobody attacked still signs in.
    expect(throttle.lockedFor('member@example.test', null, NOW)).toBe(0)
    // A third identifier that reaches its limit is held in its count: refused
    // itself, while nobody else is.
    failTimes(throttle, 'made-up-3@example.test', null, 8)
    expect(throttle.lockedFor('made-up-3@example.test', null, NOW)).toBe(300)
    expect(throttle.lockedFor('member@example.test', null, NOW)).toBe(0)
    expect(throttle.size.identifiers.locks).toBe(2)
    // The live locks stay.
    expect(throttle.lockedFor('made-up-1@example.test', null, NOW)).toBe(300)
    // The hold ends like a lock, with a fresh budget.
    expect(throttle.lockedFor('made-up-3@example.test', null, NOW + 300_000)).toBe(0)
    throttle.failed('made-up-3@example.test', null, NOW + 300_000)
    expect(throttle.lockedFor('made-up-3@example.test', null, NOW + 300_000)).toBe(0)
  })

  it('churn cannot evict a hold; with every slot held, a new key is uncounted, never refused', () => {
    const lockouts = new Lockouts({
      maxFailures: 2,
      lockMs: 60_000,
      windowMs: Number.POSITIVE_INFINITY,
      maxCounts: 2,
      maxLocks: 1,
    })
    for (const key of ['a', 'b', 'c']) {
      lockouts.failed(key, NOW)
      lockouts.failed(key, NOW)
    }
    expect(lockouts.size).toEqual({ counts: 2, locks: 1 })
    for (let n = 0; n < 100; n += 1) lockouts.failed(`noise-${n}`, NOW)
    expect([
      lockouts.lockedFor('a', NOW),
      lockouts.lockedFor('b', NOW),
      lockouts.lockedFor('c', NOW),
    ]).toEqual([60, 60, 60])
    lockouts.failed('d', NOW)
    lockouts.failed('d', NOW)
    expect(lockouts.lockedFor('d', NOW)).toBe(0)
    expect(lockouts.size).toEqual({ counts: 2, locks: 1 })
  })

  it('an unknown source is not budgeted', () => {
    const throttle = new SignInThrottle()
    for (let n = 0; n < 100; n += 1) throttle.failed(`made-up-${n}@example.test`, null, NOW)
    expect(throttle.lockedFor('member@example.test', null, NOW)).toBe(0)
    expect(throttle.size.sources).toEqual({ counts: 0, locks: 0 })
  })

  it('one source cannot mint more than a few identifier locks', () => {
    const throttle = new SignInThrottle()
    const attacker = '203.0.113.9'
    // As the sign-in does: a refused attempt is not counted.
    for (let n = 0; n < 1_000; n += 1) {
      if (throttle.lockedFor(`made-up-${n % 50}@example.test`, attacker, NOW) > 0) continue
      throttle.failed(`made-up-${n % 50}@example.test`, attacker, NOW)
    }
    // Thirty failures locked the source; the rest were refused before they counted.
    expect(throttle.lockedFor('anyone@example.test', attacker, NOW)).toBe(300)
    expect(throttle.size.identifiers.locks).toBe(0)
    // Thirty failures on a few identifiers lock at most three of them.
    const focused = new SignInThrottle()
    for (let n = 0; n < 1_000; n += 1) {
      if (focused.lockedFor(`made-up-${n % 4}@example.test`, attacker, NOW) > 0) continue
      focused.failed(`made-up-${n % 4}@example.test`, attacker, NOW)
    }
    expect(focused.size.identifiers.locks).toBeLessThanOrEqual(3)
  })

  it('a locked source denies only itself', () => {
    const throttle = new SignInThrottle()
    failTimes(throttle, 'guess@example.test', '203.0.113.9', 30)
    expect(throttle.lockedFor('member@example.test', '203.0.113.9', NOW)).toBe(300)
    expect(throttle.lockedFor('member@example.test', '198.51.100.7', NOW)).toBe(0)
    // Its whole IPv6 /64 is one source; the next /64 is another.
    failTimes(throttle, 'guess@example.test', '2001:db8:1:2::1', 30)
    expect(throttle.lockedFor('member@example.test', '2001:db8:1:2:ffff::9', NOW)).toBe(300)
    expect(throttle.lockedFor('member@example.test', '2001:db8:1:3::1', NOW)).toBe(0)
  })

  it('does not budget a loopback source, which a local proxy shares with every client', () => {
    const throttle = new SignInThrottle()
    for (let n = 0; n < 100; n += 1) throttle.failed(`made-up-${n}@example.test`, '127.0.0.1', NOW)
    expect(throttle.lockedFor('member@example.test', '127.0.0.1', NOW)).toBe(0)
    expect(throttle.size.sources).toEqual({ counts: 0, locks: 0 })
  })

  it('counts source failures in a five-minute window', () => {
    const throttle = new SignInThrottle()
    failTimes(throttle, 'typo@example.test', '198.51.100.7', 6, NOW)
    failTimes(throttle, 'other@example.test', '198.51.100.7', 6, NOW + 100_000)
    failTimes(throttle, 'third@example.test', '198.51.100.7', 6, NOW + 200_000)
    failTimes(throttle, 'fourth@example.test', '198.51.100.7', 6, NOW + 300_000)
    failTimes(throttle, 'fifth@example.test', '198.51.100.7', 6, NOW + 350_000)
    expect(throttle.lockedFor('member@example.test', '198.51.100.7', NOW + 350_000)).toBe(0)
  })

  it('a success clears the identifier but not the source', () => {
    const throttle = new SignInThrottle()
    failTimes(throttle, 'a@example.test', '198.51.100.7', 7)
    throttle.succeeded('a@example.test')
    throttle.failed('a@example.test', '198.51.100.7', NOW)
    expect(throttle.lockedFor('a@example.test', null, NOW)).toBe(0)
    failTimes(throttle, 'b@example.test', '198.51.100.7', 22)
    expect(throttle.lockedFor('c@example.test', '198.51.100.7', NOW)).toBe(300)
  })

  it('stays within its bounds', () => {
    const lockouts = new Lockouts({
      maxFailures: 2,
      lockMs: 60_000,
      windowMs: Number.POSITIVE_INFINITY,
      maxCounts: 3,
      maxLocks: 2,
    })
    for (let n = 0; n < 100; n += 1) {
      lockouts.failed(`key-${n}`, NOW)
      lockouts.failed(`key-${n}`, NOW)
    }
    expect(lockouts.size.counts).toBeLessThanOrEqual(3)
    expect(lockouts.size.locks).toBe(2)
  })

  it('reads an IPv6 address as its /64', () => {
    expect(sourceKeyOf('2001:db8::1')).toBe(sourceKeyOf('2001:0db8:0000:0000:ffff::2'))
    expect(sourceKeyOf('[2001:DB8::1]')).toBe('2001:db8:0:0::/64')
    expect(sourceKeyOf('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
    expect(sourceKeyOf('198.51.100.7')).toBe('198.51.100.7')
    expect(sourceKeyOf('::ffff:198.51.100.7')).toBe('::ffff:198.51.100.7')
    expect(sourceKeyOf('not:an:address::x')).toBe('not:an:address::x')
  })
})
