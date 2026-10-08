import { createRequire } from 'node:module'
import { lazyKeptCount } from '@podium/mobx-helpers'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { issuePages, type PageIssue } from './issue-page'
import { MobxPool } from './pool'
import type { RowRecord } from './shared/source'
import { LOADING } from './worklist/rollup'

/** Run the same fixture at the pilot and candidate SHA. Public helper counters
 * report watched fields; forced JSC collection reports retained heap, separate
 * from the already-created identities and the source's input/index storage. */
it('reports detail watched fields and retained heap at 4x and after release', async () => {
  const scale = 4,
    stamp = '2026-10-01T00:00:00.000Z'
  const task = (id: string, patch: object = {}): RowRecord =>
    ({
      kind: 'issue',
      id,
      value: {
        id,
        seq: 1,
        title: id,
        repoPath: '/repo',
        stage: 'planning',
        description: '',
        createdAt: stamp,
        updatedAt: stamp,
        deps: [],
        labels: [],
        ...patch,
      },
    }) as RowRecord
  const rows: RowRecord[] = [
    task('root'),
    task('child', { parentId: 'root' }),
    {
      kind: 'session',
      id: 'shown',
      value: {
        sessionId: 'shown',
        issueId: 'child',
        refIssueId: 'child',
        title: 'Shown',
        cwd: '/repo',
        archived: false,
        status: 'running',
        agentKind: 'codex',
        lastActiveAt: stamp,
      },
    } as RowRecord,
    ...Array.from(
      { length: 32 * scale },
      (_, at) =>
        ({
          kind: 'session',
          id: `hidden-${at}`,
          value: {
            sessionId: `hidden-${at}`,
            issueId: 'root',
            refIssueId: 'root',
            title: 'History',
            cwd: '/repo',
            archived: true,
            status: 'exited',
            agentKind: 'codex',
            lastActiveAt: stamp,
          },
        }) as RowRecord,
    ),
    ...Array.from({ length: 128 * scale }, (_, at) => task(`outside-${at}`)),
  ]
  const pool = new MobxPool({ selectedIssueId: 'child', coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows })
  const models = rows.map((row) =>
    row.kind === 'issue' ? pool.issueObject(row.id) : pool.sessionObject(row.id),
  )
  const views = issuePages(pool)
  // This test's optional branch makes the identical probe runnable on the old
  // pilot without restoring a legacy assembly to production.
  const oldReader = Reflect.get(views, 'data') as
    | undefined
    | ((id: string) => {
        title: string
        issue: { description: string; parentId?: string }
        issues: { id: string; title: string }[]
        children: { id: string }[]
        members: { title?: string; archived?: boolean; status?: string }[]
      })
  const { heapStats } = createRequire(import.meta.url)('bun:jsc') as {
    heapStats(): { heapSize: number }
  }
  const gc = () => (globalThis as unknown as { Bun: { gc(force: boolean): void } }).Bun.gc(true)
  const heap = () => {
    gc()
    return heapStats().heapSize
  }
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  const before = heap()
  const beforeFields = models.reduce((count, model) => count + lazyKeptCount(model), 0)
  let displayed: unknown
  const stop = autorun(() => {
    if (oldReader) {
      const data = oldReader('child')
      displayed = {
        title: data.title,
        description: data.issue.description,
        parent: data.issues.find((issue) => issue.id === data.issue.parentId)?.title,
        children: data.children.map((child) => child.id),
        crew: data.members.filter((session) => !session.archived && session.status !== 'exited')
          .map((session) => session.title),
      }
    } else {
      const model = views.issue('child') as PageIssue,
        row = views.row('child')
      if (row.children === LOADING || row.activeSessions === LOADING)
        throw new Error('Memory fixture is not ready')
      displayed = {
        title: row.title,
        description: model.description,
        parent: pool.issueObject('root').authoredTitle,
        children: row.children?.map((child) => child.id),
        crew: row.activeSessions?.map((session) => session.title),
      }
    }
  })
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  const watched = models.reduce((count, model) => count + lazyKeptCount(model), 0)
  const retained = heap() - before
  stop()
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  const released = models.reduce((count, model) => count + lazyKeptCount(model), 0)
  const afterRelease = heap() - before
  expect(displayed).toEqual({ title: 'child', description: '', parent: 'root', children: [], crew: ['Shown'] })
  console.info(
    'issue detail memory4x',
    JSON.stringify({
      reader: oldReader ? 'pilot bundle' : 'shared models',
      scale,
      issues: 514,
      sessions: 129,
      beforeFields,
      watchedFields: watched,
      readerFields: watched - beforeFields,
      heapBeforeBytes: before, heapWithReaderBytes: before + retained, retainedHeapBytes: retained,
      releasedFields: released,
      heapAfterReleaseBytes: afterRelease,
    }),
  )
  expect(released).toBeLessThanOrEqual(beforeFields)
  views.dispose()
  pool.dispose()
})
