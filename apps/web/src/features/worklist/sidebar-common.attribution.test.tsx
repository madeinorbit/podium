// @vitest-environment happy-dom
/**
 * SESSION ROWS RENDER THE ATTRIBUTION PAIR (POD-1526, closing POD-407 AC 6).
 *
 * `SessionMeta.createdBy` (POD-1516) is the server-stamped pair — ACTOR (who
 * acted) and ON-BEHALF-OF (for whom). This suite protects the two properties
 * that a naive implementation satisfies by accident:
 *
 *   1. THE PAIR DOES NOT COLLAPSE. A test that only asserts "the actor is on
 *      the row" passes against an implementation that renders one value twice,
 *      so the delegated case below asserts BOTH halves are present AND that
 *      they carry DIFFERENT ids in DIFFERENT slots. Collapsing the pair to a
 *      single value is exactly what turns `the delegated row` red.
 *   2. ABSENT RENDERS AS ABSENT. POD-1516 deliberately did not backfill: a row
 *      predating the columns has no pair, and substituting the owner would
 *      assert "a human did it" for precisely the agent-created rows the pair
 *      exists to distinguish. A row that always printed something would satisfy
 *      every positive assertion here while breaking the actual requirement.
 */
import {
  actorAgent,
  actorMachine,
  actorSystem,
  actorUser,
  asSessionId,
  type SessionMeta,
  type SessionMetaInput,
} from '@podium/model'
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

function sess(over: Partial<SessionMetaInput>): SessionMeta {
  return {
    sessionId: asSessionId('sess'),
    agentKind: 'claude-code',
    cwd: '/repo',
    title: 'POD-1526-A',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-08-03T10:00:00.000Z',
    lastActiveAt: '2026-08-03T10:01:00.000Z',
    origin: { kind: 'spawn' },
    readAt: null,
    unread: false,
    archived: false,
    busy: false,
    ...over,
  } as SessionMeta
}

const renderRow = (session: SessionMeta): void => {
  render(<PanelRow session={session} active={false} onSelect={vi.fn()} />)
}

describe('PanelRow renders the session attribution pair (POD-1526)', () => {
  it('the delegated row shows the acting agent AND the human it acted for, distinguishably', () => {
    renderRow(
      sess({
        createdBy: {
          actor: actorAgent('agent-7' as never),
          onBehalfOf: 'user:sole' as never,
        },
      }),
    )
    const actor = screen.getByTestId('attribution-actor')
    const onBehalfOf = screen.getByTestId('attribution-on-behalf-of')
    // BOTH halves, and they are not the same value rendered twice: an agent
    // acting for a person is representable only as both.
    expect(actor.textContent).toBe('agent-7')
    expect(onBehalfOf.textContent).toContain('user:sole')
    expect(onBehalfOf.textContent).not.toContain('agent-7')
    expect(actor).not.toBe(onBehalfOf)
  })

  it('a session with no recorded attribution renders NO pair', () => {
    // POD-1516 does not backfill. Absent means "no attribution was ever
    // recorded" — never "not evaluated", and never the current user.
    renderRow(sess({}))
    expect(screen.queryByTestId('attribution-pair')).toBeNull()
    expect(screen.queryByTestId('attribution-actor')).toBeNull()
    expect(screen.queryByTestId('attribution-on-behalf-of')).toBeNull()
  })

  it('a machine actor reads "no human" rather than borrowing a person', () => {
    renderRow(
      sess({
        createdBy: { actor: actorMachine('mach-1' as never), onBehalfOf: null },
      }),
    )
    expect(screen.getByTestId('attribution-actor').textContent).toBe('mach-1')
    expect(screen.getByTestId('attribution-on-behalf-of').textContent).toBe('no human')
  })

  it('a system job names the JOB and carries no human (ADR 9 D8 S5)', () => {
    renderRow(
      sess({ createdBy: { actor: actorSystem('boot-reconcile'), onBehalfOf: null } }),
    )
    expect(screen.getByTestId('attribution-actor').textContent).toBe('boot-reconcile')
    expect(screen.getByTestId('attribution-on-behalf-of').textContent).toBe('no human')
  })

  it('a person acting directly names the same human in both halves', () => {
    // The case that CANNOT prove the pair survives — kept because it is real,
    // and flagged so nobody mistakes it for the delegation assertion above.
    renderRow(
      sess({
        createdBy: { actor: actorUser('user:sole' as never), onBehalfOf: 'user:sole' as never },
      }),
    )
    expect(screen.getByTestId('attribution-actor').textContent).toBe('user:sole')
    expect(screen.getByTestId('attribution-on-behalf-of').textContent).toContain('user:sole')
  })
})
