/**
 * ATTRIBUTION, OWNERSHIP AND THE NEEDS-HUMAN ASKER, RENDERED THROUGH THE REAL
 * PAGE (POD-646).
 *
 * Rendered through `IssuePage` rather than by calling the components, for the
 * same reason `IssuePage.provenance.test.tsx` gives: a component that renders
 * the pair correctly tells you nothing about whether the page still MOUNTS it.
 *
 * The negatives carry as much weight as the positives here, because the rule
 * being protected is "READ the pair, never synthesise it" (§3.1.3 A3). A page
 * that always printed something would satisfy every positive assertion below
 * while breaking the actual requirement — so every case has its counterfactual:
 * a row with no pair renders NO pair, and a machine actor renders "no human"
 * rather than borrowing the owner.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssuePage } from './IssuePage'

vi.mock('@/app/store', () => {
  const state = () =>
    ({
      trpc: {
        settings: { get: { query: vi.fn(async () => ({})) } },
        issues: {
          events: { query: vi.fn(async () => []) },
          comments: { query: vi.fn(async () => []) },
          mail: { query: vi.fn(async () => []) },
          update: { mutate: vi.fn() },
          clearNeedsHuman: { mutate: vi.fn() },
        },
      },
      hub: { onIssues: () => () => {} },
      machines: [],
      sessions: [],
      issues: [],
      httpOrigin: 'http://localhost',
      openArtifact: vi.fn(),
      openFileInWorktree: vi.fn(),
      navigateToSession: vi.fn(),
    }) as never
  return {
    useStore: () => state(),
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(state()),
    useReplicaIssues: () => [],
  }
})

afterEach(cleanup)

const show = (over: Parameters<typeof makeIssue>[0]) => {
  const issue = makeIssue({ id: 'i-1', repoPath: '/r', ...over })
  render(<IssuePage issue={issue} orderedIds={[issue.id]} onBack={vi.fn()} onNavigate={vi.fn()} />)
}

describe('the needs-human banner asks for a PERSON', () => {
  it('renders the server-stamped actor and the human it acted for', () => {
    show({
      needsHuman: true,
      asked: {
        question: 'Ship it or hold?',
        at: 't',
        by: 's-1',
        attribution: { actor: { kind: 'agent', id: 'agent-7' }, onBehalfOf: 'alice' },
      },
    })
    expect(screen.getByText('Ship it or hold?')).toBeTruthy()
    expect(screen.getByTestId('attribution-actor').textContent).toBe('agent-7')
    expect(screen.getByTestId('attribution-on-behalf-of').textContent).toBe('for alice')
  })

  it('falls back to the legacy asking SESSION when there is no pair — one honest half', () => {
    show({ needsHuman: true, humanQuestion: 'Which way?', humanQuestionAskedBy: 's-42' })
    expect(screen.getByTestId('needs-human-asker-legacy').textContent).toContain('s-42')
    // And it does not invent the missing half.
    expect(screen.queryByTestId('attribution-on-behalf-of')).toBeNull()
  })

  it('renders no asker at all when the server sent none', () => {
    // The counterfactual: without this, "shows the asker" is satisfiable by a
    // component that always shows something.
    show({ needsHuman: true, humanQuestion: 'Anonymous question' })
    expect(screen.queryByTestId('needs-human-asker-legacy')).toBeNull()
    expect(screen.queryByTestId('attribution-pair')).toBeNull()
  })

  it('offers no way for the client to assert who is answering', () => {
    show({ needsHuman: true, humanQuestion: 'Q' })
    const banner = screen.getByTestId('needs-human')
    // One control: Resolve. No identity picker, no "answering as" field — the
    // authority stamps the answering principal from the transport.
    const controls = banner.querySelectorAll('button, input, select')
    expect(controls).toHaveLength(1)
    expect(controls[0]?.textContent).toBe('Resolve')
  })
})

describe('the agent-activity panel shows the pair', () => {
  it('renders actor and on-behalf-of from the issue’s own createdBy', () => {
    show({
      panel: { todos: [{ text: 'do it', done: false }], artifacts: [], deferred: [] },
      createdBy: { actor: { kind: 'agent', id: 'agent-3' }, onBehalfOf: 'bob' },
    })
    const line = screen.getByTestId('agent-activity-attribution')
    expect(line.textContent).toContain('agent-3')
    expect(line.textContent).toContain('for bob')
  })

  it('renders "no human" — not the owner — for a machine actor', () => {
    // ADR 9 D8 S5: a machine acts for no person, and `onBehalfOf: null` says so
    // explicitly. Substituting the owner here would be the exact defect.
    show({
      owner: 'carol',
      panel: { todos: [{ text: 'probe', done: true }], artifacts: [], deferred: [] },
      createdBy: { actor: { kind: 'machine', id: 'm-1' }, onBehalfOf: null },
    })
    expect(screen.getByTestId('attribution-on-behalf-of').textContent).toBe('no human')
    expect(screen.getByTestId('agent-activity-attribution').textContent).not.toContain('carol')
  })

  it('renders no attribution line when the projection carries no pair', () => {
    show({ panel: { todos: [{ text: 'do it', done: false }], artifacts: [], deferred: [] } })
    expect(screen.queryByTestId('agent-activity-attribution')).toBeNull()
  })
})

describe('owner and visibility are DISPLAYED, read-only', () => {
  it('shows both when the projection carries them', () => {
    show({ owner: 'alice', visibility: 'personal' })
    // Two mounts of the properties stack (aside + mobile disclosure), so both.
    expect(screen.getAllByTestId('about-owner')[0]?.textContent).toContain('alice')
    expect(screen.getAllByTestId('about-visibility')[0]?.textContent).toContain('personal')
  })

  it('offers NO sharing control — per-feature sharing UX is deferred', () => {
    show({ owner: 'alice', visibility: 'personal' })
    const about = screen.getAllByTestId('issue-about')[0]
    expect(about?.querySelectorAll('button, input, select, a')).toHaveLength(0)
    expect(document.body.textContent).not.toMatch(/share|grant access|invite/i)
  })

  it('shows neither row when the row does not carry them — no default is invented', () => {
    // Printing "private" over a row that never said so is a claim the server did
    // not make, and on a VISIBILITY field that is the worst place to guess.
    show({})
    expect(screen.queryByTestId('about-owner')).toBeNull()
    expect(screen.queryByTestId('about-visibility')).toBeNull()
  })
})
