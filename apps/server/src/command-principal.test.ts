/**
 * EVERY PRINCIPAL NAMES ITS WORKSPACE (POD-7483, design 4.2).
 *
 * The helpers stamp the workspace they are given and nothing else, the
 * delegation walk keeps it on an agent, and `actsIn` / `actsInOrReport` are the
 * one comparison every command makes against its store's workspace.
 */

import { asSessionId, asUserId, asWorkspaceId, type Capability } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import {
  actsIn,
  actsInOrReport,
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

const humanCapability: Capability = {
  role: 'worker',
  scope: { kind: 'owned', userId: human },
  actorUser: human,
  onBehalfOf: human,
}
const agentCapability: Capability = {
  ...humanCapability,
  actorSessionId: asSessionId('child'),
}
const parents = {
  parentSessionOf: (id: string) => (id === 'child' ? asSessionId('root') : undefined),
}

describe('a principal names the workspace it acts in', () => {
  it('stamps the given workspace on a user, a system job and both resolvers', async () => {
    expect(userCommandPrincipal(A, human, 'member').workspaceId).toBe(A)
    expect(systemPrincipal(B, 'steward')).toEqual({
      kind: 'system',
      workspaceId: B,
      job: 'steward',
    })
    expect(resolvePrincipal(A, humanCapability, parents)).toMatchObject({
      kind: 'user',
      workspaceId: A,
    })
    const agent = await resolvePrincipalAsync(B, agentCapability, parents)
    expect(agent).toMatchObject({
      kind: 'agent',
      workspaceId: B,
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
