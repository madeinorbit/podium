/**
 * THE DAY IDENTITY LANDS, THIS FILE FAILS — and that is the whole feature.
 *
 * `openMobileReplica` defaults its attribution evidence to
 * `{kind: 'single-account', principal}`, which `decideLegacyAdoption` defines as
 * "no user identities exist in the system AT ALL, so the store can only be the one
 * operator's". That is true today for one measurable reason and no other:
 * {@link AuthStatus} is `{needsAuth, authed}`, a shared-password gate carrying no
 * user identity (`docs/multi-user-readiness.md` §3.2).
 *
 * WHY A TRIPWIRE RATHER THAN A COMMENT. The failure it prevents is silent by
 * construction. Adding `userId` to `AuthStatus` is a small, obviously-correct change
 * that nothing else in the app would object to — and from that commit onward, this
 * device would go on ADOPTING every legacy store it finds on the `single-account`
 * arm, whose precondition has just become false. There would be no error, no
 * warning, and no test failure anywhere: the arm still exists, the call still
 * succeeds, and one person's queued writes quietly become another's. A comment
 * asking the next author to remember is not a defence against a change they have
 * every reason to believe is safe.
 *
 * WHAT TO DO WHEN IT FAILS: stop passing the default. Build the device's identity
 * ledger and pass `{kind: 'multi-user', signedInAs, identitiesEverSignedIn}` — the
 * gate already has that arm, and `mobile-replica.test.ts` already drives both of its
 * refusing outcomes. Then update the field list below. Do NOT simply add the new
 * field to the list.
 *
 * IT IS ASSERTED TWICE, at both layers, because either alone can be satisfied
 * without the property holding: the type probe cannot see a field the server sends
 * that the interface has not declared, and the runtime check cannot see a declared
 * field the fixture happens not to populate.
 */

import { describe, expect, it } from 'vitest'
import { type AuthStatus, fetchAuthStatus } from './auth'

/** Every field {@link AuthStatus} is allowed to have while `single-account` is a
 *  true statement about this client. Neither name is an identity. */
const NON_IDENTITY_FIELDS = ['needsAuth', 'authed'] as const

/**
 * A type-level refusal.
 *
 * The obvious probe — `const extra: Extra[] = []` — CANNOT FAIL: an empty array
 * satisfies every element type, so it stays green with `Extra = 'userId'`. A
 * CONSTRAINT is what refuses: `AssertNever<'userId'>` does not satisfy `extends
 * never` and the compiler says so, and it fires for an OPTIONAL field too, which
 * the array probe would also have missed.
 */
type AssertNever<T extends never> = T

/** No field beyond the shared-password pair. Fails to compile the day one appears. */
type _NoExtraFields = AssertNever<Exclude<keyof AuthStatus, (typeof NON_IDENTITY_FIELDS)[number]>>
/** And the mirror direction: this list must not name a field that has been removed. */
type _NoMissingFields = AssertNever<Exclude<(typeof NON_IDENTITY_FIELDS)[number], keyof AuthStatus>>

describe('the single-account evidence arm still has a true precondition', () => {
  it('AuthStatus declares NO field beyond the shared-password pair', () => {
    // The assertion is the two type aliases above, which `bun run typecheck` grades
    // before this file is ever executed. This case exists so the requirement is
    // NAMED in the test report rather than living only in a type nobody lists.
    const declared: (keyof AuthStatus)[] = [...NON_IDENTITY_FIELDS]
    expect(declared).toHaveLength(NON_IDENTITY_FIELDS.length)
  })

  it('the PARSER carries no identity through either, whatever the server sends', () => {
    // The type probe cannot see a field the server sends that the interface has not
    // declared. This drives the real `fetchAuthStatus` against a response that DOES
    // carry an identity and requires it to be dropped — so widening the parser
    // before widening the evidence arm is caught here rather than on a device.
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ needsAuth: true, authed: true, userId: 'alice' }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch
    try {
      return fetchAuthStatus('http://example.invalid').then((status) => {
        expect(Object.keys(status).sort()).toEqual([...NON_IDENTITY_FIELDS].sort())
      })
    } finally {
      globalThis.fetch = original
    }
  })
})
