// @vitest-environment happy-dom
/**
 * POD-415 — the row's side of the open-todos verdict.
 *
 * The label is gated on the badge TONE ('attention' or 'error'), and the whole
 * point of this verdict is that it is neither: demoting it to tone 'idle' would
 * have deleted "todos open" from the sidebar rather than quietening it. So the
 * two halves are asserted together — the words are there, the amber is not.
 */
import type { SessionMeta } from '@podium/model'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanelRow } from './sidebar-common'

vi.mock('@/app/store', () => ({
  useStoreSelector: (sel: (s: unknown) => unknown) =>
    sel({
      continueSession: vi.fn(),
      renameSession: vi.fn(),
      coarseNow: Date.parse('2026-08-06T12:00:00.000Z'),
    } as never),
}))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedKill: vi.fn(), guardedArchive: vi.fn() }),
}))

function session(idle: { kind: string; summary?: string }): SessionMeta {
  return {
    sessionId: 's1',
    agentKind: 'claude-code',
    cwd: '/repo',
    title: 'agent',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-08-06T11:00:00.000Z',
    lastActiveAt: '2026-08-06T11:59:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    busy: false,
    agentState: {
      phase: 'idle',
      since: '2026-08-06T11:59:00.000Z',
      nativeSubagentCount: 0,
      idle,
    },
  } as unknown as SessionMeta
}

const row = (idle: { kind: string; summary?: string }) => (
  <PanelRow session={session(idle)} active={false} onSelect={() => {}} />
)

afterEach(cleanup)

describe('PanelRow — a turn that ended with open todos', () => {
  it('says "todos open" on the row, dim rather than amber', () => {
    render(row({ kind: 'open_todos', summary: 'open todo list' }))
    const meta = screen.getByText('todos open')
    expect(meta.className).toContain('text-text-dim')
    expect(meta.className).not.toContain('text-attention')
  })

  it('a plain finished turn still says nothing at all', () => {
    render(row({ kind: 'done' }))
    expect(screen.queryByText('todos open')).toBeNull()
    expect(screen.queryByText('idle')).toBeNull()
  })

  it('a question keeps its amber label', () => {
    render(row({ kind: 'question', summary: 'A or B?' }))
    expect(screen.getByText('needs answer').className).toContain('text-attention')
  })
})
