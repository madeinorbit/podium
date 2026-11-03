import { expect, it } from 'vitest'
import { issueRepoName } from './issues'

// POD-6246: every surface names an issue's repo by the server's `repo.name`;
// the checkout folder of `repoPath` stands in only when no name arrived.
it('names an issue by its repo, not by the checkout its path points at', () => {
  expect(issueRepoName({ repoName: 'podium', repoPath: '/Users/mw/Source/other/bak_podium' })).toBe(
    'podium',
  )
  expect(issueRepoName({ repoPath: '/Users/mw/Source/other/bak_podium' })).toBe('bak_podium')
  expect(issueRepoName({ repoName: '', repoPath: 'C:\\src\\app' })).toBe('app')
  expect(issueRepoName({ repoPath: '' })).toBe('')
})
