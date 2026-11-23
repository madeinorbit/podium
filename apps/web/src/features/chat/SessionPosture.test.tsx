import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PostureNotices, SessionModeChip } from './SessionPosture'

/**
 * WHAT A SESSION SHOWS OF ITS LAUNCH TERMS (POD-6858 Task 11): the mode the
 * agent reports over the one Podium asked for, and one notice per requirement
 * the launch cannot meet.
 */
afterEach(cleanup)

describe('SessionModeChip', () => {
  it('shows the mode the agent reports, not the one Podium asked for', () => {
    render(
      <SessionModeChip
        session={{ observedMode: 'default', launchPosture: { requestedMode: 'auto', unmet: [] } }}
      />,
    )
    const chip = screen.getByTestId('session-mode')
    expect(chip.textContent).toBe('default')
    expect(chip.dataset.provenance).toBe('observed')
  })

  it('shows the requested mode, marked as requested, until the agent reports one', () => {
    render(<SessionModeChip session={{ launchPosture: { requestedMode: 'auto', unmet: [] } }} />)
    const chip = screen.getByTestId('session-mode')
    expect(chip.textContent).toBe('auto')
    expect(chip.dataset.provenance).toBe('requested')
  })

  it('draws nothing when no mode is known', () => {
    render(<SessionModeChip session={{ launchPosture: { requestedMode: null, unmet: [] } }} />)
    expect(screen.queryByTestId('session-mode')).toBeNull()
  })
})

describe('PostureNotices', () => {
  it('draws one notice per unmet requirement, in the exact words', () => {
    render(
      <PostureNotices
        session={{
          agentKind: 'pi',
          launchPosture: {
            requestedMode: null,
            unmet: [
              {
                requirement: 'autonomy',
                reason: 'Pi has no approval gate, so it cannot ask first',
              },
            ],
          },
        }}
      />,
    )
    const lines = screen.getAllByText(/cannot/)
    expect(lines.map((line) => line.textContent)).toEqual([
      'Pi cannot run in the chosen mode here: Pi has no approval gate, so it cannot ask first',
    ])
  })

  it('draws nothing when the launch met every requirement', () => {
    render(
      <PostureNotices
        session={{ agentKind: 'pi', launchPosture: { requestedMode: null, unmet: [] } }}
      />,
    )
    expect(screen.queryByTestId('posture-notices')).toBeNull()
  })
})
