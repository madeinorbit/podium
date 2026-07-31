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
import type { AuthStatus } from './auth'

/** Every field {@link AuthStatus} is allowed to have while `single-account` is a
 *  true statement about this client. Neither name is an identity. */
const NON_IDENTITY_FIELDS = ['needsAuth', 'authed'] as const

describe('the single-account evidence arm still has a true precondition', () => {
  it('AuthStatus declares NO field beyond the shared-password pair', () => {
    // A compile-time probe: the day `AuthStatus` gains a member, `Extra` stops being
    // `never` and this assignment is a TYPE error — caught by `bun run typecheck`
    // before the runtime assertion below ever runs.
    type Extra = Exclude<keyof AuthStatus, (typeof NON_IDENTITY_FIELDS)[number]>
    const noExtraFields: Extra[] = []
    expect(noExtraFields).toEqual([])

    // And the mirror direction: a field REMOVED from AuthStatus must not leave this
    // list silently naming something that no longer exists.
    type Missing = Exclude<(typeof NON_IDENTITY_FIELDS)[number], keyof AuthStatus>
    const noMissingFields: Missing[] = []
    expect(noMissingFields).toEqual([])
  })

  it('a parsed AuthStatus carries no identity at runtime either', () => {
    // Shaped exactly as `fetchAuthStatus` returns it. If the parser starts carrying
    // a principal through, the key set moves and this fails even though the
    // interface above may not have been updated yet.
    const parsed: AuthStatus = { needsAuth: true, authed: true }
    expect(Object.keys(parsed).sort()).toEqual([...NON_IDENTITY_FIELDS].sort())
  })
})
