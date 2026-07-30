import { describe, expect, it } from 'vitest'
import { asAgentIdentityId, asDelegationRef, asUserId, type Principal } from '../../planes/principal'
import { attributionOf } from '../../planes/principal'
import type { DelegationLink } from '../delegation-chain'
import {
  createRecordingMinter,
  fakeDelegations,
  helloFor,
  HOSTILE_CLAIMS,
  transportFacts,
} from '../test-support'
import { createAgentRelayStrategy } from './agent-relay-delegation'

interface LinkSpec {
  ref: string
  agentIdentity?: string
  scope?: DelegationLink['scope']
  delegatedBy?: string | null
  rootUser?: string | null
  revoked?: boolean
}

const link = (over: LinkSpec): DelegationLink => ({
  ref: asDelegationRef(over.ref),
  agentIdentity: asAgentIdentityId(over.agentIdentity ?? `agent-${over.ref}`),
  scope: over.scope ?? { kind: 'spawned-for', sessionId: 'sess-1', issueId: 'iss-1' },
  delegatedBy: over.delegatedBy === undefined ? null : over.delegatedBy === null ? null : asDelegationRef(over.delegatedBy),
  rootUser:
    over.rootUser === undefined
      ? asUserId('usr-ada')
      : over.rootUser === null
        ? null
        : asUserId(over.rootUser),
  revoked: over.revoked ?? false,
})

const root = link({ ref: 'del-root', agentIdentity: 'agent-worker' })

const strategyFor = (links: readonly DelegationLink[], inactive: readonly string[] = []) => {
  const mint = createRecordingMinter()
  return {
    mint,
    strategy: createAgentRelayStrategy({ delegations: fakeDelegations(links, inactive), mint }),
  }
}

const authenticate = (
  strategy: ReturnType<typeof createAgentRelayStrategy>,
  ref: string,
  claims: Record<string, string> = HOSTILE_CLAIMS,
) =>
  strategy.authenticate({
    credential: { kind: 'delegationRef', ref },
    hello: helloFor({ kind: 'delegationRef', ref }, { claims }),
    transport: transportFacts({ endpoint: '/daemon', connectionId: 'conn-relay' }),
  })

describe('agent relay strategy — delegated principal', () => {
  it('resolves (agentIdentity, onBehalfOf) from the delegation, not the payload', () => {
    const { strategy } = strategyFor([root])
    const outcome = authenticate(strategy, 'del-root')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.principal).toMatchObject({
      kind: 'agent',
      agentIdentity: 'agent-worker',
      onBehalfOf: 'usr-ada',
      delegation: 'del-root',
    })
    // The hello asserted a different agent AND a different human; neither took.
    expect(outcome.principal).not.toMatchObject({ agentIdentity: 'agent-attacker' })
    expect(outcome.principal).not.toMatchObject({ onBehalfOf: 'usr-victim' })
  })

  it('stamps BOTH halves of the attribution pair', () => {
    const { strategy } = strategyFor([root])
    const outcome = authenticate(strategy, 'del-root')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // ADR 3 Am.1 D17: actor = the agent, on-behalf-of = the human. Never collapsed.
    expect(attributionOf(outcome.principal)).toEqual({
      actor: 'agent-worker',
      onBehalfOf: 'usr-ada',
    })
  })

  it('carries a delegation REFERENCE; no scope is copied into the connection', () => {
    const { strategy, mint } = strategyFor([root])
    const outcome = authenticate(strategy, 'del-root')
    expect(outcome.ok).toBe(true)
    // The minter was handed the reference and nothing else — there is no
    // parameter through which a scope could have been frozen (ADR 3 Am.1 D16.1).
    expect(mint.minted).toEqual([{ kind: 'delegation', subject: 'del-root' }])
    // And the principal itself carries no scope to go stale.
    const principal = (outcome.ok ? outcome.principal : null) as Principal
    expect(Object.keys(principal).sort()).toEqual([
      'agentIdentity',
      'capability',
      'delegation',
      'device',
      'kind',
      'onBehalfOf',
    ])
  })

  it('resolves a sub-agent chain to the ONE human at its root', () => {
    const parent = link({ ref: 'del-parent', agentIdentity: 'agent-parent' })
    const child = link({
      ref: 'del-child',
      agentIdentity: 'agent-child',
      delegatedBy: 'del-parent',
      rootUser: null,
      scope: { kind: 'spawned-for', sessionId: 'sess-2', issueId: 'iss-1' },
    })
    const { strategy } = strategyFor([parent, child])
    const outcome = authenticate(strategy, 'del-child')
    expect(outcome.ok && outcome.principal).toMatchObject({
      agentIdentity: 'agent-child',
      onBehalfOf: 'usr-ada',
    })
  })

  it('fails closed on an unknown delegation reference', () => {
    const { strategy } = strategyFor([root])
    expect(authenticate(strategy, 'del-forged')).toMatchObject({
      ok: false,
      reason: 'auth-failed',
    })
  })

  it('fails closed when the delegation is revoked', () => {
    const { strategy } = strategyFor([link({ ref: 'del-root', revoked: true })])
    expect(authenticate(strategy, 'del-root')).toMatchObject({ ok: false, reason: 'auth-failed' })
  })

  it('fails closed when the ROOT HUMAN is disabled — revoking a person stops their agents', () => {
    const { strategy } = strategyFor([root], ['usr-ada'])
    expect(authenticate(strategy, 'del-root')).toMatchObject({ ok: false, reason: 'auth-failed' })
  })

  it('refuses identically whatever the failure was (no reason leaks to the peer)', () => {
    const unknown = strategyFor([root]).strategy
    const revoked = strategyFor([link({ ref: 'del-root', revoked: true })]).strategy
    const inactive = strategyFor([root], ['usr-ada']).strategy
    const replies = [
      authenticate(unknown, 'del-forged'),
      authenticate(revoked, 'del-root'),
      authenticate(inactive, 'del-root'),
    ].map((o) => (o.ok ? 'ok' : { reason: o.reason, peerMessage: o.peerMessage }))
    expect(replies).toEqual([
      { reason: 'auth-failed', peerMessage: undefined },
      { reason: 'auth-failed', peerMessage: undefined },
      { reason: 'auth-failed', peerMessage: undefined },
    ])
  })
})
