import { describe, expect, it } from 'vitest'
import { asAgentIdentityId, asDelegationRef, asUserId } from '../planes/principal'
import {
  type DelegationLink,
  delegationWidens,
  isBroadDelegation,
  MAX_DELEGATION_DEPTH,
  resolveDelegationChain,
} from './delegation-chain'
import { fakeDelegations } from './test-support'

const link = (
  ref: string,
  over: Partial<Omit<DelegationLink, 'ref'>> = {},
): DelegationLink => ({
  ref: asDelegationRef(ref),
  agentIdentity: asAgentIdentityId(over.agentIdentity ?? `agent-${ref}`),
  scope: over.scope ?? { kind: 'spawned-for', issueId: 'iss-1' },
  delegatedBy: over.delegatedBy ?? null,
  rootUser: over.rootUser === undefined ? asUserId('usr-ada') : over.rootUser,
  revoked: over.revoked ?? false,
})

const resolve = (ref: string, links: readonly DelegationLink[], inactive: string[] = []) =>
  resolveDelegationChain(asDelegationRef(ref), fakeDelegations(links, inactive))

describe('delegation chain resolution', () => {
  it('resolves a single link to its human', () => {
    const result = resolve('a', [link('a')])
    expect(result.ok).toBe(true)
    expect(result.ok && result.onBehalfOf).toBe('usr-ada')
    expect(result.ok && result.leaf.agentIdentity).toBe('agent-a')
  })

  it('returns the chain root-first so a reader sees the human first', () => {
    const result = resolve('leaf', [
      link('root'),
      link('leaf', { delegatedBy: asDelegationRef('root'), rootUser: null }),
    ])
    expect(result.ok && result.chain.map((l) => String(l.ref))).toEqual(['root', 'leaf'])
  })

  it('refuses a chain with more than one human', () => {
    // A second human anywhere means revoking the parent would not stop the child.
    const result = resolve('leaf', [
      link('root'),
      link('leaf', { delegatedBy: asDelegationRef('root'), rootUser: asUserId('usr-bob') }),
    ])
    expect(result).toEqual({ ok: false, reason: 'multiple-humans' })
  })

  it('refuses a chain with no human at its root', () => {
    expect(resolve('a', [link('a', { rootUser: null })])).toEqual({
      ok: false,
      reason: 'no-human-at-root',
    })
  })

  it('collapses the chain when any link is revoked', () => {
    const result = resolve('leaf', [
      link('root', { revoked: true }),
      link('leaf', { delegatedBy: asDelegationRef('root'), rootUser: null }),
    ])
    expect(result).toEqual({ ok: false, reason: 'revoked-delegation' })
  })

  it('refuses when the root human is inactive — no reaper needed', () => {
    expect(resolve('a', [link('a')], ['usr-ada'])).toEqual({ ok: false, reason: 'user-inactive' })
  })

  it('refuses an unknown reference', () => {
    expect(resolve('missing', [link('a')])).toEqual({ ok: false, reason: 'unknown-delegation' })
  })

  it('refuses a cycle instead of hanging', () => {
    const result = resolve('a', [
      link('a', { delegatedBy: asDelegationRef('b'), rootUser: null }),
      link('b', { delegatedBy: asDelegationRef('a'), rootUser: null }),
    ])
    expect(result).toEqual({ ok: false, reason: 'cycle' })
  })

  it('bounds the depth', () => {
    const links = Array.from({ length: MAX_DELEGATION_DEPTH + 2 }, (_, i) =>
      link(`l${i}`, {
        delegatedBy: asDelegationRef(`l${i + 1}`),
        rootUser: null,
      }),
    )
    expect(resolve('l0', links)).toEqual({ ok: false, reason: 'chain-too-long' })
  })

  it('refuses a sub-agent that widens to the human ceiling', () => {
    const result = resolve('leaf', [
      link('root'),
      link('leaf', {
        delegatedBy: asDelegationRef('root'),
        rootUser: null,
        scope: { kind: 'everything-human-can-see', justification: 'superagent' },
      }),
    ])
    expect(result).toEqual({ ok: false, reason: 'widening-delegation' })
  })

  it("allows a superagent's sub-agents to stay at the ceiling", () => {
    const broad = { kind: 'everything-human-can-see', justification: 'superagent' } as const
    const result = resolve('leaf', [
      link('root', { scope: broad }),
      link('leaf', { delegatedBy: asDelegationRef('root'), rootUser: null, scope: broad }),
    ])
    expect(result.ok).toBe(true)
  })
})

describe('the broad-scope exception is expressed as an exception', () => {
  it('a task agent default is spawned-for, and it is not broad', () => {
    expect(isBroadDelegation({ kind: 'spawned-for', issueId: 'iss-1' })).toBe(false)
  })

  it('broad scope cannot be reached by omission — it needs a justification', () => {
    // There is no way to spell a broad scope without naming why it is broad;
    // `justification` is required by the type, and these are the only two values.
    const superagent = {
      kind: 'everything-human-can-see',
      justification: 'superagent',
    } as const
    const scheduled = {
      kind: 'everything-human-can-see',
      justification: 'scheduled-automation',
    } as const
    expect([superagent, scheduled].every(isBroadDelegation)).toBe(true)
  })

  it('widening is judged conservatively: an unbounded parent bounds nothing', () => {
    const parent = { kind: 'spawned-for', subtreeRootId: 'iss-1' } as const
    expect(delegationWidens(parent, { kind: 'spawned-for', subtreeRootId: 'iss-1' })).toBe(false)
    expect(delegationWidens(parent, { kind: 'spawned-for', subtreeRootId: 'iss-9' })).toBe(true)
    // A child that declares no subtree under a parent that does is not provably
    // narrower, so it counts as widening.
    expect(delegationWidens(parent, { kind: 'spawned-for' })).toBe(true)
  })
})
