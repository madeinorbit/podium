// @vitest-environment happy-dom
/** Agent roster band grammar (POD-170, POD-100 laws L2/L6): band shell,
 *  terracotta-glyphed roster rows, and carried-over row controls. */
import type { SessionMeta } from '@podium/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRosterBand, PanelRow } from './sidebar-common'

vi.mock('@/app/store', () => ({
  useStoreSelector: (select: (store: unknown) => unknown) =>
    select({ continueSession: vi.fn(), renameSession: vi.fn() }),
}))

vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(cleanup)

const session = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    sessionId: 's1',
    agentKind: 'claude-code',
    cwd: '/repo',
    title: 'Release driver',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-18T10:00:00.000Z',
    lastActiveAt: '2026-07-18T10:01:00.000Z',
    origin: { kind: 'spawn' },
    readAt: null,
    unread: false,
    archived: false,
    busy: false,
    agentState: {
      phase: 'working',
      since: '2026-07-18T10:01:00.000Z',
      nativeSubagentCount: 0,
    },
    ...over,
  }) as SessionMeta

describe('AgentRosterBand', () => {
  it('renders the mono machine-voice label with the agent count', () => {
    render(
      <AgentRosterBand label="Agents" count={2}>
        <div>rows</div>
      </AgentRosterBand>,
    )
    const band = screen.getByTestId('agent-roster-band')
    expect(band.textContent).toContain('Agents')
    expect(band.textContent).toContain('· 2')
  })

  it('makes the label a selectable surface when onLabelClick is given (L6 worktree band)', () => {
    const onClick = vi.fn()
    render(
      <AgentRosterBand label="podium · main" count={1} onLabelClick={onClick} testId="wt-band">
        <div />
      </AgentRosterBand>,
    )
    screen.getByRole('button', { name: /podium · main/ }).click()
    expect(onClick).toHaveBeenCalled()
  })
})

describe('PanelRow roster variant', () => {
  it('opens with the terracotta agent glyph and keeps the mono ref + coordinator badge', () => {
    render(
      <PanelRow
        session={session({ displayRef: 'POD-210-A' })}
        active={false}
        onSelect={vi.fn()}
        roster
        coordinator
      />,
    )
    expect(screen.getByText('✳')).toBeTruthy()
    expect(screen.getByTestId('session-issue-linkage').textContent).toBe('POD-210-A')
    expect(screen.getByTestId('coordinator-badge')).toBeTruthy()
  })

  it('keeps the Continue control on an errored roster row', () => {
    render(
      <PanelRow
        session={session({
          agentState: {
            phase: 'errored',
            since: '2026-07-18T10:01:00.000Z',
            nativeSubagentCount: 0,
            error: { class: 'crash', retryable: true },
          },
        } as Partial<SessionMeta>)}
        active={false}
        onSelect={vi.fn()}
        roster
      />,
    )
    expect(screen.getByTitle("Send 'continue' to the errored agent")).toBeTruthy()
  })
})
