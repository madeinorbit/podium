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

/**
 * The pair used to head the agent-activity panel, mid-document. POD-1163 moved
 * it to the rail's Origin block and put it into words — so these tests moved
 * with it, and gained the counterfactual that the WORDING introduces: a phrase
 * is only a translation while every part of it comes from a stamped field.
 */
describe('the Origin block says who made this, in words', () => {
  it('renders actor and on-behalf-of from the issue’s own createdBy', () => {
    show({ createdBy: { actor: { kind: 'agent', id: 'agent-3' }, onBehalfOf: 'bob' } })
    // Two mounts of the properties stack (aside + mobile disclosure), so both.
    const line = screen.getAllByTestId('about-created-by')[0]
    expect(line?.textContent).toBe('Agent agent-3, for bob')
  })

  it('collapses a person acting for themselves to one name', () => {
    // The single-user case, and the one the raw pair rendered worst:
    // `Published by user:sole · for user:sole` said one id twice.
    show({ createdBy: { actor: { kind: 'user', id: 'user:sole' }, onBehalfOf: 'user:sole' } })
    expect(screen.getAllByTestId('about-created-by')[0]?.textContent).toBe('sole')
  })

  it('keeps BOTH names when a person acted for someone else', () => {
    // The counterfactual for the collapse above: it must be a collapse of two
    // EQUAL halves, never a drop of the on-behalf-of half.
    show({ createdBy: { actor: { kind: 'user', id: 'user:alice' }, onBehalfOf: 'bob' } })
    expect(screen.getAllByTestId('about-created-by')[0]?.textContent).toBe('alice, for bob')
  })

  it('does not annotate a PERSON with "no human"', () => {
    // The overwhelmingly common shape on today's rows: a person acted and no
    // separate delegating human was recorded. "sole · no human" beside a
    // person's name says something false — ADR 9 D8 S5's phrase describes a
    // machine or a system job, not the human who is standing right there.
    show({ createdBy: { actor: { kind: 'user', id: 'user:sole' }, onBehalfOf: null } })
    expect(screen.getAllByTestId('about-created-by')[0]?.textContent).toBe('sole')
  })

  it('says "no human" — not the owner — for a machine actor', () => {
    // ADR 9 D8 S5: a machine acts for no person, and `onBehalfOf: null` says so
    // explicitly. Substituting the owner here would be the exact defect.
    show({
      owner: 'carol',
      createdBy: { actor: { kind: 'machine', id: 'm-1' }, onBehalfOf: null },
    })
    const line = screen.getAllByTestId('about-created-by')[0]
    expect(line?.textContent).toBe('Machine m-1 · no human')
    expect(line?.textContent).not.toContain('carol')
  })

  it('falls back to the coarse origin — naming NO id — when there is no pair', () => {
    // A row that predates per-write attribution still carries `origin`, which
    // genuinely says "a person" or "an agent" and claims nothing more. Printing
    // a name here would be the synthesis §3.1.3 A3 forbids.
    show({ origin: 'agent', owner: 'alice' })
    const line = screen.getAllByTestId('about-created-by')[0]
    expect(line?.textContent).toBe('An agent')
    expect(line?.textContent).not.toContain('alice')
  })

  it('renders no attribution pair anywhere in the document column', () => {
    // The panel no longer carries the pair — its old home is gone, not moved
    // twice. Without this, "it is in the rail now" is satisfiable by a page
    // that shows it in both places.
    show({ panel: { todos: [], artifacts: [], deferred: [] }, createdBy: undefined })
    expect(screen.queryByTestId('agent-activity-attribution')).toBeNull()
    expect(document.body.textContent).not.toContain('Published by')
  })
})

describe('owner and visibility are DISPLAYED, read-only', () => {
  it('shows both when the projection carries them, in plain words', () => {
    show({ owner: 'alice', visibility: 'personal' })
    // Two mounts of the properties stack (aside + mobile disclosure), so both.
    expect(screen.getAllByTestId('about-owner')[0]?.textContent).toContain('alice')
    // Translated, not echoed: `personal` is an ADR 9 D3 class name, not English.
    expect(screen.getAllByTestId('about-visibility')[0]?.textContent).toBe('Private to its owner')
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
