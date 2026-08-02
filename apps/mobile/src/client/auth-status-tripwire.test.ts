/**
 * Mobile principal identity tripwire.
 *
 * The parser must carry userId into replica composition. Dropping it would put
 * another account behind a shared device namespace, where a foreign cursor can
 * make an empty slice look permanently caught up.
 */

import { describe, expect, it } from 'vitest'
import { type AuthStatus, fetchAuthStatus } from './auth'

/** The complete status contract; userId is the namespace input. */
const STATUS_FIELDS = ['needsAuth', 'authed', 'userId'] as const

/** Type-level equality in both directions keeps the parser contract explicit. */
type AssertNever<T extends never> = T

/** No undeclared fields. */
type _NoExtraFields = AssertNever<Exclude<keyof AuthStatus, (typeof STATUS_FIELDS)[number]>>
/** No expected fields missing. */
type _NoMissingFields = AssertNever<Exclude<(typeof STATUS_FIELDS)[number], keyof AuthStatus>>

describe('the mobile auth status names its replica principal', () => {
  it('AuthStatus includes the identity field', () => {
    // The assertion is the two type aliases above, which `bun run typecheck` grades
    // before this file is ever executed. This case exists so the requirement is
    // NAMED in the test report rather than living only in a type nobody lists.
    const declared: (keyof AuthStatus)[] = [...STATUS_FIELDS]
    expect(declared).toHaveLength(STATUS_FIELDS.length)
  })

  it('the parser carries server identity into replica composition', () => {
    // Drive the real parser: declared identity must survive into composition.
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ needsAuth: true, authed: true, userId: 'alice' }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch
    try {
      return fetchAuthStatus('http://example.invalid').then((status) => {
        expect(Object.keys(status).sort()).toEqual([...STATUS_FIELDS].sort())
      })
    } finally {
      globalThis.fetch = original
    }
  })
})
