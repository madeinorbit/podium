import type { ReleaseProposal } from '@podium/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReleaseProposalCard } from './ReleaseProposalCard'

const PROPOSAL: ReleaseProposal = {
  headSha: 'abcdef1',
  version: '0.1.2-dev.7+abcdef1',
  runningVersion: '0.1.1-edge.1',
  branch: 'feature/branch-release',
  commits: [{ sha: 'abcdef1', summary: 'Add approval flow' }],
  addedMigrations: ['20260821110000_release_proposals'],
  state: 'pending',
}

afterEach(cleanup)

describe('ReleaseProposalCard', () => {
  it('shows branch commits and the migration commitment before approval', () => {
    render(
      <ReleaseProposalCard
        proposal={PROPOSAL}
        pending={false}
        onApprove={vi.fn()}
        onHide={vi.fn()}
      />,
    )
    expect(screen.getByText(/feature\/branch-release/)).toBeTruthy()
    expect(screen.getByText(/Build dev\.7 \(abcdef1\) for the fleet/)).toBeTruthy()
    expect(screen.getByTestId('release-proposal-server-transition').textContent).toContain(
      '0.1.1-edge.1 → dev.7 (abcdef1)',
    )
    expect(screen.getByText(/Add approval flow/)).toBeTruthy()
    expect(screen.getByTestId('release-proposal-migration-warning').textContent).toMatch(
      /commits fleet databases to this branch until it merges/i,
    )
  })

  it('records the approver and explains a failed pre-release has nothing to roll back', () => {
    render(
      <ReleaseProposalCard
        proposal={{
          ...PROPOSAL,
          state: 'failed',
          approval: { approvedBy: 'user:admin', approvedAt: 1 },
          failure: {
            message:
              'Building and publishing this development release failed. Nothing was granted, so there is nothing to roll back.',
            logs: 'compile exited 1',
          },
        }}
        pending={false}
        onApprove={vi.fn()}
        onHide={vi.fn()}
      />,
    )
    expect(screen.getByText(/Approved by/).textContent).toContain('user:admin')
    expect(screen.getByText(/nothing to roll back/i)).toBeTruthy()
    fireEvent.click(screen.getByText('Build logs'))
    expect(screen.getByText('compile exited 1')).toBeTruthy()
  })

  it('dispatches build and publish as a separate consent', () => {
    const approve = vi.fn()
    render(
      <ReleaseProposalCard
        proposal={PROPOSAL}
        pending={false}
        onApprove={approve}
        onHide={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('approve-release-proposal'))
    expect(approve).toHaveBeenCalledOnce()
    expect(
      screen.getByText(/will not install until someone accepts that second prompt/i),
    ).toBeTruthy()
  })

  it('scrolls a long changelog without moving the proposal context or build action', () => {
    render(
      <ReleaseProposalCard
        proposal={{
          ...PROPOSAL,
          commits: Array.from({ length: 30 }, (_, index) => ({
            sha: 'abcdef' + index,
            summary: 'Release change ' + index,
          })),
        }}
        pending={false}
        onApprove={vi.fn()}
        onHide={vi.fn()}
      />,
    )

    const dialog = screen.getByTestId('release-proposal-card')
    const changelog = screen.getByTestId('release-proposal-commits')
    const buildAction = screen.getByTestId('approve-release-proposal')

    expect(dialog.className).toContain('overflow-hidden')
    expect(changelog.className).toContain('overflow-y-auto')
    expect(changelog.className).toContain('min-h-0')
    expect(changelog.className).toContain('flex-1')
    expect(changelog.contains(buildAction)).toBe(false)
  })

  it('states an empty server-to-build range instead of rendering a blank changelog', () => {
    render(
      <ReleaseProposalCard
        proposal={{ ...PROPOSAL, commits: [], addedMigrations: [] }}
        pending={false}
        onApprove={vi.fn()}
        onHide={vi.fn()}
      />,
    )

    expect(screen.getByText('No changes since what this server is running.')).toBeTruthy()
  })
})
