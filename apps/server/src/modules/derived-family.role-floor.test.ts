/**
 * THE FLOOR IS ACTUALLY APPLIED — the WIRING half of PDM-294.
 *
 * `role-floor.test.ts` drives the decision directly and proves it answers
 * correctly for every admin-floor contract the derived families ship. It cannot
 * prove the builder CALLS it: delete the two lines in
 * `derivedFamilyProcedures` that throw the refusal and that suite stays green,
 * which is false-green catalogue entry 20 — a real rule that nothing witnesses.
 *
 * So this file goes through the REAL `appRouter`, over a REAL store, with REAL
 * user rows of two different grades. Nothing about the decision is mocked: the
 * role comes back from `users.roleOf` against rows this test inserted, and the
 * floor comes off the shipped contract.
 *
 * ---------------------------------------------------------------------------
 * WHY THREE FAMILIES AND NOT ONE
 * ---------------------------------------------------------------------------
 *
 * The defect PDM-294 fixed was never "accounts has no gate" — it was that ONE
 * builder served thirteen family surfaces without reading `contract.policy`, so
 * every family without a gate of its own had the same hole and a fourteenth
 * would inherit it. A witness over `accounts` alone would pass against a repair
 * that added one `accounts/authz.ts` and left the mechanism able to produce the
 * defect again. `accounts`, `perf` and `logs` are three separate modules with
 * three separate service selectors, so all three passing says the BUILDER is
 * enforcing rather than three files each remembering to.
 *
 * ---------------------------------------------------------------------------
 * AND THE GATE MUST BE WRONG IN NEITHER DIRECTION
 * ---------------------------------------------------------------------------
 *
 * Catalogue entry 1 is the matcher that was wrong in both directions at once. A
 * gate that refused EVERYTHING would pass every refusal assertion here, so each
 * admin-floor case is paired with the same call succeeding for an admin — and
 * `models.refresh`, a MEMBER-floor contract on the same builder, is asserted to
 * treat the two grades IDENTICALLY. That is the statement that actually pins the
 * behaviour: the gate discriminates on the contract's declared floor, not on who
 * is asking.
 */

import { asAccountId, asUserId, type UserId, type UserRole } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { userCommandPrincipal } from '../command-principal'
import { SuperagentService } from '../modules/superagent'
import { SessionRegistry } from '../relay'
import { RepoRegistry } from '../repo-registry'
import { appRouter } from '../router'

const ADMIN = asUserId('user:pdm294-admin')
const MEMBER = asUserId('user:pdm294-member')

const registries: SessionRegistry[] = []

type Caller = ReturnType<typeof appRouter.createCaller>

/**
 * A booted store with two real accounts, and a caller for each.
 *
 * NEITHER CALLER IS THE FIRST ADMIN and neither wears an unconstrained
 * capability: `userCommandPrincipal` builds a `worker` capability scoped to the
 * member's own rows, so nothing here can be decided by an admin short circuit
 * the way catalogue entry 14 describes. The grade the gate reads is the one in
 * the users table, which is the only place it is written.
 */
async function harness(): Promise<{
  admin: Caller
  member: Caller
  accounts: SessionRegistry['sessionStore']['accounts']
}> {
  const registry = await SessionRegistry.create(undefined, undefined, {
    instanceId: 'role-floor-test',
  })
  registries.push(registry)
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)

  const mint = async (id: UserId, role: UserRole): Promise<Caller> => {
    await registry.sessionStore.users.create(
      {
        id,
        displayName: id,
        email: null,
        role,
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      'scrypt$not-a-real-hash',
    )
    const principal = userCommandPrincipal(id, role)
    return appRouter.createCaller({
      registry,
      repos,
      superagent,
      capability: principal.capability,
      principal,
    } as Parameters<typeof appRouter.createCaller>[0])
  }

  return {
    admin: await mint(ADMIN, 'admin'),
    member: await mint(MEMBER, 'member'),
    accounts: registry.sessionStore.accounts,
  }
}

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.dispose()
})

/** The refusal, spelled once. Asserted BY NAME per the epic's verification
 *  shape: a member must be refused with a message that says which command. */
const refusalFor = (qualified: string): RegExp =>
  new RegExp(`${qualified.replace('.', '\\.')} requires an admin account`)

/**
 * ACCOUNTS NOW WITNESSES THE OPPOSITE OF WHAT IT DID, AND THAT IS THE POINT.
 *
 * Under PDM-294 these two cases asserted that a member is REFUSED `connect` and
 * `disconnect`. PDM-280 keyed managed credentials `(owner_user_id, id)` and
 * PDM-302 dropped both floors to `member`, so a member must now succeed — the
 * human-facing defect was a member told to set their key in Settings by a
 * server that would refuse them.
 *
 * A "member can now do it" test on its own would pass against a gate that had
 * been deleted outright, which is why the second case is here: THE FLOOR CAME
 * DOWN, THE ISOLATION DID NOT. The member's write must land in the member's
 * row and leave the admin's untouched, read back off the store rather than
 * inferred from a resolved promise. That assertion is the one that fails if the
 * per-person keying is ever reverted, and it is what makes dropping the floor
 * safe rather than merely convenient.
 *
 * The BUILDER is still witnessed either way: `perf` and `logs` below carry the
 * admin arm independently, so accounts leaving the admin-floor set costs this
 * file none of its coverage of the gate itself.
 */
describe('accounts — a credential that belongs to one person', () => {
  const KEY = { provider: 'anthropic', kind: 'api-key', credential: 'sk-not-a-real-key' }
  const connectAs = async (caller: Caller, credential: string): Promise<unknown> =>
    await caller.accounts.connect({ ...KEY, credential } as Parameters<
      typeof caller.accounts.connect
    >[0])

  it('lets a member connect their OWN key, which the admin floor used to refuse', async () => {
    const { member, accounts } = await harness()

    await expect(connectAs(member, 'sk-member-key')).resolves.toEqual({ id: 'managed:anthropic' })

    // Landed in the member's credentials, named. A resolved promise alone would
    // also be produced by a handler that wrote nothing.
    const stored = await accounts.get(MEMBER, 'managed:anthropic')
    expect(stored?.provider).toBe('anthropic')
  })

  it('still cannot reach anyone else — the floor came down, the isolation did not', async () => {
    const { admin, member, accounts } = await harness()

    await connectAs(admin, 'sk-admin-key')
    await connectAs(member, 'sk-member-key')

    // Two people, one slot NAME, two rows. If the row were an instance
    // singleton again the second connect would have overwritten the first.
    expect((await accounts.get(ADMIN, 'managed:anthropic'))?.credential).toBe('sk-admin-key')
    expect((await accounts.get(MEMBER, 'managed:anthropic'))?.credential).toBe('sk-member-key')

    // `disconnect` takes a caller-supplied id and the id space is guessable, so
    // this is the reachable attack if keying were reverted: the member asks to
    // remove the slot by name. It resolves — the contract's errorConsistency
    // says an unreachable row fails as a nonexistent one, silently — and the
    // admin's row must survive it.
    await expect(
      member.accounts.disconnect({ id: asAccountId('managed:anthropic') }),
    ).resolves.toEqual({ ok: true })

    expect((await accounts.get(ADMIN, 'managed:anthropic'))?.credential).toBe('sk-admin-key')
    expect(await accounts.get(MEMBER, 'managed:anthropic')).toBeUndefined()
  })

  it('accounts.login KEPT its admin floor, so the family split is witnessed here too', async () => {
    const { member } = await harness()
    // A VALID harness, deliberately: an invalid one is rejected by the input
    // schema before the gate is reached, and would assert nothing about the
    // floor. `refusalFor` matches the floor's own wording, not any refusal.
    await expect(member.accounts.login({ harness: 'claude-code' })).rejects.toThrow(
      refusalFor('accounts.login'),
    )
  })
})

describe('perf — a second family on the same builder', () => {
  it('refuses a member BY NAME and serves the same call to an admin', async () => {
    const { admin, member } = await harness()
    await expect(member.perf.reset()).rejects.toThrow(refusalFor('perf.reset'))
    await expect(admin.perf.reset()).resolves.toEqual({ ok: true })
  })
})

describe('logs — a third family on the same builder', () => {
  it('refuses a member BY NAME and serves the same call to an admin', async () => {
    const { admin, member } = await harness()
    await expect(member.logs.setLevel({ level: null })).rejects.toThrow(refusalFor('logs.setLevel'))
    await expect(admin.logs.setLevel({ level: null })).resolves.toBeDefined()
  })
})

describe('the gate is not wrong in the other direction', () => {
  /**
   * `models.refresh` declares `roleFloor: 'member'` and is served through the
   * same builder. Its handler may well fail here — there is no machine to
   * refresh a catalog on — and that is fine and is the point: what must be true
   * is that BOTH grades get the SAME answer, so nothing about the outcome was
   * decided by the caller's grade. A gate that had closed over every contract
   * would refuse the member and serve the admin, and this would fail.
   */
  it('treats a member and an admin identically for a member-floor command', async () => {
    const { admin, member } = await harness()
    const outcome = async (caller: Caller): Promise<string> => {
      try {
        await caller.models.refresh()
        return 'served'
      } catch (error) {
        return `threw: ${(error as Error).message}`
      }
    }

    const asMember = await outcome(member)
    expect(asMember).not.toMatch(/requires an admin account/)
    expect(asMember).toBe(await outcome(admin))
  })
})
