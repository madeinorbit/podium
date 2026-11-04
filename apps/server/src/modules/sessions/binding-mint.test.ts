import { asIssueId, asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { scopeWithin } from './binding-mint'

/** A delegation persisted with the old scope `all` (no longer minted, POD-6288)
 *  is its human's member rights: a child may narrow it to a task subtree or to
 *  that same human's own scopes, never to another person's. */
describe('scopeWithin under a legacy persisted `all` parent', () => {
  const alice = asUserId('alice')
  const bob = asUserId('bob')
  it('admits a subtree, none, and the parent human’s own scopes', () => {
    expect(scopeWithin({ kind: 'subtree', rootId: asIssueId('iss_1') }, { kind: 'all' }, alice)).toBe(true)
    expect(scopeWithin({ kind: 'none' }, { kind: 'all' }, alice)).toBe(true)
    expect(scopeWithin({ kind: 'owned', userId: alice }, { kind: 'all' }, alice)).toBe(true)
    expect(scopeWithin({ kind: 'self', userId: alice }, { kind: 'all' }, alice)).toBe(true)
  })
  it('refuses another person’s scope', () => {
    expect(scopeWithin({ kind: 'owned', userId: bob }, { kind: 'all' }, alice)).toBe(false)
    expect(scopeWithin({ kind: 'self', userId: bob }, { kind: 'all' }, alice)).toBe(false)
    expect(scopeWithin({ kind: 'owned', userId: bob }, { kind: 'all' }, null)).toBe(false)
  })
})
