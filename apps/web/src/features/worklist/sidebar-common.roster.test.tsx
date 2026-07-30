// @vitest-environment happy-dom
/** Agent roster band grammar (POD-170, POD-100 laws L2/L6): band shell,
 *  terracotta-glyphed roster rows, and carried-over row controls. */
import {
  type SessionMetaInput,
  type SessionMeta,
} from '@podium/model'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRosterBand, GroupedSessionRows, PanelRow } from './sidebar-common'

vi.mock('@/app/store', () => ({
  useStoreSelector: (select: (store: unknown) => unknown) =>
    select({ continueSession: vi.fn(), renameSession: vi.fn() }),
}))

vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(cleanup)

const session = (over: Partial<SessionMetaInput> = {}): SessionMeta =>
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
  it('drops the redundant terracotta glyph and keeps the mono ref + coordinator badge', () => {
    render(
      <PanelRow
        session={session({ displayRef: 'POD-210-A' })}
        active={false}
        onSelect={vi.fn()}
        roster
        coordinator
      />,
    )
    // The kind chip already marks the agent, so the extra ✳ was the same fact
    // twice in one row (POD-293 / POD-281): removed.
    expect(screen.queryByText('✳')).toBeNull()
    expect(screen.getByTestId('session-issue-linkage').textContent).toBe('POD-210-A')
    expect(screen.getByTestId('coordinator-badge')).toBeTruthy()
  })

  it('uses the issue display ref for a legacy session and never renders its internal ID', () => {
    render(
      <PanelRow
        session={session({ issueId: 'iss_internal-uuid' })}
        active={false}
        onSelect={vi.fn()}
        roster
        issueDisplayRef="POD-100"
      />,
    )
    const linkage = screen.getByTestId('session-issue-linkage')
    expect(linkage.textContent).toBe('POD-100')
    expect(linkage.title).toBe('Attached to issue POD-100')
    expect(document.body.textContent).not.toContain('iss_internal-uuid')
  })

  it('renders no ref when a legacy session has no human-facing issue ref', () => {
    render(
      <PanelRow
        session={session({ issueId: 'iss_internal-uuid' })}
        active={false}
        onSelect={vi.fn()}
        roster
      />,
    )
    expect(screen.queryByTestId('session-issue-linkage')).toBeNull()
    expect(document.body.textContent).not.toContain('iss_internal-uuid')
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
        } as Partial<SessionMetaInput>)}
        active={false}
        onSelect={vi.fn()}
        roster
      />,
    )
    expect(screen.getByTitle("Send 'continue' to the errored agent")).toBeTruthy()
  })
})

describe('native subagent indicator', () => {
  it('renders a monotype "with N subagents" line with no fold chevron', () => {
    render(
      <GroupedSessionRows
        sessions={[
          session({
            agentState: {
              phase: 'working',
              since: '2026-07-18T10:01:00.000Z',
              nativeSubagentCount: 4,
            },
          }),
        ]}
        render={(s) => <div key={s.sessionId}>{s.title}</div>}
        dense
      />,
    )
    const indicator = screen.getByTestId('native-subagent-indicator')
    expect(indicator.textContent).toBe('with 4 subagents')
    expect(indicator.className).toContain('font-mono')
    // Not a disclosure — no chevron affordance that looks expandable.
    expect(indicator.querySelector('svg')).toBeNull()
  })
})
