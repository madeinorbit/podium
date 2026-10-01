import { asIssueId, asUserId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { OPERATOR } from '../../test-support/capabilities'
import { IssueCommandCtx } from './command-ctx'
import { issueRegistry } from './registry'

describe('batched chip identities', () => {
  it('deduplicates a bounded batch and hides unreadable identities from two principals', async () => {
    const alice = asUserId('alice'), bob = asUserId('bob')
    const ids = new Map([['POD-1', asIssueId('iss_alice')], ['POD-2', asIssueId('iss_bob')]])
    const resolveRef = vi.fn(async (ref: string) => ids.get(ref) ?? asIssueId('iss_missing'))
    const ownedTarget = vi.fn(async (id: string) => id === 'iss_alice' ? { id, owner: alice, grants: [] } : id === 'iss_bob' ? { id, owner: bob, grants: [] } : undefined)
    const deps = { issues: { reports: { resolveRef, ownedTarget } } }
    const call = async (user: typeof alice) => {
      const ctx = new IssueCommandCtx(deps as never, { capability: OPERATOR, principal: { kind: 'user', user, capability: OPERATOR } }, 'resolveRefs')
      return await issueRegistry.defs.resolveRefs.handler(ctx, { refs: ['POD-1', 'POD-2', 'POD-404', 'POD-1'] })
    }
    expect(await call(alice)).toEqual([{ ref: 'POD-1', id: 'iss_alice' }, { ref: 'POD-2', id: null }, { ref: 'POD-404', id: null }])
    expect(await call(bob)).toEqual([{ ref: 'POD-1', id: null }, { ref: 'POD-2', id: 'iss_bob' }, { ref: 'POD-404', id: null }])
    expect(resolveRef).toHaveBeenCalledTimes(6)
    expect(issueRegistry.defs.resolveRefs.input.safeParse({ refs: Array(201).fill('POD-1') }).success).toBe(false)
    expect(issueRegistry.defs.resolveRefs.input.safeParse({ refs: Array(200).fill('POD-1') }).success).toBe(true)
  })
})
