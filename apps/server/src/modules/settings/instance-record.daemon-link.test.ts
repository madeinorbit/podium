/**
 * `daemonLink.trustedNetworks` (credential management §8): which networks a
 * daemon may connect over without TLS and still count as safe for credentials.
 * An admin PERSON writes it; a member, an agent acting for an admin, and a value
 * that is not a network range are refused, and nothing moves.
 */

import {
  asSessionId,
  asUserId,
  firstAdminMemberId,
  INSTANCE_PREFERENCES_ROW_ID,
} from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { type CommandPrincipal, userCommandPrincipal } from '../../command-principal'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import { memberFacts } from '../../store/fixtures/test-support'
import { disposeOracles, makeOracle, type Oracle } from '../sessions/oracle-support'
import { envelope } from '../sync-write/outbox-test-support'

afterEach(() => disposeOracles())

const ADMIN = firstAdminMemberId()
const ID = INSTANCE_PREFERENCES_ROW_ID

const edit = (patch: Record<string, unknown>, key: string) =>
  envelope('records.instancePreferences.edit', { id: ID, patch }, key)

const submitAs = (
  o: Oracle,
  principal: CommandPrincipal,
  patch: Record<string, unknown>,
  key: string,
) => o.reg.modules.syncWrite.submit(edit(patch, key), principal, 'trpc')

const trusted = async (o: Oracle) =>
  (await o.store.settings.getSettings()).daemonLink.trustedNetworks

/** An agent session acting for the admin, with the admin's capability. */
function agentForAdmin(): CommandPrincipal {
  const human = userCommandPrincipal(SELF_HOSTED_WORKSPACE_ID, ADMIN, 'admin')
  const agentSessionId = asSessionId('s-agent-6922')
  return {
    kind: 'agent',
    workspaceId: SELF_HOSTED_WORKSPACE_ID,
    agentSessionId,
    onBehalfOf: ADMIN,
    capability: { ...human.capability, actorSessionId: agentSessionId },
    chain: [],
  }
}

describe('daemonLink.trustedNetworks', () => {
  it('an admin writes IPv4 and IPv6 ranges, and the instance reads them', async () => {
    const o = await makeOracle()
    const reply = await submitAs(
      o,
      userCommandPrincipal(SELF_HOSTED_WORKSPACE_ID, ADMIN, 'admin'),
      { 'daemonLink.trustedNetworks': ['10.1.0.0/16', 'fd7a:115c:a1e0::/48'] },
      'tn-admin',
    )
    expect(reply.outcome).toBe('applied')
    expect(await trusted(o)).toEqual(['10.1.0.0/16', 'fd7a:115c:a1e0::/48'])
  })

  it('refuses a member who is not an admin', async () => {
    const o = await makeOracle()
    const member = asUserId('user:member-6922')
    await memberFacts(o.store).create({
      id: member,
      displayName: 'member',
      email: null,
      role: 'member',
      createdAt: new Date().toISOString(),
      disabledAt: null,
    })
    const reply = await submitAs(
      o,
      userCommandPrincipal(SELF_HOSTED_WORKSPACE_ID, member, 'member'),
      { 'daemonLink.trustedNetworks': ['10.0.0.0/8'] },
      'tn-member',
    )
    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
    expect(await trusted(o)).toEqual([])
  })

  it('refuses an agent principal, even one acting for an admin', async () => {
    const o = await makeOracle()
    const reply = await submitAs(
      o,
      agentForAdmin(),
      { 'daemonLink.trustedNetworks': ['10.0.0.0/8'] },
      'tn-agent',
    )
    expect(reply.outcome).toBe('rejected')
    expect(await trusted(o)).toEqual([])
    // The positive control: the same agent may still write another instance leaf.
    const other = await submitAs(o, agentForAdmin(), { 'steward.enabled': false }, 'tn-agent-other')
    expect(other.outcome).toBe('applied')
  })

  it.each([
    ['not-a-network'],
    ['10.0.0.0'],
    ['10.0.0.0/33'],
    ['fd00::/129'],
  ])('refuses %j, which is not a network range', async (value) => {
    const o = await makeOracle()
    const reply = await submitAs(
      o,
      userCommandPrincipal(SELF_HOSTED_WORKSPACE_ID, ADMIN, 'admin'),
      { 'daemonLink.trustedNetworks': ['192.168.1.0/24', value] },
      `tn-bad-${value}`,
    )
    expect(reply.outcome === 'rejected' ? reply.refusal.kind : reply.outcome).toBe('invalid')
    expect(await trusted(o)).toEqual([])
  })
})
