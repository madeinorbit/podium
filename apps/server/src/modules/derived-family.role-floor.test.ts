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
async function harness(): Promise<{ admin: Caller; member: Caller }> {
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

  return { admin: await mint(ADMIN, 'admin'), member: await mint(MEMBER, 'member') }
}

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.dispose()
})

/** The refusal, spelled once. Asserted BY NAME per the epic's verification
 *  shape: a member must be refused with a message that says which command. */
const refusalFor = (qualified: string): RegExp =>
  new RegExp(`${qualified.replace('.', '\\.')} requires an admin account`)

describe('accounts — the credential every agent on the instance bills against', () => {
  it('refuses a member BY NAME and serves the same call to an admin', async () => {
    const { admin, member } = await harness()
    const input = { id: asAccountId('managed:anthropic') }

    await expect(member.accounts.disconnect(input)).rejects.toThrow(
      refusalFor('accounts.disconnect'),
    )
    await expect(admin.accounts.disconnect(input)).resolves.toEqual({ ok: true })
  })

  it('refuses a member to CONNECT a credential, which is the write that costs money', async () => {
    const { member } = await harness()
    await expect(
      member.accounts.connect({
        provider: 'anthropic',
        kind: 'api-key',
        credential: 'sk-not-a-real-key',
      } as Parameters<typeof member.accounts.connect>[0]),
    ).rejects.toThrow(refusalFor('accounts.connect'))
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
