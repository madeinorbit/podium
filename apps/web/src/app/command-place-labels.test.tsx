import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MobxPool } from '@podium/client-graph/pool'
import { headerEntities } from '@podium/client-graph/header-entities'
import { launchRecords } from '@podium/client-graph/launch-records'
import { CommandPlaceTitle, CommandPlaceHint } from './command-place-labels'

afterEach(cleanup)
it('paints current branch and repository name on the retained launcher checkout without rebuilding its candidate', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const before = { kind: 'repository' as const, path: '/repo', branch: 'main', originUrl: 'https://example.test/original.git', worktrees: [] }
  try {
    headerEntities(pool).apply([{ kind: 'repository', id: 'scan', value: before }])
    const checkout = launchRecords(pool).at('/repo')!.worktrees[0]!
    render(<><CommandPlaceTitle worktree={checkout} /><CommandPlaceHint worktree={checkout} /></>)
    expect(screen.getByText('mainoriginal')).toBeTruthy()
    act(() => headerEntities(pool).apply([{ kind: 'repository', id: 'scan', value: { ...before, branch: 'elsewhere', originUrl: 'https://example.test/renamed.git' } }]))
    expect(screen.getByText('elsewhererenamed')).toBeTruthy()
  } finally { cleanup(); pool.dispose() }
})
