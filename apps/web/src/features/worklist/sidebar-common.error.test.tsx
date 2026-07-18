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

describe('PanelRow error status', () => {
  it('shows a non-retryable provider error without a Continue action', () => {
    const session = {
      sessionId: 'grok-limit',
      agentKind: 'grok',
      cwd: '/repo',
      title: 'POD-966-A',
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
        phase: 'errored',
        since: '2026-07-18T10:01:00.000Z',
        nativeSubagentCount: 0,
        error: { class: 'usage_limit', retryable: false },
      },
    } satisfies SessionMeta

    render(
      <PanelRow
        session={session}
        pinned={false}
        active={false}
        onSelect={vi.fn()}
        onPinned={vi.fn()}
      />,
    )

    expect(screen.getByText('error: usage_limit')).toBeTruthy()
    expect(screen.queryByTitle("Send 'continue' to the errored agent")).toBeNull()
  })
})
