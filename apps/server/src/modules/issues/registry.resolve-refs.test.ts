import { asIssueId, asUserId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { OPERATOR } from '../../test-support/capabilities'
import { IssueCommandCtx } from './command-ctx'
import { issueRegistry } from './registry'
import { IssueReportsModule } from './service/reads'

describe('batched chip identities', () => {
  it('deduplicates a bounded batch and hides unreadable identities from two principals', async () => {
    const alice = asUserId('alice'), bob = asUserId('bob')
    const ids = new Map([['POD-1', asIssueId('iss_alice')], ['POD-2', asIssueId('iss_bob')]])
    const resolveRefs = vi.fn(async (refs: string[]) => [...new Set(refs)].map(ref => ({ ref, id: ids.get(ref) ?? null })))
    const ownedTarget = vi.fn(async (id: string) => id === 'iss_alice' ? { id, owner: alice, grants: [] } : id === 'iss_bob' ? { id, owner: bob, grants: [] } : undefined)
    const deps = { issues: { reports: { resolveRefs, ownedTarget } } }
    const call = async (user: typeof alice) => {
      const ctx = new IssueCommandCtx(deps as never, { capability: OPERATOR, principal: { kind: 'user', user, capability: OPERATOR } }, 'resolveRefs')
      return await issueRegistry.defs.resolveRefs.handler(ctx, { refs: ['POD-1', 'POD-2', 'POD-404', 'POD-1'] })
    }
    expect(await call(alice)).toEqual([{ ref: 'POD-1', id: 'iss_alice' }, { ref: 'POD-2', id: null }, { ref: 'POD-404', id: null }])
    expect(await call(bob)).toEqual([{ ref: 'POD-1', id: null }, { ref: 'POD-2', id: 'iss_bob' }, { ref: 'POD-404', id: null }])
    expect(resolveRefs).toHaveBeenCalledTimes(2)
    expect(issueRegistry.defs.resolveRefs.input.safeParse({ refs: Array(201).fill('POD-1') }).success).toBe(false)
    expect(issueRegistry.defs.resolveRefs.input.safeParse({ refs: Array(200).fill('POD-1') }).success).toBe(true)
  })

  it('resolves 50 references with one issue-row pass', async () => {
    const rows = new Map(Array.from({ length: 1000 }, (_, i) => [`iss_${i}`, { id: asIssueId(`iss_${i}`), seq: i, repoId: 'repo-one' }]))
    const values = vi.spyOn(rows, 'values')
    const single = vi.fn(async (ref: string) => [...rows.values()].find(row => row.seq === Number(ref.split('-')[1]))?.id ?? null)
    const reports = new IssueReportsModule({ rows, resolveRef: single, deps: { store: { repos: {
      repoForPrefix: async () => ({ repoId: 'repo-one' }), issueRepoIdResolver: async () => () => 'repo-one',
    } } } } as never)
    const refs = Array.from({ length: 50 }, (_, i) => `POD-${i + 1}`)
    const result = await reports.resolveRefs(refs)
    expect(result).toEqual(refs.map((ref, i) => ({ ref, id: `iss_${i + 1}` })))
    expect(values).toHaveBeenCalledTimes(1)
    expect(single).not.toHaveBeenCalled()
  })
})
