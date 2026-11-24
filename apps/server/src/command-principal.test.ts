/**
 * EVERY PRINCIPAL NAMES ITS WORKSPACE (POD-7483, design 4.2), AND SO DOES
 * EVERY CAPABILITY (POD-7558).
 *
 * The helpers stamp the workspace they are given and nothing else, the
 * delegation walk keeps it on an agent, and `actsIn` / `actsInOrReport` are the
 * one comparison every command makes against its store's workspace. The
 * resolver turns a capability into a principal only in the store of the
 * workspace the capability names, only for a member there, and only for an
 * agent whose root session that store says is owned.
 */

import { asSessionId, asUserId, asWorkspaceId, type Capability, type UserId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import {
  actsIn,
  actsInOrReport,
  type DelegationIndex,
  resolvePrincipal,
  resolvePrincipalAsync,
  systemPrincipal,
  userCommandPrincipal,
} from './command-principal'
import { captureLogs } from './test-support/capture-logs'
import { contextPrincipal } from './trpc'

const A = asWorkspaceId('ws_a')
const B = asWorkspaceId('ws_b')
const human = asUserId('mem_person')
const stranger = asUserId('mem_stranger')

const humanCapability: Capability = {
  workspaceId: A,
  role: 'worker',
  scope: { kind: 'owned', userId: human },
  actorUser: human,
  onBehalfOf: human,
}
const agentCapability: Capability = {
  ...humanCapability,
  actorSessionId: asSessionId('child'),
}

/** Workspace A's store: `human` is its member and owns the root session. */
const storeOfA = (overrides: Partial<DelegationIndex> = {}): DelegationIndex => ({
  parentSessionOf: (id) => (id === 'child' ? asSessionId('root') : undefined),
  onBehalfOfFor: (id) => (id === 'root' ? human : undefined),
  isMember: (user: UserId) => user === human,
  ...overrides,
})

/** The thrown refusal, or undefined when the call did not throw. */
const refusalOf = async (run: () => unknown): Promise<unknown> => {
  try {
    await run()
  } catch (error) {
    return error
  }
  return undefined
}

describe('a principal names the workspace it acts in', () => {
  it('stamps the given workspace on a user, its capability, a system job and both resolvers', async () => {
    const member = userCommandPrincipal(A, human, 'member')
    expect(member.workspaceId).toBe(A)
    expect(member.capability.workspaceId).toBe(A)
    expect(systemPrincipal(B, 'steward')).toEqual({
      kind: 'system',
      workspaceId: B,
      job: 'steward',
    })
    expect(resolvePrincipal(A, humanCapability, storeOfA())).toMatchObject({
      kind: 'user',
      workspaceId: A,
    })
    const agent = await resolvePrincipalAsync(A, agentCapability, storeOfA())
    expect(agent).toMatchObject({
      kind: 'agent',
      workspaceId: A,
      agentSessionId: 'child',
      chain: ['root'],
      onBehalfOf: human,
    })
  })

  it('acts only in its own workspace; a mismatch is logged with the two ids and no person', () => {
    const member = userCommandPrincipal(A, human, 'admin')
    const job = systemPrincipal(A, 'expiry')
    expect(actsIn(member, A)).toBe(true)
    expect(actsIn(member, B)).toBe(false)
    expect(actsIn(job, B)).toBe(false)
    const logs = captureLogs()
    try {
      expect(actsInOrReport(member, A, 'test')).toBe(true)
      expect(logs.records).toEqual([])
      expect(actsInOrReport(member, B, 'test')).toBe(false)
      expect(logs.at('warn')).toEqual([
        expect.objectContaining({ where: 'test', principalWorkspace: A, storeWorkspace: B }),
      ])
      expect(logs.text()).not.toContain(human)
    } finally {
      logs.restore()
    }
  })

  it("does not act in a workspace whose principal carries another workspace's capability", () => {
    const member = userCommandPrincipal(A, human, 'admin')
    const mixed = { ...member, capability: { ...member.capability, workspaceId: B } }
    expect(actsIn(mixed, A)).toBe(false)
    expect(actsIn(mixed, B)).toBe(false)
  })

  it('refuses a tRPC context for another workspace as a non-member, so no procedure runs', () => {
    const member = userCommandPrincipal(A, human, 'admin')
    expect(contextPrincipal(member, A)).toBe(member)
    let refused: unknown
    try {
      contextPrincipal(member, B)
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(TRPCError)
    expect(refused).toMatchObject({ code: 'FORBIDDEN', message: 'not_workspace_member' })
  })
})

describe('a capability resolves only in the workspace it was issued in (POD-7558)', () => {
  const notAMember = { code: 'FORBIDDEN', message: 'not_workspace_member' }

  it("refuses a person's and an agent's capability of workspace A in workspace B's store", async () => {
    // B's store would happily answer for this person and session: the refusal
    // comes from the capability's own workspace, before any row is read.
    const reads: string[] = []
    const storeOfB: DelegationIndex = {
      parentSessionOf: (id) => {
        reads.push(`parent:${id}`)
        return undefined
      },
      onBehalfOfFor: (id) => {
        reads.push(`owner:${id}`)
        return human
      },
      isMember: (user) => {
        reads.push(`member:${user}`)
        return true
      },
    }
    const logs = captureLogs()
    try {
      for (const capability of [humanCapability, agentCapability]) {
        const refused = await refusalOf(() => resolvePrincipal(B, capability, storeOfB))
        expect(refused).toBeInstanceOf(TRPCError)
        expect(refused).toMatchObject(notAMember)
        expect(await refusalOf(() => resolvePrincipalAsync(B, capability, storeOfB))).toMatchObject(
          notAMember,
        )
      }
      expect(reads).toEqual([])
      expect(logs.at('warn')[0]).toEqual(
        expect.objectContaining({
          where: 'resolve-principal',
          capabilityWorkspace: A,
          storeWorkspace: B,
        }),
      )
      expect(logs.text()).not.toContain(human)
    } finally {
      logs.restore()
    }
  })

  it('refuses a person who is not a member of the store, even with a capability of its workspace', async () => {
    const outsider: Capability = {
      ...humanCapability,
      scope: { kind: 'owned', userId: stranger },
      actorUser: stranger,
      onBehalfOf: stranger,
    }
    expect(await refusalOf(() => resolvePrincipal(A, outsider, storeOfA()))).toMatchObject(
      notAMember,
    )
    expect(await refusalOf(() => resolvePrincipalAsync(A, outsider, storeOfA()))).toMatchObject(
      notAMember,
    )
  })

  it("takes an agent's human from the store, never from the capability", async () => {
    // The capability claims the stranger; the store says the root is the member's.
    const claimsStranger: Capability = { ...agentCapability, onBehalfOf: stranger }
    expect(await resolvePrincipalAsync(A, claimsStranger, storeOfA())).toMatchObject({
      kind: 'agent',
      onBehalfOf: human,
    })
  })

  it('refuses an agent whose root session has no owner in this store: no fallback to the capability', async () => {
    const noRoot = storeOfA({ onBehalfOfFor: () => undefined })
    // The same answer as a non-member, never an internal error.
    expect(await refusalOf(() => resolvePrincipal(A, agentCapability, noRoot))).toMatchObject(
      notAMember,
    )
    expect(await refusalOf(() => resolvePrincipalAsync(A, agentCapability, noRoot))).toMatchObject(
      notAMember,
    )
  })

  it('refuses an agent whose human is not (or no longer) a member here', async () => {
    const ownedByStranger = storeOfA({ onBehalfOfFor: () => stranger })
    expect(
      await refusalOf(() => resolvePrincipal(A, agentCapability, ownedByStranger)),
    ).toMatchObject(notAMember)
    expect(
      await refusalOf(() => resolvePrincipalAsync(A, agentCapability, ownedByStranger)),
    ).toMatchObject(notAMember)
  })
})
