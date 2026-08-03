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
      setOpenIssueId: vi.fn(),
      setView: vi.fn(),
    } as unknown as IssueMenuCommandDeps,
    mutate,
  }
}

describe('shared issue menu command execution', () => {
  it('keeps stage, label, and start mutations identical to the context menu', async () => {
    const data = menuData()
    const { deps, mutate } = commandDeps()
    const entries = issueMenuEntries(data)
    const stage = entries.find((entry) => entry.id === 'stage')
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

    expect(mutate).toHaveBeenCalledWith({ id: 'i', patch: { stage: 'review' } })
    expect(mutate).toHaveBeenCalledWith({ id: 'i', labels: [] })
    expect(mutate).toHaveBeenCalledWith({ id: 'i' })
  })

  it('routes open and property actions through the same data entry IDs', async () => {
    const data = menuData()
    const { deps, mutate } = commandDeps()
    const open = issueMenuEntries(data).find((entry) => entry.id === 'open')
    const priority = issueMenuEntries(data).find((entry) => entry.id === 'priority')
    if (!open || !priority || open.kind !== 'action' || priority.kind !== 'submenu') {
      throw new Error('expected open and priority fixtures')
    }

    await runIssueMenuCommand(data, open, undefined, deps)
    await runIssueMenuCommand(data, priority, '2', deps)

    expect(deps.setOpenIssueId).toHaveBeenCalledWith('i')
    expect(deps.setView).toHaveBeenCalledWith('issues')
    expect(mutate).toHaveBeenCalledWith({ id: 'i', patch: { priority: 2 } })
  })
})
