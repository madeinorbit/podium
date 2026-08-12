/**
 * The fleet stack's grammar, tested once for both surfaces that draw it.
 *
 * The sidebar row and the board card each had their own copy (POD-744) and the
 * copies disagreed: one stacked harness kinds, the other one tile per session
 * with a `+N` chip. WHO is on the task is `deriveFleetPresence`'s rule and is
 * tested in `packages/client-core` (POD-756); what is pinned here is the part
 * that is this component's own — the tiles it draws from that answer. The
 * sidebar's rendering is covered end-to-end in `SidebarUnified.*`; these tests
 * exist so the board card cannot drift away from the row again.
 */
import type { AgentKind, SessionMeta, SessionStatus } from '@podium/model'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { IssueFleetSummary } from './IssueFleetSummary'

function sess(
  id: string,
  over: { agentKind?: AgentKind; status?: SessionStatus; archived?: boolean; native?: number } = {},
): SessionMeta {
  return {
    sessionId: id,
    agentKind: over.agentKind ?? 'claude-code',
    cwd: '/repo',
    title: id,
    status: over.status ?? 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-06T12:00:00.000Z',
    lastActiveAt: '2026-07-06T12:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: over.archived ?? false,
    issueId: 'i1',
    busy: false,
    readAt: null,
    unread: false,
    agentState: {
      phase: 'working',
      since: '2026-07-06T12:00:00.000Z',
      nativeSubagentCount: over.native ?? 0,
    },
  } as unknown as SessionMeta
}

function fleet(sessions: SessionMeta[], props: { unread?: boolean; size?: number } = {}) {
  const { container } = render(<IssueFleetSummary sessions={sessions} {...props} />)
  return container.querySelector('[data-testid="issue-fleet-summary"]')
}

const kindsOf = (stack: Element) =>
  [...stack.querySelectorAll('[data-agent-kind]')].map((t) => t.getAttribute('data-agent-kind'))

describe('IssueFleetSummary', () => {
  it('stacks harness KINDS, and lets the total carry the agent count', () => {
    const stack = fleet([
      sess('a'),
      sess('b'),
      sess('c', { agentKind: 'codex' }),
      sess('d', { agentKind: 'codex', native: 3 }),
      sess('e', { agentKind: 'cursor' }),
    ]) as HTMLElement
    // Five agents across three harnesses is THREE tiles and a `5` — never five
    // tiles, and never `2 +3`.
    expect(kindsOf(stack)).toEqual(['claude-code', 'codex', 'cursor'])
    expect(stack.querySelector('[data-testid="issue-fleet-total"]')?.textContent).toBe('5')
    expect(stack.querySelector('[data-testid="issue-fleet-subagent-count"]')?.textContent).toBe(
      '×3',
    )
    expect(stack.getAttribute('title')).toBe('5 agents · 3 native children')
  })

  it('says nothing about a lone agent beyond its mark', () => {
    const stack = fleet([sess('a')]) as HTMLElement
    expect(stack.querySelectorAll('[data-agent-kind]')).toHaveLength(1)
    // The number would only repeat the single tile.
    expect(stack.querySelector('[data-testid="issue-fleet-total"]')).toBeNull()
    expect(stack.getAttribute('aria-label')).toBe('1 agent')
  })

  it('keeps a parked agent on the stack, ghosted — and drops the retired ones', () => {
    // The bug POD-756 fixed, pinned on the shared component: hibernation is the
    // reaper's business, not the agent's. Every Codex agent in the fleet is
    // parked, and a board card that filtered them showed none of them.
    const stack = fleet([
      sess('awake'),
      sess('parked', { agentKind: 'codex', status: 'hibernated' }),
      sess('gone', { agentKind: 'cursor', status: 'exited' }),
      sess('filed', { agentKind: 'grok', archived: true }),
    ]) as HTMLElement
    expect(kindsOf(stack)).toEqual(['claude-code', 'codex'])
    const parked = stack.querySelector('[data-agent-kind="codex"]')
    expect(parked?.hasAttribute('data-parked')).toBe(true)
    expect(
      stack.querySelector('[data-agent-kind="claude-code"]')?.hasAttribute('data-parked'),
    ).toBe(false)
    expect(stack.getAttribute('aria-label')).toBe('2 agents · 1 parked')
  })

  it('draws nothing at all once every session is retired', () => {
    expect(fleet([sess('gone', { status: 'exited' })])).toBeNull()
    expect(fleet([sess('filed', { archived: true })])).toBeNull()
    expect(fleet([])).toBeNull()
  })

  it('rides the unopened-update dot on the last tile, and says so out loud', () => {
    const stack = fleet([sess('a'), sess('b', { agentKind: 'codex' })], { unread: true })
    const tiles = [...(stack?.querySelectorAll('[data-agent-kind]') ?? [])]
    expect(tiles[0]?.querySelector('[data-testid="row-unread-dot"]')).toBeNull()
    expect(tiles[1]?.querySelector('[data-testid="row-unread-dot"]')).toBeTruthy()
    // The dot itself is aria-hidden, so the label is the only unread signal a
    // screen reader gets.
    expect(stack?.getAttribute('aria-label')).toBe('2 agents · new update')
  })

  it('takes the board card down to its denser tile without changing the grammar', () => {
    const tile = fleet([sess('a')], { size: 16 })?.querySelector(
      '[data-agent-kind]',
    ) as HTMLElement | null
    expect(tile?.style.width).toBe('16px')
    expect(tile?.style.height).toBe('16px')
  })
})
