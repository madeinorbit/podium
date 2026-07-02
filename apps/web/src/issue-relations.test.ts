import type { IssueWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { groupRelations } from './issue-relations'

/** Minimal IssueWire stub — groupRelations only reads `deps` and `dependents`. */
function issue(
  deps: { id: string; type: string }[],
  dependents: { id: string; type: string }[],
): IssueWire {
  return { deps, dependents } as unknown as IssueWire
}

describe('groupRelations', () => {
  it('returns [] when there are no relations', () => {
    expect(groupRelations(issue([], []))).toEqual([])
  })

  it('splits blocked-by (outgoing blocks) from blocks (incoming blocks)', () => {
    // Outgoing `blocks` dep → subject is BLOCKED BY a-1; incoming `blocks` dep →
    // subject BLOCKS b-2 (verified against computeBlocked in issues.ts).
    const result = groupRelations(
      issue([{ id: 'a-1', type: 'blocks' }], [{ id: 'b-2', type: 'blocks' }]),
    )
    expect(result).toEqual([
      { section: 'Blocked by', entries: [{ id: 'a-1', type: 'blocks', direction: 'dep' }] },
      { section: 'Blocks', entries: [{ id: 'b-2', type: 'blocks', direction: 'dependent' }] },
    ])
  })

  it('groups related from either direction and dedupes a symmetric edge', () => {
    const result = groupRelations(
      issue([{ id: 'r-1', type: 'related' }], [{ id: 'r-1', type: 'related' }]),
    )
    expect(result).toEqual([
      { section: 'Related', entries: [{ id: 'r-1', type: 'related', direction: 'dep' }] },
    ])
  })

  it('places discovered-from and misc types after the named sections', () => {
    const result = groupRelations(
      issue(
        [
          { id: 'd-1', type: 'discovered-from' },
          { id: 't-1', type: 'tracks' },
          { id: 'c-1', type: 'caused-by' },
        ],
        [{ id: 'blk', type: 'blocks' }],
      ),
    )
    expect(result.map((s) => s.section)).toEqual([
      'Blocks',
      'Discovered from',
      'Caused by',
      'Tracks',
    ])
  })

  it('excludes parent-child and supersedes (shown elsewhere in the sidebar)', () => {
    const result = groupRelations(
      issue(
        [
          { id: 'p-1', type: 'parent-child' },
          { id: 's-1', type: 'supersedes' },
        ],
        [{ id: 'p-2', type: 'parent-child' }],
      ),
    )
    expect(result).toEqual([])
  })
})
