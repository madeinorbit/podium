import { asSessionId } from '@podium/model'
import type { MetadataChange } from '@podium/protocol'
import { normalizeSettings } from '@podium/runtime'
import { afterEach, expect, it, vi } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import { sessionReadPorts } from '../../test-support/session-facts'
import { IssueService } from './service'
import { issueTestPlumbing } from './service/test-plumbing'

const stores: Awaited<ReturnType<typeof openTestStore>>[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

/** Compare the same production mutations before and after the record retirement.
 * Timings are evidence only; exact feed rows and repository calls detect regressions. */
it.each([16, 64])('publishes only the changed normalized issue among %i rows', async (count) => {
  const store = await openTestStore(':memory:')
  stores.push(store)
  await store.repos.addRepo('/repo', store.hostMachineId)
  const published: MetadataChange[] = []
  const svc = await IssueService.create({
    store,
    ...sessionReadPorts(() => []),
    getSettings: async () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: async () => ({ sessionId: asSessionId('unused'), machine: 'machine-under-test' }),
    repoOp: async () => ({ ok: true, output: '' }),
    ...issueTestPlumbing((change) => published.push(change)),
    now: () => '2026-10-02T00:00:00.000Z',
  })
  const ids: string[] = []
  for (let index = 0; index < count; index++) {
    ids.push(
      (await svc.crud.create({ repoPath: '/repo', title: `Fixture issue ${index}`, startNow: false }))
        .id,
    )
  }
  const [target, parent] = ids as [string, string, ...string[]]
  const calls = {
    commentCount: vi.spyOn(store.issues, 'countIssueComments'),
    allCommentCounts: vi.spyOn(store.issues, 'countIssueCommentsByIssue'),
    incomingDeps: vi.spyOn(store.issues, 'listDependents'),
    allDeps: vi.spyOn(store.issues, 'listAllIssueDeps'),
  }
  const samples: Array<{
    operation: string
    milliseconds: number
    rows: number
    bytes: number
    kinds: string[]
    calls: Record<string, number>
  }> = []
  const emitted: MetadataChange[][] = []
  const operations = [
    ['update', () => svc.crud.update(target, { title: 'Changed fixture title' })],
    ['reparent', () => svc.hierarchy.reparent(target, parent)],
    ['close', () => svc.crud.close(target)],
  ] as const
  try {
    for (const [operation, run] of operations) {
      published.length = 0
      for (const spy of Object.values(calls)) spy.mockClear()
      const start = performance.now()
      await run()
      const milliseconds = performance.now() - start
      emitted.push([...published])
      samples.push({
        operation,
        milliseconds,
        rows: published.length,
        bytes: Buffer.byteLength(JSON.stringify(published)),
        kinds: [...new Set(published.map((change) => change.entity))],
        calls: Object.fromEntries(
          Object.entries(calls).map(([name, spy]) => [name, spy.mock.calls.length]),
        ),
      })
    }
    console.log('issue-publication-cost', JSON.stringify({ count, samples }))
    for (const changes of emitted) {
      expect(
        changes.filter((change) => change.entity === 'issueProjection').map((change) => change.id),
      ).toEqual([target])
      expect(changes.every((change) => String(change.entity) !== 'issue')).toBe(true)
    }
    for (const sample of samples) {
      expect(sample.calls.commentCount).toBe(0)
      expect(sample.calls.allCommentCounts).toBe(0)
      expect(sample.calls.incomingDeps).toBe(sample.operation === 'close' ? 1 : 0)
      expect(sample.calls.allDeps).toBe(0)
    }
  } finally {
    for (const spy of Object.values(calls)) spy.mockRestore()
  }
})
