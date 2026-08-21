import { describe, expect, it } from 'vitest'
import { ReleaseProposal } from './release-proposal'

describe('ReleaseProposal', () => {
  it('parses the admin-attributed failed state shown by the proposal card', () => {
    expect(
      ReleaseProposal.parse({
        headSha: 'abcdef1',
        version: '0.1.2-dev.7+abcdef1',
        branch: 'feature/proposal',
        commits: [{ sha: 'abcdef1', summary: 'Add proposal approval' }],
        addedMigrations: ['20260821110000_release_proposals'],
        state: 'failed',
        approval: { approvedBy: 'user:sole', approvedAt: 1_777_000_000_000 },
        failure: { message: 'The release was not published.', logs: 'compile exited 1' },
      }),
    ).toMatchObject({ state: 'failed', approval: { approvedBy: 'user:sole' } })
  })

  it('refuses a proposal without an attributable version and commit', () => {
    expect(
      ReleaseProposal.safeParse({
        headSha: '',
        version: '',
        branch: 'main',
        commits: [],
        addedMigrations: [],
        state: 'pending',
      }).success,
    ).toBe(false)
  })
})
