import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView, SessionViewInput } from '@podium/client-core/session-values'
import { MobxPool } from '@podium/client-graph'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import {
  asIssueId,
  asMachineId,
  asRepoId,
  asSessionId,
  asUserId,
  type GitRepositoryWire,
  type MachineId,
  type MachineWire,
  resolveUserPreferences,
} from '@podium/model'
import { nativeAccountId } from '@podium/runtime'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { runInAction } from 'mobx'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { makeIssue } from '@/lib/test-issue'
import { IssueContextMenu } from './IssueContextMenu'
import type { IssueMenuPoolInputs } from './issue-menu-pool-inputs'
import { IssuePageWorldContext } from './issue-page/issue-page-data'

const featureEnabled = vi.hoisted(() => ({ value: true }))
const preferences = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
function publishHarness(harness: string) {
  const userId = asUserId('menu-operator')
  preferences.apply({
    type: 'update',
    rows: [
      {
        kind: 'userPreferences',
        id: userId,
        value: {
          ...resolveUserPreferences(
            { userId, 'roles.coding.accountId': nativeAccountId(harness) },
            userId,
          ),
          id: userId,
        } as never,
      },
    ],
  })
}
vi.mock('@/app/store-worklist-pool', async (original) => ({
  ...(await original<typeof import('@/app/store-worklist-pool')>()),
  useWorklistPoolProjection: <T,>(read: (pool: MobxPool) => T) => {
    const projection = useMemo(() => createPoolProjection(preferences, read), [read])
    return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
  },
}))
vi.mock('@/lib/use-feature', () => ({
  useFeature: () => featureEnabled.value,
}))

// Explicit pool values and the unchanged action owner are separate fixtures.
const state: IssueMenuPoolInputs = {
  repos: [],
  machines: [],
  sessions: [],
}
// A move is a `session.handoff` effect record (POD-6422): the action answers its id.
const handoffSession = vi.fn(async () => 'eff_handoff')
const markIssueRead = vi.fn(async () => {})
const markIssueUnread = vi.fn(async () => {})

vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<typeof import('@podium/client-core/react')>()),
  useStoreHandle: () => ({
    access: {
      handoffSession,
      markIssueRead,
      markIssueUnread,
      get sessions() {
        throw new Error('Task menu read legacy sessions')
      },
      get repos() {
        throw new Error('Task menu read legacy repos')
      },
      get machines() {
        throw new Error('Task menu read legacy machines')
      },
    },
  }),
}))
vi.mock('@/app/store', () => ({
  useRuntimeSelector: () => {
    throw new Error('Task menu used a legacy selector')
  },
}))

const LUD = asMachineId('ludovico')
const MAC = asMachineId('mac')
const repoWire = (machineId: MachineId, path: string, worktrees: string[]): GitRepositoryWire => ({
  path,
  kind: 'repository' as const,
  originUrl: 'git@github.com:madeinorbit/podium.git',
  repoId: asRepoId('repo_36de69e6'),
  machineId,
  worktrees: worktrees.map((w) => ({ path: w, branch: 'issue/779' })),
})
const machine = (id: MachineId): MachineWire => ({
  id,
  name: id,
  hostname: id,
  lastSeenAt: 't',
  online: true,
  serviceAssignment: { server: false, agentExecution: true },
  availability: { epoch: 'boot-1', server: false, daemon: true, supervisor: true },
  inventory: {
    os: 'linux',
    arch: 'x64',
    tools: [],
    agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }],
  },
})
const session = (over: Partial<SessionViewInput> & Pick<SessionView, 'sessionId'>): SessionView =>
  ({
    agentKind: 'claude-code',
    // A real session always carries a title (the harness's, until renamed); the
    // handoff toast names the session it moved, so this can't be left off.
    title: 'POD-779-A',
    cwd: '/Users/mw/Source/other/podium/.worktrees/issue-779',
    machineId: MAC,
    status: 'live',
    harnessHandoff:
      over.harnessHandoff ?? ['claude-code', 'codex'].includes(over.agentKind ?? 'claude-code'),
    createdAt: 't',
    updatedAt: 't',
    unread: false,
    ...over,
    // Through `unknown`: this builder takes the INPUT side (plain-string ids) and
    // hands back the parsed side, and since POD-318 branded `machineId` the two
    // shapes no longer overlap structurally. A fixture builder is exactly the
    // construction site `wire-input.ts` describes.
  }) as unknown as SessionView

function open(
  issue: IssueViewModel & { memberSessionIds?: string[] },
  surface: 'board' | 'palette' = 'board',
): void {
  const viewIssue = {
    ...issue,
    memberSessionIds: issue.memberSessionIds?.map(asSessionId),
  }
  // POD-1077: the menu's cascade confirms are the app-wide dialog, so it reads
  // the ConfirmProvider context AppShell supplies in the real tree.
  render(
    <ConfirmProvider>
      <IssuePageWorldContext.Provider
        value={{ issues: [viewIssue], sessions: state.sessions as SessionView[] }}
      >
        <IssueContextMenu
          surface={surface}
          issues={[viewIssue]}
          allIssues={[viewIssue]}
          poolInputs={state}
          anchor={{ x: 10, y: 10 }}
          onClose={vi.fn()}
          onOpen={vi.fn()}
          onRename={vi.fn()}
        />
      </IssuePageWorldContext.Provider>
    </ConfirmProvider>,
  )
}

const handoffItem = (): HTMLElement => screen.getByRole('menuitem', { name: /Handoff/ })

afterEach(() => {
  cleanup()
  handoffSession.mockClear()
  markIssueRead.mockClear()
  markIssueUnread.mockClear()
  featureEnabled.value = true
  state.repos = []
  state.machines = []
  state.sessions = []
  runInAction(() => preferences.tables.userPreferences.clear())
})

it.each([
  true,
  false,
])('holds the read action through 600 live updates, initially unread=%s', (unread) => {
  const issue = makeIssue({ unread })
  const props = {
    issues: [issue],
    allIssues: [issue],
    poolInputs: state,
    anchor: { x: 10, y: 10 },
    onClose: vi.fn(),
    onOpen: vi.fn(),
  }
  const view = render(
    <ConfirmProvider>
      <IssueContextMenu {...props} />
    </ConfirmProvider>,
  )
  const label = unread ? 'Mark as read' : 'Mark as unread'
  const opposite = unread ? 'Mark as unread' : 'Mark as read'
  for (let index = 0; index < 600; index++) {
    const changed = {
      ...issue,
      unread: index % 2 === 0,
      updatedAt: new Date(Date.parse('2026-10-29T12:00:00.000Z') + index * 100).toISOString(),
    }
    view.rerender(
      <ConfirmProvider>
        <IssueContextMenu {...props} issues={[changed]} />
      </ConfirmProvider>,
    )
    expect(screen.getByRole('menuitem', { name: label })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: opposite })).toBeNull()
  }
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
  expect(unread ? markIssueRead : markIssueUnread).toHaveBeenCalledWith(issue.id)
  expect(unread ? markIssueUnread : markIssueRead).not.toHaveBeenCalled()
  view.unmount()
  render(
    <ConfirmProvider>
      <IssueContextMenu {...props} issues={[{ ...issue, unread: !unread }]} />
    </ConfirmProvider>,
  )
  expect(screen.getByRole('menuitem', { name: opposite })).toBeTruthy()
})

it('keeps deletion and lifecycle eligibility live while the read action is stored', () => {
  const issue = makeIssue({ unread: false })
  const props = {
    issues: [issue],
    allIssues: [issue],
    poolInputs: state,
    anchor: { x: 10, y: 10 },
    onClose: vi.fn(),
    onOpen: vi.fn(),
  }
  const view = render(
    <ConfirmProvider>
      <IssueContextMenu {...props} />
    </ConfirmProvider>,
  )
  expect(screen.getByRole('menuitem', { name: 'Mark as unread' })).toBeTruthy()
  view.rerender(
    <ConfirmProvider>
      <IssueContextMenu {...props} issues={[{ ...issue, closedReason: 'done' }]} />
    </ConfirmProvider>,
  )
  expect(screen.queryByRole('menuitem', { name: /Close as/ })).toBeNull()
  expect(screen.getByRole('menuitem', { name: 'Mark as unread' })).toBeTruthy()
  view.rerender(
    <ConfirmProvider>
      <IssueContextMenu {...props} issues={[{ ...issue, deletedAt: '2026-10-29T12:00:00.000Z' }]} />
    </ConfirmProvider>,
  )
  expect(screen.queryByRole('menuitem', { name: 'Mark as unread' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()
})

it('takes a new read action when another context-menu gesture replaces the opening', () => {
  const issue = makeIssue({ unread: true })
  const props = {
    issues: [issue],
    allIssues: [issue],
    poolInputs: state,
    anchor: { x: 10, y: 10 },
    onClose: vi.fn(),
  }
  const view = render(
    <ConfirmProvider>
      <IssueContextMenu {...props} />
    </ConfirmProvider>,
  )
  expect(screen.getByRole('menuitem', { name: 'Mark as read' })).toBeTruthy()
  view.rerender(
    <ConfirmProvider>
      <IssueContextMenu
        {...props}
        issues={[{ ...issue, unread: false }]}
        anchor={{ x: 30, y: 20 }}
      />
    </ConfirmProvider>,
  )
  expect(screen.getByRole('menuitem', { name: 'Mark as unread' })).toBeTruthy()
  view.rerender(
    <ConfirmProvider>
      <IssueContextMenu
        {...props}
        issues={[makeIssue({ id: 'other', unread: true })]}
        anchor={{ x: 30, y: 20 }}
      />
    </ConfirmProvider>,
  )
  expect(screen.getByRole('menuitem', { name: 'Mark as read' })).toBeTruthy()
})

it('updates an open auto agent submenu when the Settings harness changes', () => {
  publishHarness('codex')
  open(makeIssue({ defaultAgent: 'auto' }), 'palette')
  fireEvent.click(screen.getByRole('menuitem', { name: /Assign agent|Run now/ }))
  expect(screen.getByRole('menuitem', { name: 'Codex (default)' })).toBeTruthy()
  act(() => publishHarness('claude-code'))
  expect(screen.getByRole('menuitem', { name: 'Claude Code (default)' })).toBeTruthy()
})

describe('IssueContextMenu handoff (POD-850)', () => {
  it('hides handoff while the feature is disabled', () => {
    featureEnabled.value = false
    state.sessions = [session({ sessionId: asSessionId('agent') })]
    open(makeIssue({ sessions: [{ sessionId: asSessionId('agent') } as SessionView] }))
    expect(screen.queryByRole('menuitem', { name: /Handoff/ })).toBeNull()
  })

  it('offers a target and hands off the issue’s agent session on click', () => {
    state.repos = [
      repoWire(MAC, '/Users/mw/Source/other/podium', [
        '/Users/mw/Source/other/podium/.worktrees/issue-779',
      ]),
      repoWire(LUD, '/home/mgw/src/other/podium', []),
    ]
    state.machines = [machine(MAC), machine(LUD)]
    state.sessions = [session({ sessionId: asSessionId('agent') })]
    open(
      makeIssue({
        worktreePath: '/Users/mw/Source/other/podium/.worktrees/issue-779',
        memberSessionIds: ['agent'],
      }),
    )
    fireEvent.click(handoffItem())
    fireEvent.click(screen.getByRole('menuitem', { name: LUD }))
    expect(handoffSession).toHaveBeenCalledWith(asSessionId('agent'), LUD)
  })

  it('POD-779 shape: still shows Handoff with the reason when the agent drifted off its worktree', () => {
    // Agent on the mac but cwd is a linux main-checkout path (not a worktree), and
    // the issue has no worktree the mac knows → blocked, but the item must appear.
    state.repos = [
      repoWire(MAC, '/home/mgw/src/other/podium', []),
      repoWire(LUD, '/home/mgw/src/other/podium', []),
    ]
    state.machines = [machine(MAC), machine(LUD)]
    state.sessions = [
      session({ sessionId: asSessionId('agent'), cwd: '/home/mgw/src/other/podium' }),
    ]
    open(makeIssue({ worktreePath: null, memberSessionIds: ['agent'] }))
    const item = handoffItem()
    expect((item as HTMLButtonElement).disabled).toBe(true)
    expect(item.textContent).toContain('Only sessions in a worktree can be handed off')
  })

  it('shell-only issue shows Handoff disabled with “No agent session”', () => {
    state.repos = [
      repoWire(MAC, '/Users/mw/Source/other/podium', [
        '/Users/mw/Source/other/podium/.worktrees/issue-779',
      ]),
    ]
    state.machines = [machine(MAC)]
    state.sessions = [session({ sessionId: asSessionId('sh'), agentKind: 'shell' })]
    open(makeIssue({ memberSessionIds: ['sh'] }))
    expect(handoffItem().textContent).toContain('No agent session to hand off')
  })
})
