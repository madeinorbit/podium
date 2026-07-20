// @vitest-environment happy-dom
import type { SessionMeta } from '@podium/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanelRow } from './sidebar-common'

vi.mock('@/app/store', () => ({
  useStoreSelector: (select: (store: unknown) => unknown) =>
    select({ continueSession: vi.fn(), renameSession: vi.fn() }),
}))

vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

afterEach(cleanup)

function sess(over: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: 'sess',
    agentKind: 'claude-code',
    cwd: '/repo',
    title: 'POD-81-A',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-20T10:00:00.000Z',
    lastActiveAt: '2026-07-20T10:01:00.000Z',
    origin: { kind: 'spawn' },
    readAt: null,
    unread: false,
    archived: false,
    busy: false,
    ...over,
  } as SessionMeta
}

function renderRow(session: SessionMeta): void {
  render(
    <PanelRow
      session={session}
      pinned={false}
      active={false}
      onSelect={vi.fn()}
      onPinned={vi.fn()}
    />,
  )
}

describe('PanelRow unread news chip (POD-81)', () => {
  it('an unread finished turn shows the DONE chip', () => {
    renderRow(
      sess({
        unread: true,
        agentState: {
          phase: 'idle',
          since: '2026-07-20T10:01:00.000Z',
          nativeSubagentCount: 0,
          idle: { kind: 'done' },
        },
      }),
    )
    const chip = screen.getByTestId('session-unread-chip')
    expect(chip.textContent).toBe('done')
  })

  it('a read finished turn shows no chip', () => {
    renderRow(
      sess({
        unread: false,
        agentState: {
          phase: 'idle',
          since: '2026-07-20T10:01:00.000Z',
          nativeSubagentCount: 0,
          idle: { kind: 'done' },
        },
      }),
    )
    expect(screen.queryByTestId('session-unread-chip')).toBeNull()
  })

  it('an unread working session stays chipless (not news yet)', () => {
    renderRow(
      sess({
        unread: true,
        agentState: { phase: 'working', since: '2026-07-20T10:01:00.000Z', nativeSubagentCount: 0 },
      }),
    )
    expect(screen.queryByTestId('session-unread-chip')).toBeNull()
  })

  it('attention rows keep their meta label and gain no duplicate chip', () => {
    renderRow(
      sess({
        unread: true,
        agentState: {
          phase: 'needs_user',
          since: '2026-07-20T10:01:00.000Z',
          nativeSubagentCount: 0,
          need: { kind: 'question', summary: 'Pick one' },
        },
      }),
    )
    expect(screen.queryByTestId('session-unread-chip')).toBeNull()
  })
})
