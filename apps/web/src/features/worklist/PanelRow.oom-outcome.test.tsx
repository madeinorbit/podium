// @vitest-environment happy-dom
/**
 * POD-2413 — a session the kernel killed does not wear the FINISHED colour.
 *
 * The outcome chip had one hardcoded emerald for every terminal outcome, so
 * "out of memory" rendered identically to "finished": at a glance — which is
 * the only way this chip is ever read — a death looked like a clean ending.
 *
 * Both halves are asserted together, because either alone passes against the
 * wrong implementation: a chip that is always destructive would satisfy the OOM
 * case, and a chip that is always emerald would satisfy the finished one.
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
      coarseNow: Date.parse('2026-08-20T12:00:00.000Z'),
    } as never),
}))
vi.mock('@/lib/hooks/use-session-guard', () => ({
  useSessionGuard: () => ({ guardedDelete: vi.fn(), guardedEnd: vi.fn(), guardedArchive: vi.fn() }),
}))

function session(stopReason: 'oom' | 'exited'): SessionMeta {
  return {
    sessionId: 's1',
    agentKind: 'claude-code',
    cwd: '/repo',
    title: 'agent',
    status: 'exited',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-08-20T11:00:00.000Z',
    lastActiveAt: '2026-08-20T11:59:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    busy: false,
    stoppedAt: '2026-08-20T11:59:00.000Z',
    stopReason,
  } as unknown as SessionMeta
}

const row = (stopReason: 'oom' | 'exited') => (
  <PanelRow session={session(stopReason)} active={false} onSelect={() => {}} />
)

afterEach(cleanup)

describe('PanelRow — the terminal-outcome chip', () => {
  it('renders an OOM death in the failure family, never the finished emerald', () => {
    render(row('oom'))
    const chip = screen.getByTestId('session-outcome-chip')
    expect(chip.textContent).toBe('out of memory')
    expect(chip.className).toContain('text-destructive')
    expect(chip.className).not.toContain('emerald')
  })

  it('still renders an ordinary exit in emerald', () => {
    render(row('exited'))
    const chip = screen.getByTestId('session-outcome-chip')
    expect(chip.textContent).toBe('finished')
    expect(chip.className).toContain('emerald')
    expect(chip.className).not.toContain('text-destructive')
  })
})
