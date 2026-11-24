import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
        session={{
          agentKind: 'claude-code',
          observedMode: 'default',
          launchPosture: { requestedMode: 'auto', unmet: [] },
        }}
      />,
    )
    const chip = screen.getByTestId('session-mode')
    expect(chip.textContent).toBe('default')
    expect(chip.dataset.provenance).toBe('observed')
    expect(chip.getAttribute('aria-label')).toContain('Asks before file edits and commands')
  })

  it('shows the requested mode, marked as requested, until the agent reports one', () => {
    render(
      <SessionModeChip
        session={{ agentKind: 'claude-code', launchPosture: { requestedMode: 'auto', unmet: [] } }}
      />,
    )
    const chip = screen.getByTestId('session-mode')
    expect(chip.textContent).toBe('auto')
    expect(chip.dataset.provenance).toBe('requested')
    expect(chip.getAttribute('aria-label')).toContain('Requested, not yet confirmed')
  })

  it('gives keyboard users the same practical help as the tooltip', async () => {
    const user = userEvent.setup()
    render(<SessionModeChip session={{ agentKind: 'codex', observedMode: 'on-request' }} />)
    const chip = screen.getByTestId('session-mode')
    await user.tab()
    const tooltip = await screen.findByText(
      "Can edit within its allowed folders; asks you before running beyond its limits. Use /permissions in Codex's terminal to change permissions.",
    )
    expect(chip.getAttribute('aria-label')).toBe(`Permissions: on-request. ${tooltip.textContent}`)
    expect(tooltip.textContent).toContain('asks you before running beyond its limits')
  })

  it('draws nothing when no mode is known', () => {
    render(
      <SessionModeChip
        session={{ agentKind: 'claude-code', launchPosture: { requestedMode: null, unmet: [] } }}
      />,
    )
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
    const lines = screen.getAllByText(/without asking/)
    expect(lines.map((line) => line.textContent)).toEqual([
      'Pi edits files and runs commands without asking for approval. If you need approval prompts, choose another agent in the new-task box.',
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
