/**
 * TRANSIENT STATE DOES NOT SURVIVE AN ISSUE SWITCH (POD-646).
 *
 * The issue page holds three separate "reset on issue switch" effects, each with
 * an intentionally partial dependency list and a `biome-ignore` saying so:
 *
 *   IssuePage.tsx          comment draft, title/description editors, add-sub-task
 *   issue-page/IssueBody   which long-form field is being edited
 *   issue-page/IssueProperties  the defer date and the pending relation type
 *
 * WHY THIS FILE EXISTS, and it is a correction rather than an addition. POD-331's
 * review asked whether the mutation pass had covered these three the way it
 * covered the eviction guard. It had not — I ran six mutants and none of them
 * were here. Running them afterwards found all three SILENT, and the three-way
 * naming resolves the same way for each:
 *
 *   - NOT "never entered": a `throw` on any of the three lines reddens 23 named
 *     tests across 6 files, so they run constantly.
 *   - NOT "genuinely equivalent": emptying the dep list means the effect fires
 *     once at mount and never again, so navigating from one issue to another
 *     carries the previous issue's half-typed comment, open editor and defer
 *     date onto the next one. That is a user-visible defect, and the comment
 *     draft case is the one that loses someone's writing.
 *   - Therefore ASSERTION GAP, which is precisely the failure POD-330 handed to
 *     this issue family: replacing a mechanism does not inherit its coverage,
 *     and these effects moved across the split with none to inherit.
 *
 * So every test below is written to redden when `[issue.id]` becomes `[]` in the
 * file it names. That is the whole design; they are not general "the page
 * renders" tests.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
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
          create: { mutate: vi.fn() },
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

const FIRST = makeIssue({ id: 'i-first', seq: 1, repoPath: '/r', title: 'First issue' })
const SECOND = makeIssue({ id: 'i-second', seq: 2, repoPath: '/r', title: 'Second issue' })

/** Mount on FIRST, hand back a switch-to-SECOND that re-renders the same tree —
 *  the navigation the three effects key on. */
function open() {
  const view = render(
    <IssuePage issue={FIRST} orderedIds={[FIRST.id]} onBack={vi.fn()} onNavigate={vi.fn()} />,
  )
  return {
    switchIssue: () =>
      view.rerender(
        <IssuePage issue={SECOND} orderedIds={[SECOND.id]} onBack={vi.fn()} onNavigate={vi.fn()} />,
      ),
  }
}

describe('IssuePage.tsx — the compose/edit reset', () => {
  it('drops a half-typed comment rather than carrying it to the next issue', async () => {
    // The costly one: without the reset, the draft you were writing about issue
    // A silently becomes a draft about issue B, and posting it files it there.
    const { switchIssue } = open()
    const composer = screen.getByLabelText('Add a comment')
    // fireEvent.change rather than userEvent.type: typing is per-character and
    // measured within a few hundred ms of the 5s budget, which made this test
    // flake under a full-directory run. The state under test is the VALUE, not
    // the keystrokes.
    fireEvent.change(composer, { target: { value: 'draft-A' } })
    expect((composer as HTMLTextAreaElement).value).toBe('draft-A')

    switchIssue()

    expect((screen.getByLabelText('Add a comment') as HTMLTextAreaElement).value).toBe('')
  })

  it('closes an open title editor', async () => {
    const { switchIssue } = open()
    await userEvent.click(screen.getByTitle('Click to edit title'))
    expect(screen.getByLabelText('Task title')).toBeTruthy()

    switchIssue()

    // Back to the read view — and showing the NEW issue, not an editor still
    // holding the old one's text.
    expect(screen.queryByLabelText('Task title')).toBeNull()
    expect(screen.getByText('Second issue')).toBeTruthy()
  })

  it('closes an open description editor', async () => {
    const { switchIssue } = open()
    await userEvent.click(screen.getByTitle('Click to edit description'))
    expect(screen.getByLabelText('Task description')).toBeTruthy()

    switchIssue()

    expect(screen.queryByLabelText('Task description')).toBeNull()
  })

  it('closes the inline add-sub-task row and clears its text', async () => {
    const { switchIssue } = open()
    await userEvent.click(screen.getByRole('button', { name: /add sub-task/i }))
    const input = screen.getByLabelText('Sub-task title')
    fireEvent.change(input, { target: { value: 'child-A' } })

    switchIssue()

    expect(screen.queryByLabelText('Sub-task title')).toBeNull()
    expect(screen.getByRole('button', { name: /add sub-task/i })).toBeTruthy()
  })
})

describe('issue-page/IssueBody.tsx — the long-form editor reset', () => {
  it('closes an open long-form editor on switch', async () => {
    const { switchIssue } = open()
    // Every long-form field is empty on the fixture, so they render as add-rows.
    await userEvent.click(screen.getByRole('button', { name: /design/i }))
    expect(screen.getByLabelText('Task design')).toBeTruthy()

    switchIssue()

    expect(screen.queryByLabelText('Task design')).toBeNull()
  })
})

describe('issue-page/IssueProperties.tsx — the properties reset', () => {
  it('clears a typed defer date on switch', async () => {
    const { switchIssue } = open()
    // The aside and the mobile disclosure both mount the properties stack, so
    // the control is addressed positionally rather than by a unique query.
    const defer = screen.getAllByLabelText('Defer until')[0] as HTMLInputElement
    fireEvent.change(defer, { target: { value: '2026-09-01' } })
    expect(defer.value).toBe('2026-09-01')

    switchIssue()

    expect((screen.getAllByLabelText('Defer until')[0] as HTMLInputElement).value).toBe('')
  })
})
