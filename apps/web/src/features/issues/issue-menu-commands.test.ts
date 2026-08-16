import { describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { issueMenuEligibility } from './issue-context-menu'
import { type IssueMenuCommandDeps, runIssueMenuCommand } from './issue-menu-commands'
import { createIssueMenuData, issueMenuEntries } from './issue-menu-config'

function menuData() {
  const issue = makeIssue({ labels: ['bug'], worktreePath: null })
  const data = createIssueMenuData({
    issues: [issue],
    allIssues: [issue],
    eligibility: issueMenuEligibility([issue]),
  })
  if (!data) throw new Error('fixture did not produce menu data')
  return data
}

function commandDeps() {
  const mutate = vi.fn(async (value: unknown) => value)
  // The OUTBOXED half (POD-781): these are store actions, not tRPC procedures,
  // so a menu entry that has been made optimistic is asserted on the action and
  // a mutant that reroutes it back through `trpc` shows up as a missing call
  // rather than as a passing test on the other object.
  const actions = {
    updateIssue: vi.fn(async () => {}),
    deleteIssue: vi.fn(async () => {}),
    closeIssue: vi.fn(async () => {}),
    deferIssue: vi.fn(async () => {}),
    undeferIssue: vi.fn(async () => {}),
    setIssueLabels: vi.fn(async () => {}),
  }
  return {
    deps: {
      trpc: {
        issues: {
          update: { mutate },
          setLabels: { mutate },
          start: { mutate },
          addSession: { mutate },
          defer: { mutate },
          undefer: { mutate },
          close: { mutate },
          duplicate: { mutate },
          restore: { mutate },
          delete: { mutate },
        },
      },
      markIssueRead: vi.fn(async () => {}),
      markIssueUnread: vi.fn(async () => {}),
      ...actions,
      setOpenIssueId: vi.fn(),
      setView: vi.fn(),
    } as unknown as IssueMenuCommandDeps,
    mutate,
    actions,
  }
}

describe('shared issue menu command execution', () => {
  it('keeps stage, label, and start mutations identical to the context menu', async () => {
    const data = menuData()
    const { deps, mutate, actions } = commandDeps()
    const entries = issueMenuEntries(data)
    const stage = entries.find((entry) => entry.id === 'status')
    const labels = entries.find((entry) => entry.id === 'labels')
    const agent = entries.find((entry) => entry.id === 'agent')
    if (
      !stage ||
      !labels ||
      !agent ||
      stage.kind !== 'submenu' ||
      labels.kind !== 'submenu' ||
      agent.kind !== 'submenu'
    ) {
      throw new Error('expected shared submenu fixtures')
    }

    await runIssueMenuCommand(data, stage, 'review', deps)
    await runIssueMenuCommand(data, labels, 'bug', deps)
    await runIssueMenuCommand(data, agent, '', deps)

    expect(actions.updateIssue).toHaveBeenCalledWith('i', { stage: 'review' })
    expect(actions.setIssueLabels).toHaveBeenCalledWith('i', [])
    // `agent` stays a direct call — starting a session is not an issue-row edit
    // and has nothing to paint.
    expect(mutate).toHaveBeenCalledWith({ id: 'i' })
  })

  it('sends close, defer and unsnooze through the outbox actions, not tRPC', async () => {
    const data = menuData()
    const { deps, mutate, actions } = commandDeps()
    const entries = issueMenuEntries(data)
    // Closing is a STATUS pick now (POD-1074), not its own menu action.
    const status = entries.find((entry) => entry.id === 'status')
    const defer = entries.find((entry) => entry.id === 'defer')
    if (!status || status.kind !== 'submenu' || !defer || defer.kind !== 'submenu') {
      throw new Error('expected status and defer fixtures')
    }

    await runIssueMenuCommand(data, status, 'done', deps)
    await runIssueMenuCommand(data, defer, 'next-message', deps)
    await runIssueMenuCommand(data, defer, 'undefer', deps)

    expect(actions.closeIssue).toHaveBeenCalledWith('i', 'done')
    expect(actions.deferIssue).toHaveBeenCalledWith('i', 'next-message')
    expect(actions.undeferIssue).toHaveBeenCalledWith('i')
    expect(mutate).not.toHaveBeenCalled()
  })

  it('toggles the pin through the patch action — one command, one queue', async () => {
    const data = menuData()
    const { deps, actions } = commandDeps()
    const pin = issueMenuEntries(data).find((entry) => entry.id === 'pin')
    if (!pin || pin.kind !== 'action') throw new Error('expected a pin fixture')

    await runIssueMenuCommand(data, pin, undefined, deps)

    expect(actions.updateIssue).toHaveBeenCalledWith('i', { pinned: true })
  })

  it('asks before archiving an issue that has children, counting the issue itself', async () => {
    const issue = makeIssue({ childCount: 2 })
    const data = createIssueMenuData({
      issues: [issue],
      allIssues: [issue],
      eligibility: issueMenuEligibility([issue]),
    })
    if (!data) throw new Error('fixture did not produce menu data')
    const { deps, actions } = commandDeps()
    const confirm = vi.fn(() => false)
    deps.confirm = confirm
    const archive = issueMenuEntries(data).find((entry) => entry.id === 'archive')
    if (!archive || archive.kind !== 'action') throw new Error('expected an archive fixture')

    await runIssueMenuCommand(data, archive, undefined, deps)

    expect(confirm).toHaveBeenCalledWith(
      'Archive this task? This affects 3 tasks. They leave active views, and any running agents are stopped.',
    )
    expect(actions.updateIssue).not.toHaveBeenCalled()
  })

  // POD-1077: archiving an issue cascades to its member sessions and PARKS each
  // one, so the confirm has to say that. The old sentence named sub-tasks only,
  // which is why archiving read as filing rather than as a teardown.
  it('names the agents it will stop, and asks even with no sub-tasks', async () => {
    const issue = makeIssue({ childCount: 0, memberSessionIds: ['s1', 's2'] })
    const data = createIssueMenuData({
      issues: [issue],
      allIssues: [issue],
      eligibility: issueMenuEligibility([issue]),
    })
    if (!data) throw new Error('fixture did not produce menu data')
    const { deps, actions } = commandDeps()
    const confirm = vi.fn(() => false)
    deps.confirm = confirm
    const archive = issueMenuEntries(data).find((entry) => entry.id === 'archive')
    if (!archive || archive.kind !== 'action') throw new Error('expected an archive fixture')

    await runIssueMenuCommand(data, archive, undefined, deps)

    expect(confirm).toHaveBeenCalledWith(
      'Archive this task? This affects 1 task and 2 agents. They leave active views, and any running agents are stopped.',
    )
    expect(actions.updateIssue).not.toHaveBeenCalled()
  })

  // Nothing to cascade to — the confirm would be ceremony over tidying one row.
  it('archives a childless, agentless task without asking', async () => {
    const issue = makeIssue({ childCount: 0 })
    const data = createIssueMenuData({
      issues: [issue],
      allIssues: [issue],
      eligibility: issueMenuEligibility([issue]),
    })
    if (!data) throw new Error('fixture did not produce menu data')
    const { deps, actions } = commandDeps()
    const confirm = vi.fn(() => false)
    deps.confirm = confirm
    const archive = issueMenuEntries(data).find((entry) => entry.id === 'archive')
    if (!archive || archive.kind !== 'action') throw new Error('expected an archive fixture')

    await runIssueMenuCommand(data, archive, undefined, deps)

    expect(confirm).not.toHaveBeenCalled()
    expect(actions.updateIssue).toHaveBeenCalledWith(issue.id, { archived: true })
  })

  it('routes open and property actions through the same data entry IDs', async () => {
    const data = menuData()
    const { deps, actions } = commandDeps()
    const open = issueMenuEntries(data).find((entry) => entry.id === 'open')
    const priority = issueMenuEntries(data).find((entry) => entry.id === 'priority')
    if (!open || !priority || open.kind !== 'action' || priority.kind !== 'submenu') {
      throw new Error('expected open and priority fixtures')
    }

    await runIssueMenuCommand(data, open, undefined, deps)
    await runIssueMenuCommand(data, priority, '2', deps)

    expect(deps.setOpenIssueId).toHaveBeenCalledWith('i')
    expect(deps.setView).toHaveBeenCalledWith('issues')
    expect(actions.updateIssue).toHaveBeenCalledWith('i', { priority: 2 })
  })
})
