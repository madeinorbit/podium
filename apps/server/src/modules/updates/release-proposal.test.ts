import { describe, expect, it } from 'vitest'
import { releaseProposalFacts } from './release-proposal'

describe('releaseProposalFacts', () => {
  it('uses the published-to-HEAD range and flags only added migration definitions', async () => {
    const calls: string[][] = []
    const facts = await releaseProposalFacts({
      root: '/repo',
      headSha: 'bbbbbbb',
      sinceSha: 'aaaaaaa',
      git: async (args) => {
        calls.push([...args])
        if (args[0] === 'rev-parse') return 'feature/branch-release\n'
        if (args[0] === 'log') return 'bbbbbbbbbbbb\0Add branch release\0'
        return (
          'apps/server/src/migrations/drizzle/20260821110000_branch_release/migration.sql\0' +
          'apps/server/src/migrations/drizzle/20260821110000_branch_release/meta.json\0'
        )
      },
    })

    expect(facts).toEqual({
      branch: 'feature/branch-release',
      commits: [{ sha: 'bbbbbbb', summary: 'Add branch release' }],
      addedMigrations: ['20260821110000_branch_release'],
    })
    expect(calls).toContainEqual([
      'diff',
      '--diff-filter=A',
      '--name-only',
      '-z',
      'aaaaaaa',
      'bbbbbbb',
      '--',
      'apps/server/src/migrations/drizzle',
    ])
  })

  it('names detached HEAD and leaves a migration-free branch unflagged', async () => {
    const facts = await releaseProposalFacts({
      root: '/repo',
      headSha: 'ccccccc',
      sinceSha: 'aaaaaaa',
      git: async (args) => {
        if (args[0] === 'rev-parse') return 'HEAD\n'
        if (args[0] === 'log') return 'cccccccccccc\0Try old branch\0'
        return ''
      },
    })
    expect(facts.branch).toBe('detached@ccccccc')
    expect(facts.addedMigrations).toEqual([])
  })
})
