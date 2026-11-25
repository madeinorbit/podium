import { asIssueId, type IssueId, type IssueReport } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { fixtureWriteScope } from '@podium/sync/testing'
import { describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../../store'
import { openTestStore } from '../../../test-support/open-test-store'
import { expectConstantRoundTrips } from '../../../test-support/round-trip-count'
import { seedRows } from '../../../test-support/seed-rows'
import { sessionReadPorts } from '../../../test-support/session-facts'
import { expectConstantStatements, type StatementPin } from '../../../test-support/statement-count'
import { IssueService } from '../service'
import { issueTestPlumbing } from './test-plumbing'

interface Fixture {
  store: SessionStore
  issues: IssueService
  ids: IssueId[]
}

async function setup(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const machineId = store.hostMachine!.id
  await store.repos.addRepo('/repo', machineId)
  const issues = await IssueService.create({
    store,
    resolveMachine: async () => machineId,
    ...sessionReadPorts(() => []),
    getSettings: async () => normalizeSettings({}),
    spawnSession: vi.fn(),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(undefined, { store }),
  })
  const ids: IssueId[] = []
  for (let n = 0; n < size; n++) {
    const issue = await issues.crud.create(issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: `Generated issue ${n}`,
      startNow: false,
      parentBranch: 'main',
    })
    ids.push(issue.id)
  }
  return { store, issues, ids }
}

const pin: StatementPin<Fixture> = {
  name: 'issue frames (bulk reports)',
  sizes: [1, 50],
  setup,
  target: (f) => f.store,
  run: async (f) => await f.issues.reports.getMany(f.ids),
  check: (result, f) => {
    const reports = result as Map<string, IssueReport>
    expect([...reports.keys()]).toEqual(f.ids)
    expect([...reports.values()].map((report) => report.title)).toEqual(
      f.ids.map((_id, n) => `Generated issue ${n}`),
    )
  },
  teardown: async (f) => await f.store.close(),
}

describe('issue frame bulk reads', { timeout: 60_000 }, () => {
  it('reads one and fifty reports in the same number of statements', async () => {
    await expectConstantStatements(pin, 14)
  })

  it('reads one and fifty reports in the same number of round trips', async () => {
    await expectConstantRoundTrips(pin, 4)
  })

  it('preserves individual reports, input order, markers, panels and dependency closure', async () => {
    const f = await setup(3)
    try {
      const [parent, child, blocker] = f.ids as [IssueId, IssueId, IssueId]
      await f.issues.crud.update(f.issues.reports.store.serverWriter, child, { parentId: parent })
      await f.issues.hierarchy.addDep(f.issues.reports.store.serverWriter, child, blocker)
      await seedRows(f.store, async () => {
        await f.store.issues.setIssueLabels(child, ['generated'])
        await f.store.issues.panel.save(fixtureWriteScope(), 'issuePanelTodo', {
          id: 'todo-generated',
          issueId: child,
          position: 0,
          text: 'Generated task',
          done: true,
        })
        await f.store.issues.panel.save(fixtureWriteScope(), 'issuePanelState', {
          id: child,
          text: 'Generated state',
          updatedAt: '2026-11-25T00:00:00.000Z',
        })
      })
      const ids = [child, asIssueId('missing'), parent, child, blocker]
      const individual = new Map<string, IssueReport>()
      for (const id of ids) {
        const report = await f.issues.reports.get(id)
        if (report) individual.set(id, report)
      }
      expect(await f.issues.reports.getMany(ids)).toEqual(individual)
      expect(await f.issues.reports.getMany([])).toEqual(new Map())
      expect(individual.get(child)).toMatchObject({ blocked: true, labels: ['generated'] })
      expect(individual.get(parent)).toMatchObject({ childCount: 1, childDoneCount: 0 })
    } finally {
      await f.store.close()
    }
  })
})
