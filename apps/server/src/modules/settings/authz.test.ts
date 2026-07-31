/**
 * THE SETTINGS AUTHORIZATION GATE (POD-421) — what POD-420 declared and nothing
 * read until now.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE HAS TO BE ABLE TO SAY, AND WHY IT IS HARD HERE
 * ---------------------------------------------------------------------------
 *
 * POD-351's failure is the one to avoid: every revocation test ran as OPERATOR,
 * whose scope short-circuits `authorize` before the owner is read, so the suite
 * would have passed against an implementation with no ownership check at all.
 * The settings equivalent is running every case as the first admin — who
 * satisfies every floor — and concluding the floor is enforced.
 *
 * So the decision suite drives `settingsAuthzFailure` DIRECTLY with an explicit
 * role, because the transport cannot yet present a second human
 * (`CLIENT_PRINCIPAL_GRADE` is still `device`; POD-315 owns per-user login).
 * That is the same division `fleet/authz.test.ts` made and for the same reason.
 *
 * ---------------------------------------------------------------------------
 * THE OBLIGATION THIS SUITE WAS ASKED FOR
 * ---------------------------------------------------------------------------
 *
 * From POD-352, on why this gate is load-bearing rather than polish: *"a
 * totality test proves every field is classified, and proves nothing about
 * whether anything reads the classification"* — so for EACH contract, the floor
 * removed must turn a passing case red. `describe('the floor is READ, per
 * contract')` iterates the shipped table and asserts both arms per command, and
 * `describe('this gate can say NO')` proves the suite would notice a gate that
 * permitted everything AND one that refused everything.
 */

import { SETTINGS_COMMAND_NAMES, SETTINGS_CONTRACTS } from '@podium/commands'
import { asUserId, FIRST_ADMIN_USER_ID, type UserRole } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { type CommandPrincipal, systemPrincipal } from '../../command-principal'
import {
  SECRET_SURFACE_ABSENT,
  type SettingsAuthzDeps,
  settingsAuthzFailure,
  settingsCommandsPermitted,
  settingsRoleSatisfiesFloor,
} from './authz'

const person: CommandPrincipal = {
  kind: 'user',
  user: FIRST_ADMIN_USER_ID,
  capability: { role: 'admin', scope: { kind: 'all' } },
}

/** An AGENT delegating from a human — the arm whose rights are its human's, so a
 *  member's agent must be refused exactly where the member is (ADR 9 D5 A1/A2). */
const agent: CommandPrincipal = {
  kind: 'agent',
  agentSessionId: asUserId('sess-1') as never,
  onBehalfOf: FIRST_ADMIN_USER_ID,
  capability: { role: 'admin', scope: { kind: 'all' } },
  chain: [],
}

const deps = (role: UserRole | undefined, principal = person): SettingsAuthzDeps => ({
  principal,
  role,
})

const ADMIN_FLOOR = SETTINGS_COMMAND_NAMES.filter(
  (n) => SETTINGS_CONTRACTS[n].policy.roleFloor === 'admin',
)
const MEMBER_FLOOR = SETTINGS_COMMAND_NAMES.filter(
  (n) => SETTINGS_CONTRACTS[n].policy.roleFloor === 'member',
)

describe('the shipped table actually splits — the claims below are not vacuous', () => {
  it('has BOTH admin-floor and member-floor contracts', () => {
    // Without this, "members are refused admin commands" is satisfiable by a
    // table where everything is admin, and "members may write their own
    // preferences" by one where everything is member. Neither would be
    // enforcement; both would be green.
    expect(ADMIN_FLOOR.length).toBeGreaterThan(0)
    expect(MEMBER_FLOOR.length).toBeGreaterThan(0)
    expect(ADMIN_FLOOR).toContain('settings.setSecret')
    expect(ADMIN_FLOOR).toContain('settings.secretPresence')
    expect(MEMBER_FLOOR).toEqual(['settings.updatePersonal'])
  })
})

describe('the floor is READ, per contract — both arms, for every command', () => {
  for (const name of SETTINGS_COMMAND_NAMES) {
    const floor = SETTINGS_CONTRACTS[name].policy.roleFloor

    it(`${name}: an admin passes`, () => {
      // The POSITIVE arm first. A gate that refused everything would satisfy
      // every refusal assertion in this file perfectly.
      expect(settingsAuthzFailure(name, deps('admin'))).toBeUndefined()
    })

    it(`${name}: a member ${floor === 'admin' ? 'is REFUSED' : 'passes'} — its declared floor`, () => {
      const failure = settingsAuthzFailure(name, deps('member'))
      if (floor === 'admin') {
        expect(failure).toBeDefined()
      } else {
        expect(failure).toBeUndefined()
      }
    })

    it(`${name}: NO readable account is refused, whatever the floor`, () => {
      // `undefined` is not a role — it is "no readable, enabled account" — and it
      // satisfies NO floor, including `member`. This is the arm a `?? 'member'`
      // default anywhere upstream would silently open, and it is the reason the
      // member-floor commands are in this loop rather than exempted from it.
      expect(settingsAuthzFailure(name, deps(undefined))).toBeDefined()
    })
  }
})

describe('an agent is bounded by its human, not by its own capability', () => {
  // Both principals below carry `role: 'admin'` on the CAPABILITY. The floor is
  // compared against the ACCOUNT role of the human at the root of the chain
  // (ADR 9 D1.4), so an admin-capability agent delegating from a member is
  // refused. A gate that read the capability instead would pass this and be
  // wrong in the one direction that matters.
  it('an agent whose human is a member is refused an admin-floor command', () => {
    expect(settingsAuthzFailure('settings.setSecret', deps('member', agent))).toBeDefined()
  })

  it('the same agent whose human is an admin is allowed', () => {
    expect(settingsAuthzFailure('settings.setSecret', deps('admin', agent))).toBeUndefined()
  })
})

describe('a SYSTEM principal has no account and is not given one', () => {
  it('passes every floor', () => {
    // ADR 3 Amendment 1 D21.2: constructed in-process only, unreachable from
    // every transport. It is carved out here rather than by inventing a role for
    // it, because "the steward is an admin" is the service account ADR 9 D8 S5
    // rejects.
    for (const name of SETTINGS_COMMAND_NAMES) {
      expect(settingsAuthzFailure(name, deps(undefined, systemPrincipal('steward')))).toBeUndefined()
    }
  })
})

describe('the refusal is not an existence oracle (readiness §3.1.5)', () => {
  it('the secret READ refuses as NOT_FOUND with the absent-surface string', () => {
    const failure = settingsAuthzFailure('settings.secretPresence', deps('member'))
    expect(failure?.code).toBe('NOT_FOUND')
    // The SAME string an instance with no secret surface would produce. A
    // distinguishable refusal would tell a member whether a key is configured,
    // which is the exact fact the floor is withholding.
    expect(failure?.message).toBe(SECRET_SURFACE_ABSENT)
  })

  it('the refusal does NOT name the command, the floor, or the word admin', () => {
    // The assertion that would fail if someone "improved" the message to be
    // helpful. Helpful here means: confirming there is something to be forbidden
    // from.
    const message = settingsAuthzFailure('settings.secretPresence', deps('member'))?.message ?? ''
    expect(message).not.toContain('secretPresence')
    expect(message.toLowerCase()).not.toContain('admin')
    expect(message.toLowerCase()).not.toContain('forbidden')
  })

  it('a secret WRITE refuses honestly, and the asymmetry is deliberate', () => {
    // A member attempting a write has already been shown a disabled control
    // naming the reason, so the surface's existence is not news and an
    // unexplained failure would be worse product for no security gain.
    const failure = settingsAuthzFailure('settings.setSecret', deps('member'))
    expect(failure?.code).toBe('FORBIDDEN')
    expect(failure?.message).toContain('admin')
  })

  it('the WRITE refusal never carries the material', () => {
    // The gate refuses before the handler and never sees the parsed value, so
    // this is a structural property rather than a scrub. Asserted anyway,
    // because "the message happens not to contain it" is what a later edit
    // changes.
    const message = settingsAuthzFailure('settings.setSecret', deps('member'))?.message ?? ''
    expect(message).not.toContain('sk-')
  })
})

describe('settingsRoleSatisfiesFloor', () => {
  it('admin satisfies both floors; member satisfies only its own', () => {
    expect(settingsRoleSatisfiesFloor('admin', 'admin')).toBe(true)
    expect(settingsRoleSatisfiesFloor('admin', 'member')).toBe(true)
    expect(settingsRoleSatisfiesFloor('member', 'member')).toBe(true)
    expect(settingsRoleSatisfiesFloor('member', 'admin')).toBe(false)
  })

  it('undefined satisfies NOTHING — it is the absence of an account, not a role', () => {
    expect(settingsRoleSatisfiesFloor(undefined, 'member')).toBe(false)
    expect(settingsRoleSatisfiesFloor(undefined, 'admin')).toBe(false)
  })
})

describe('an unknown name refuses — "no rule found" is not "permitted"', () => {
  it('refuses a name the table does not carry', () => {
    expect(settingsAuthzFailure('settings.smuggled', deps('admin'))).toBeDefined()
  })
})

describe('settingsCommandsPermitted — the rendering hint, and what it is NOT', () => {
  it('answers for every shipped contract, and differs by role', () => {
    const asAdmin = settingsCommandsPermitted(deps('admin'))
    const asMember = settingsCommandsPermitted(deps('member'))
    expect(Object.keys(asAdmin).sort()).toEqual([...SETTINGS_COMMAND_NAMES].sort())
    expect(asAdmin['settings.setSecret']).toBe(true)
    expect(asMember['settings.setSecret']).toBe(false)
    // The control: a member is not simply refused everything, or a UI built on
    // this would disable the preference form too and the hint would be useless
    // rather than merely wrong.
    expect(asMember['settings.updatePersonal']).toBe(true)
  })

  it('agrees with the GATE for every command and both roles — one rule, not two', () => {
    // The property that makes disabled-with-reason honest: the control's enabled
    // state and the server's decision come from the same function. A UI
    // computing its own answer is how a control ends up enabled for a write the
    // server refuses, which is the failure the brief names by name.
    for (const role of ['admin', 'member'] as const) {
      const permitted = settingsCommandsPermitted(deps(role))
      for (const name of SETTINGS_COMMAND_NAMES) {
        expect(permitted[name]).toBe(settingsAuthzFailure(name, deps(role)) === undefined)
      }
    }
  })
})
