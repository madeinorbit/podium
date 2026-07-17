import type { GitRepositoryWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { type MachineScanRepo, rankMachineScanRepos, rankRepoCandidates } from './ranking'

function wire(over: Partial<GitRepositoryWire> & { path: string }): GitRepositoryWire {
  return { kind: 'repository', worktrees: [], ...over }
}

describe('candidate display names', () => {
  it('names a repo by its ORIGIN, not the folder it sits in', () => {
    // The case this exists for: a backup clone of podium living at ~/bak_podium.
    const [row] = rankRepoCandidates([
      wire({ path: '/home/u/bak_podium', originUrl: 'https://github.com/lumenfall/podium.git' }),
    ])
    expect(row?.name).toBe('podium')
    // The folder is still visible — the row renders `path` beside the name.
    expect(row?.path).toBe('/home/u/bak_podium')
  })

  it('falls back to the folder name when there is no origin', () => {
    const [row] = rankRepoCandidates([wire({ path: '/home/u/scratch-thing' })])
    expect(row?.name).toBe('scratch-thing')
  })

  it('applies to machine-scan rows too', () => {
    const repos: MachineScanRepo[] = [
      {
        path: '/home/vmi34/bak_podium',
        originUrl: 'git@github.com:lumenfall/podium.git',
        status: 'candidate',
        alsoOn: [],
      },
      { path: '/home/vmi34/notes', status: 'candidate', alsoOn: [] },
    ]
    const names = rankMachineScanRepos(repos).map((r) => r.name)
    expect(names).toContain('podium')
    expect(names).toContain('notes')
  })

  it('does not let an unparseable origin swallow the folder name', () => {
    const [row] = rankRepoCandidates([wire({ path: '/home/u/thing', originUrl: 'nonsense' })])
    expect(row?.name).toBe('thing')
  })
})
