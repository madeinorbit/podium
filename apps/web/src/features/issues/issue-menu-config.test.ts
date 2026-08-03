import { asIssueId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { issueMenuEligibility } from './issue-context-menu'
import { createIssueMenuData, issueMenuCommandKeys, issueMenuEntries } from './issue-menu-config'
import { issueMenuPaletteCommands } from './issue-menu-palette-commands'

const deps = {
  trpc: {} as never,
  markIssueRead: vi.fn(async () => {}),
  markIssueUnread: vi.fn(async () => {}),
  setOpenIssueId: vi.fn(),
  setView: vi.fn(),
}

describe('declarative issue menu projections', () => {
  it('uses identical action and option keys for the menu and palette', () => {
    const issue = makeIssue({ labels: ['bug'] })
    const sibling = makeIssue({ id: asIssueId('sibling'), title: 'Sibling' })
    const data = createIssueMenuData({
      issues: [issue],
      allIssues: [issue, sibling],
      eligibility: issueMenuEligibility([issue]),
      renameEnabled: false,
    })
    expect(data).not.toBeNull()
    if (!data) return

    const menuKeys = issueMenuCommandKeys(data).sort()
    const paletteKeys = issueMenuPaletteCommands(data, deps)
      .map((command) => command.id.replace(`issue-menu:${issue.id}:`, ''))
      .sort()

    expect(paletteKeys).toEqual(menuKeys)
    expect(issueMenuEntries(data).map((entry) => entry.id)).toContain('stage')
    expect(issueMenuEntries(data).map((entry) => entry.id)).toContain('duplicate')
  })

  it('keeps board-only duplicate options out of the sidebar projection', () => {
    const issue = makeIssue()
    const sibling = makeIssue({ id: asIssueId('sibling') })
    const data = createIssueMenuData({
      issues: [issue],
      allIssues: [issue, sibling],
      eligibility: issueMenuEligibility([issue], 'sidebar'),
      surface: 'sidebar',
    })
    expect(data).not.toBeNull()
    if (!data) return
    expect(issueMenuEntries(data).some((entry) => entry.id === 'duplicate')).toBe(false)
  })

  it('retains the single-machine default agent and every configured submenu value', () => {
    const issue = makeIssue({ worktreePath: null })
    const data = createIssueMenuData({
      issues: [issue],
      allIssues: [issue],
      eligibility: issueMenuEligibility([issue]),
    })
    expect(data).not.toBeNull()
    if (!data) return
    const agent = issueMenuEntries(data).find((entry) => entry.id === 'agent')
    const defer = issueMenuEntries(data).find((entry) => entry.id === 'defer')
    expect(agent && agent.kind === 'submenu' ? agent.options(data)[0] : null).toMatchObject({
      value: '',
      label: expect.stringContaining('(default)'),
    })
    expect(
      defer && defer.kind === 'submenu' ? defer.options(data).map((o) => o.value) : [],
    ).toEqual(['hour', 'tomorrow', 'week', 'next-message'])
  })
})
