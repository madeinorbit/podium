import { describe, expect, it } from 'vitest'
import { fencedMemberOf, MEMBER_FENCE_HEADER, memberFenceRefuses } from './member-fence'

const request = (url: string, headers: Record<string, string> = {}) => ({
  url,
  headers: { get: (name: string) => headers[name] ?? null },
})

describe('the member fence', () => {
  it('reads the member from the header, else from the query', () => {
    expect(fencedMemberOf(request('http://h/trpc/x', { [MEMBER_FENCE_HEADER]: 'mem_a' }))).toBe(
      'mem_a',
    )
    expect(fencedMemberOf(request('ws://h/client?v=7&podium_member=mem%5Fb&cap=x'))).toBe('mem_b')
    expect(fencedMemberOf(request('ws://h/client?v=7#podium_member=mem_c'))).toBeUndefined()
    expect(fencedMemberOf(request('http://h/trpc/x'))).toBeUndefined()
  })

  it('refuses only a fenced request whose authenticated member is someone else', () => {
    expect(memberFenceRefuses('mem_a', 'mem_b')).toBe(true)
    expect(memberFenceRefuses('mem_a', 'mem_a')).toBe(false)
    expect(memberFenceRefuses(undefined, 'mem_b')).toBe(false)
    expect(memberFenceRefuses('mem_a', undefined)).toBe(false)
  })
})
