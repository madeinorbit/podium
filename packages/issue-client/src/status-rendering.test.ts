import { ALL_ISSUE_STATUSES, isIssueStage } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { IssueTrpc } from './client'
import { ISSUE_COMMANDS } from './commands'

function client(row: object) {
  return {
    issues: {
      list: { query: async () => [row] },
      get: { query: async () => row },
      comments: { query: async () => [] },
      children: { query: async () => [row] },
      depReport: { query: async () => [row] },
      tree: { query: async () => ({ root: row, totalNodes: 1, omitted: 0 }) },
    },
  } as unknown as IssueTrpc
}

async function render(name: string, row: object) {
  const command = ISSUE_COMMANDS.find((entry) => entry.name === name)
  if (!command) throw new Error(`Missing ${name} command`)
  return (await command.run(client(row), name === 'list' ? {} : { id: '1' })).text
}

describe('CLI issue statuses', () => {
  it.each(
    ALL_ISSUE_STATUSES,
  )('keeps %s visible in list, show, children and tree', async (status) => {
    const closed = ['done', 'cancelled', 'duplicate', 'superseded'].includes(status)
    const row = {
      id: 'iss_1',
      seq: 1,
      title: 'Task',
      description: '',
      priority: 2,
      stage: isIssueStage(status) ? status : 'done',
      closedReason: closed ? status : undefined,
      closed,
      ready: !closed,
      blocked: false,
      needsHuman: false,
      blocksDeps: [],
      children: [],
      deps: [],
      dependents: [],
      sessions: [],
      omittedChildren: 0,
    }
    for (const command of ['list', 'children', 'tree', 'deps']) {
      const output = await render(command, row)
      expect(output).toContain(`[${status}]`)
      if (closed && command !== 'list') expect(output).toContain(`— ${status.toUpperCase()}`)
    }
    if (closed) expect(await render('show', row)).toContain(`status=${status}`)
    else expect(await render('show', row)).toContain(`stage=${status}`)
  })

  it.each([
    ['wontfix', 'cancelled'],
    ['dupe', 'duplicate'],
    ['obsolete', 'obsolete'],
  ])('preserves the outcome of legacy close reason %s', async (closedReason, status) => {
    const row = { seq: 1, title: 'Task', stage: 'done', closedReason, priority: 2 }
    expect(await render('list', row)).toContain(`[${status}]`)
    expect(await render('show', row)).toContain(`status=${status}`)
  })
})
