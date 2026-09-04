// @vitest-environment happy-dom
import { asSessionId } from '@podium/model'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./AgentPanel', () => ({
  AgentPanel: ({ sessionId, active }: { sessionId: string; active?: boolean }) => (
    <div data-testid="loaded-agent-panel" data-session={sessionId} data-active={String(active)} />
  ),
}))

import { AgentPanelBoundary } from './AgentPanelBoundary'

afterEach(cleanup)

describe('AgentPanelBoundary', () => {
  it('renders the deferred panel with its original props', async () => {
    render(<AgentPanelBoundary sessionId={asSessionId('session-1')} active={false} />)

    const panel = await screen.findByTestId('loaded-agent-panel')
    expect(panel.getAttribute('data-session')).toBe('session-1')
    expect(panel.getAttribute('data-active')).toBe('false')
  })
})
