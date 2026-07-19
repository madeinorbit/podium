import type { IssueWire, SessionMeta } from '@podium/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { IssueContextMenu } from './IssueContextMenu'

const featureEnabled = vi.hoisted(() => ({ value: true }))
vi.mock('@/lib/use-feature', () => ({
  useFeature: () => featureEnabled.value,
}))

// The store slices the menu reads. Mutated per test before render.
const state: { repos: unknown[]; machines: unknown[]; sessions: unknown[] } = {
  repos: [],
  machines: [],
  sessions: [],
}
const handoffMutate = vi.fn(async () => ({ ok: true }))

vi.mock('@/app/store', () => {
  const useStore = () => ({
    trpc: { sessions: { handoff: { mutate: handoffMutate } } },
    markIssueRead: vi.fn(),
    markIssueUnread: vi.fn(),
    sessions: state.sessions,
    repos: state.repos,
    machines: state.machines,
  })
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

const LUD = 'ludovico'
const MAC = 'mac'
const repoWire = (machineId: string, path: string, worktrees: string[]) => ({
  path,
  kind: 'repository' as const,
  originUrl: 'git@github.com:madeinorbit/podium.git',
  repoId: 'repo_36de69e6',
  machineId,
  worktrees: worktrees.map((w) => ({ path: w, branch: 'issue/779' })),
})
const machine = (id: string) => ({
  id,
  name: id,
  hostname: id,
  online: true,
  inventory: { agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }] },
})
const session = (over: Partial<SessionMeta> & Pick<SessionMeta, 'sessionId'>): SessionMeta =>
  ({
    agentKind: 'claude-code',
    cwd: '/Users/mw/Source/other/podium/.worktrees/issue-779',
    machineId: MAC,
    status: 'live',
    createdAt: 't',
    updatedAt: 't',
    unread: false,
    ...over,
  }) as SessionMeta

function open(issue: IssueWire): void {
  render(
    <IssueContextMenu
      issues={[issue]}
      allIssues={[issue]}
      anchor={{ x: 10, y: 10 }}
      onClose={vi.fn()}
      onOpen={vi.fn()}
      onRename={vi.fn()}
    />,
  )
}

const handoffItem = (): HTMLElement => screen.getByRole('menuitem', { name: /Handoff/ })

afterEach(() => {
  cleanup()
  handoffMutate.mockClear()
  featureEnabled.value = true
  state.repos = []
  state.machines = []
  state.sessions = []
})

describe('IssueContextMenu handoff (POD-850)', () => {
  it('hides handoff while the feature is disabled', () => {
    featureEnabled.value = false
    state.sessions = [session({ sessionId: 'agent' })]
    open(makeIssue({ sessions: [{ sessionId: 'agent' } as SessionMeta] }))
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
    state.sessions = [session({ sessionId: 'agent' })]
    open(
      makeIssue({
        worktreePath: '/Users/mw/Source/other/podium/.worktrees/issue-779',
        sessions: [{ sessionId: 'agent' } as SessionMeta],
      }),
    )
    fireEvent.click(handoffItem())
    fireEvent.click(screen.getByRole('menuitem', { name: LUD }))
    expect(handoffMutate).toHaveBeenCalledWith({ sessionId: 'agent', machineId: LUD })
  })

  it('POD-779 shape: still shows Handoff with the reason when the agent drifted off its worktree', () => {
    // Agent on the mac but cwd is a linux main-checkout path (not a worktree), and
    // the issue has no worktree the mac knows → blocked, but the item must appear.
    state.repos = [
      repoWire(MAC, '/home/mgw/src/other/podium', []),
      repoWire(LUD, '/home/mgw/src/other/podium', []),
    ]
    state.machines = [machine(MAC), machine(LUD)]
    state.sessions = [session({ sessionId: 'agent', cwd: '/home/mgw/src/other/podium' })]
    open(makeIssue({ worktreePath: null, sessions: [{ sessionId: 'agent' } as SessionMeta] }))
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
    state.sessions = [session({ sessionId: 'sh', agentKind: 'shell' })]
    open(makeIssue({ sessions: [{ sessionId: 'sh' } as SessionMeta] }))
    expect(handoffItem().textContent).toContain('No agent session to hand off')
  })
})
