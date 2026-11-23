import '@/test-support/mock-core-store-handle'
import '@/test-support/mock-pool-fixture'

/**
 * BOB OPENS ALICE'S TASK (POD-6295; design §2.2, §2.3, D13).
 *
 * Rendered through the real `IssuePage` on a three-member instance where the
 * reader is Bob. The server's answers are stubbed at the tRPC edge: `issues.get`
 * says what Bob may do and summarises the task's sessions, `issues.collaborators`
 * names who started or joined it, `issues.comments` marks Bob's own comment
 * `mayEdit`. Each acceptance item of the issue is one `it` below.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { poolFixtureStore } from '@/test-support/pool-issue-fixture'
import { allIssueViewModels } from '../../../../../tests/worklist/diagnostics/reference/issue-view-models'
import '@/test-support/model-catalog-mock'
import { IssuePage } from './IssuePage'

const MEMBERS = vi.hoisted(() => [
  { id: 'mem_alice', displayName: 'Alice Martin' },
  { id: 'mem_bob', displayName: 'Bob Keller' },
  { id: 'mem_carol', displayName: 'Carol Diaz' },
])

const world = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
  api: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/member-roster', async () => {
  const actual = await vi.importActual<typeof import('@/lib/member-roster')>('@/lib/member-roster')
  const roster = {
    shared: true,
    currentMemberId: 'mem_bob',
    members: MEMBERS,
    nameOf: (id: string | null | undefined) => MEMBERS.find((m) => m.id === id)?.displayName,
  }
  return { ...actual, useMemberRoster: () => roster }
})

vi.mock('@/app/store', () => {
  const state = () =>
    ({
      trpc: world.api,
      hub: { onIssues: () => () => {} },
      repos: [],
      machines: [],
      sessions: [],
      issues: [],
      ...world.current,
      httpOrigin: 'http://localhost',
      openArtifact: vi.fn(),
      openFileInWorktree: vi.fn(),
      navigateToSession: vi.fn(),
    }) as never
  return {
    useStore: () => state(),
    readFixture: (sel: (s: unknown) => unknown) => sel(state()),
  }
})

afterEach(cleanup)

const ALL_ALLOWED = { reassign: true, edit: true, restore: true, comment: true }

interface Setup {
  allowed?: typeof ALL_ALLOWED
  issue?: Parameters<typeof makeIssue>[0]
  update?: (input: unknown) => Promise<unknown>
  current?: Record<string, unknown>
}

function show(setup: Setup = {}) {
  const updateIssue = vi.fn(async () => undefined)
  const api = {
    settings: { get: { query: vi.fn(async () => ({})) } },
    issues: {
      events: { query: vi.fn(async () => []) },
      mail: { query: vi.fn(async () => []) },
      mailInbox: { mutate: vi.fn(async () => []) },
      comments: {
        query: vi.fn(async () => [
          {
            id: 'c-alice',
            author: 'Alice Martin',
            authorId: 'mem_alice',
            body: 'I started on the copy.',
            createdAt: '2026-11-04T09:00:00.000Z',
            mayEdit: false,
          },
          {
            id: 'c-bob',
            author: 'Bob Keller',
            authorId: 'mem_bob',
            body: 'I will review it.',
            createdAt: '2026-11-04T09:05:00.000Z',
            mayEdit: true,
          },
        ]),
      },
      get: {
        query: vi.fn(async () => ({
          allowed: setup.allowed ?? ALL_ALLOWED,
          sessionSummaries: [
            { owner: 'mem_alice', title: 'Invite flow copy', state: 'live' },
            { owner: 'mem_alice', title: 'Copy review notes', state: 'idle' },
            { owner: 'mem_bob', title: 'My own session', state: 'idle' },
          ],
          ...setup.current,
        })),
      },
      collaborators: {
        query: vi.fn(async () => [
          { userId: 'mem_alice', joinedAt: '2026-11-03T10:00:00.000Z', via: 'start' },
          { userId: 'mem_carol', joinedAt: '2026-11-03T11:00:00.000Z', via: 'join' },
        ]),
      },
      textRevisions: {
        query: vi.fn(async () => [
          {
            id: 11,
            field: 'description',
            body: 'First draft of the invite copy.',
            source: 'create',
            restoredFrom: null,
            issueRevision: 1,
            actor: 'agent-9',
            onBehalfOf: 'mem_alice',
            createdAt: '2026-11-03T10:00:00.000Z',
          },
          {
            id: 12,
            field: 'description',
            body: 'Invite copy, second pass.',
            source: 'edit',
            restoredFrom: null,
            issueRevision: 4,
            actor: 'mem_carol',
            onBehalfOf: 'mem_carol',
            createdAt: '2026-11-03T12:00:00.000Z',
          },
        ]),
      },
      restoreTextRevision: { mutate: vi.fn(async () => ({})) },
      editComment: { mutate: vi.fn(async () => ({})) },
      update: { mutate: vi.fn(setup.update ?? (async () => ({}))) },
      clearNeedsHuman: { mutate: vi.fn() },
    },
  }
  world.api = api
  world.current = {
    ...poolFixtureStore({
      issues: [
        makeIssue({
          id: 'i-1',
          repoPath: '/r',
          description: 'Invite copy, second pass.',
          revision: 4,
          assignee: 'mem_alice',
          owner: 'mem_alice',
          createdBy: { actor: { kind: 'agent', id: 'agent-9' }, onBehalfOf: 'mem_alice' },
          visibility: 'personal',
          ...setup.issue,
        } as Parameters<typeof makeIssue>[0]),
      ],
      sessions: [],
    }),
    updateIssue,
  }
  const issue = allIssueViewModels((world.current as { replica: never }).replica)[0]!
  render(<IssuePage issue={issue} orderedIds={[issue.id]} onBack={vi.fn()} onNavigate={vi.fn()} />)
  return { api, updateIssue }
}

describe("Bob opening Alice's task", () => {
  it('sees the assignee, creator and collaborators by name, and the D13 summary of Alice’s sessions with no control to open or drive them', async () => {
    show()
    await waitFor(() => expect(screen.getAllByTestId('other-member-session')).toHaveLength(2))
    expect(screen.getAllByTestId('assignee-trigger')[0]?.textContent).toContain('Alice Martin')
    expect(screen.getAllByTestId('about-created-by')[0]?.textContent).toBe(
      'Agent agent-9, for Alice Martin',
    )
    await waitFor(() =>
      expect(screen.getAllByTestId('about-collaborators')[0]?.textContent).toBe(
        'Alice Martin, Carol Diaz',
      ),
    )
    const sessions = screen.getAllByTestId('other-member-sessions')[0]!
    expect(sessions.textContent).toContain('Invite flow copy')
    expect(sessions.textContent).toContain('Alice Martin')
    expect(sessions.textContent).toContain('live')
    expect(sessions.textContent).toContain('idle')
    // Bob's own session is a row he can open, never a dead summary copy.
    expect(sessions.textContent).not.toContain('My own session')
    // Owner, title and state only: nothing to press, nothing that links in.
    expect(sessions.querySelectorAll('button, a, input, [role="button"]')).toHaveLength(0)
    // No raw member id anywhere a person is named.
    expect(document.body.textContent).not.toContain('mem_')
  })

  it('can reassign the task to another member', async () => {
    const { updateIssue } = show()
    await userEvent.click(screen.getAllByTestId('assignee-trigger')[0]!)
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Carol Diaz' }))
    expect(updateIssue).toHaveBeenCalledWith('i-1', { assignee: 'mem_carol' })
  })

  it('can edit the description, sending the revision it was cut from', async () => {
    const { api } = show()
    await userEvent.click(screen.getByTitle('Click to edit description'))
    const editor = screen.getByLabelText('Task description')
    fireEvent.change(editor, { target: { value: 'Invite copy, third pass.' } })
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
    await waitFor(() =>
      expect(api.issues.update.mutate).toHaveBeenCalledWith({
        id: 'i-1',
        patch: { description: 'Invite copy, third pass.' },
        expectedRevision: 4,
      }),
    )
  })

  it('can restore an earlier description from its history, named by member', async () => {
    const { api } = show()
    await userEvent.click(screen.getByTestId('description-history-toggle'))
    const revisions = await screen.findAllByTestId('text-revision')
    expect(revisions.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Carol Diaz edited'),
      expect.stringContaining('Alice Martin wrote it'),
    ])
    // The current text has nothing to restore; the earlier one does.
    expect(within(revisions[0]!).queryByTestId('text-revision-restore')).toBeNull()
    await userEvent.click(within(revisions[1]!).getByTestId('text-revision-restore'))
    expect(api.issues.restoreTextRevision.mutate).toHaveBeenCalledWith({
      id: 'i-1',
      revisionId: 11,
    })
  })

  it('gets an edit control on his own comment and none on Alice’s', async () => {
    const { api } = show()
    const comments = await screen.findAllByTestId('activity-comment')
    const alice = comments.find((c) => c.textContent?.includes('I started on the copy.'))!
    const bob = comments.find((c) => c.textContent?.includes('I will review it.'))!
    expect(within(alice).queryByTestId('comment-edit')).toBeNull()
    await userEvent.click(within(bob).getByTestId('comment-edit'))
    fireEvent.change(within(bob).getByLabelText('Edit comment'), {
      target: { value: 'I will review it today.' },
    })
    await userEvent.click(within(bob).getByTestId('comment-save'))
    expect(api.issues.editComment.mutate).toHaveBeenCalledWith({
      id: 'i-1',
      commentId: 'c-bob',
      body: 'I will review it today.',
    })
  })
})

describe('no sharing control for tasks', () => {
  it('says the task is visible to all members, with nothing to share', () => {
    show()
    const about = screen.getAllByTestId('issue-about')[0]!
    expect(screen.getAllByTestId('about-visibility')[0]?.textContent).toBe('Visible to all members')
    expect(about.textContent).not.toContain('Private')
    expect(about.querySelectorAll('button, input, select, a')).toHaveLength(0)
    expect(document.body.textContent).not.toMatch(/\bshare\b|grant access|invite member/i)
    // The owner is the Assignee, not a second Origin row.
    expect(screen.queryByTestId('about-owner')).toBeNull()
  })
})

describe('the server’s allowed actions drive the controls', () => {
  it('draws no reassign, edit, restore or comment control the server did not allow', async () => {
    show({ allowed: { reassign: false, edit: false, restore: false, comment: false } })
    await waitFor(() => expect(screen.queryAllByTestId('assignee-trigger')).toHaveLength(0))
    expect(screen.getAllByTestId('assignee-name')[0]?.textContent).toContain('Alice Martin')
    expect(screen.queryByTitle('Click to edit description')).toBeNull()
    expect(screen.queryByLabelText('Add a comment')).toBeNull()
    await userEvent.click(screen.getByTestId('description-history-toggle'))
    await screen.findAllByTestId('text-revision')
    expect(screen.queryByTestId('text-revision-restore')).toBeNull()
  })
})

describe('a description edit that another member beat', () => {
  it('keeps the draft and shows the current text and revision', async () => {
    const conflict = Object.assign(new Error('expected revision 4, but it is at revision 6'), {
      data: { code: 'CONFLICT', httpStatus: 409 },
    })
    show({
      update: async () => {
        throw conflict
      },
      current: { revision: 6, description: 'Carol rewrote the invite copy.' },
    })
    await userEvent.click(screen.getByTitle('Click to edit description'))
    const editor = screen.getByLabelText('Task description')
    fireEvent.change(editor, { target: { value: 'Bob’s version.' } })
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
    const notice = await screen.findByTestId('description-conflict')
    expect(notice.textContent).toContain('revision 6')
    expect(notice.textContent).toContain('Carol rewrote the invite copy.')
    expect((screen.getByLabelText('Task description') as HTMLTextAreaElement).value).toBe(
      'Bob’s version.',
    )
  })

  it('applies on top when only another field moved the revision', async () => {
    let calls = 0
    const { api } = show({
      update: async () => {
        calls++
        if (calls === 1)
          throw Object.assign(new Error('stale'), { data: { code: 'CONFLICT', httpStatus: 409 } })
        return {}
      },
      current: { revision: 5, description: 'Invite copy, second pass.' },
    })
    await userEvent.click(screen.getByTitle('Click to edit description'))
    const editor = screen.getByLabelText('Task description')
    fireEvent.change(editor, { target: { value: 'Invite copy, third pass.' } })
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(api.issues.update.mutate).toHaveBeenCalledTimes(2))
    expect(api.issues.update.mutate).toHaveBeenLastCalledWith({
      id: 'i-1',
      patch: { description: 'Invite copy, third pass.' },
      expectedRevision: 5,
    })
    expect(screen.queryByTestId('description-conflict')).toBeNull()
  })
})

describe('an assignee from before members', () => {
  it('shows the member’s name, and the old free-text label only as a note', () => {
    show({ issue: { legacyAssignee: 'agent:codex' } as never })
    expect(screen.getAllByTestId('assignee-trigger')[0]?.textContent).toContain('Alice Martin')
    expect(screen.getAllByTestId('assignee-legacy')[0]?.textContent).toBe(
      'Earlier label: agent:codex',
    )
  })
})
