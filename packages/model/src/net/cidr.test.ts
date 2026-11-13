import { describe, expect, it } from 'vitest'
import { CidrRange, cidrContains, parseCidr } from './cidr'

describe('parseCidr', () => {
  it.each([
    ['192.168.1.0/24', 4, 24],
    ['10.0.0.0/8', 4, 8],
    ['0.0.0.0/0', 4, 0],
    ['100.64.0.1/32', 4, 32],
    ['fd00::/8', 6, 8],
    ['fd7a:115c:a1e0::/48', 6, 48],
    ['::1/128', 6, 128],
    ['::/0', 6, 0],
  ] as const)('reads %s', (text, family, prefix) => {
    expect(parseCidr(text)).toMatchObject({ family, prefix })
  })

  it.each([
    '',
    'not-a-network',
    '192.168.1.0',
    '192.168.1.0/33',
    '192.168.1.0/-1',
    '192.168.1.0/2x',
    '192.168.1/24',
    '256.1.1.1/8',
    '1.2.3.04/8',
    'fd00::/129',
    'fd00:::1/64',
    '1:2:3:4:5:6:7:8:9/64',
    'fd00::1::2/64',
    ' 10.0.0.0/8',
  ])('refuses %j', (text) => {
    expect(parseCidr(text)).toBeNull()
  })
})

describe('cidrContains', () => {
  it('matches addresses inside an IPv4 range and not outside it', () => {
    expect(cidrContains('192.168.1.0/24', '192.168.1.77')).toBe(true)
    expect(cidrContains('192.168.1.0/24', '192.168.2.1')).toBe(false)
  })

  it('uses the network of a range written with host bits', () => {
    expect(cidrContains('10.0.0.5/8', '10.200.3.4')).toBe(true)
  })

  it('matches an IPv4-mapped IPv6 address against an IPv4 range', () => {
    expect(cidrContains('192.168.1.0/24', '::ffff:192.168.1.5')).toBe(true)
    expect(cidrContains('192.168.1.0/24', '::ffff:10.0.0.1')).toBe(false)
  })

  it('matches IPv6 ranges, compressed and bracketed addresses included', () => {
    expect(cidrContains('fd00::/8', 'fd12:3456::1')).toBe(true)
    expect(cidrContains('fd00::/8', '[fd12::1]')).toBe(true)
    expect(cidrContains('fd00::/8', 'fe80::1')).toBe(false)
  })

  it('never matches across families or a malformed range or address', () => {
    expect(cidrContains('fd00::/8', '10.0.0.1')).toBe(false)
    expect(cidrContains('10.0.0.0/8', 'fd00::1')).toBe(false)
    expect(cidrContains('nonsense', '10.0.0.1')).toBe(false)
    expect(cidrContains('10.0.0.0/8', 'nonsense')).toBe(false)
  })
})

describe('CidrRange', () => {
  it('accepts a range and refuses anything else with a sentence that shows the form', () => {
    expect(CidrRange.safeParse('10.0.0.0/8').success).toBe(true)
    const refused = CidrRange.safeParse('10.0.0.0')
    expect(refused.success).toBe(false)
    expect(refused.error?.issues[0]?.message).toBe(
      'Not a network range. Write it like 192.168.1.0/24 or fd00::/8.',
    )
  })
})
