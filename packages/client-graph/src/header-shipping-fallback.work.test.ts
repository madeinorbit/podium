import { omitGone } from './lookup'
import { headerEntities } from './header-entities'
import { headerView } from './header-views'
import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { installMobxWarnTrap } from '../../../tests/worklist/harness/src/mobx-trap'
import { insideReader, measureWork } from '../../../tests/worklist/harness/src/work-meter'
import { HEADER_ISSUE_SUMMARY_FIELDS, type HeaderRows } from './header-schema'
import { MobxPool } from './pool'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'
import type { RowRecord, RowSourceEvent } from './shared/source'
import { LOADING } from './worklist/rollup'
import { HIDDEN_ISSUE_FIELDS } from './worklist/visible'

const stamp = '2020-01-01T00:00:00Z'
installMobxWarnTrap({ errors: true })
const issue = (id: string, seq: number, path: string, patch: object = {}): RowRecord =>
  ({
    kind: 'issue',
    id,
    value: {
      id,
      seq,
      title: id,
      worktreePath: path,
      repoId: id,
      stage: 'planning',
      createdAt: stamp,
      updatedAt: stamp,
      description: '',
      deps: [],
      labels: [],
      archived: false,
      deletedAt: null,
      ...patch,
    },
  }) as RowRecord
const window = (path: string, issueId?: string): HeaderRows['window'] =>
  ({
    view: 'workspace',
    paneA: 'file',
    fileTabs: [{ id: 'file', worktreePath: path, issueId, scope: { kind: 'worktree' } }],
    outboxSize: 0,
  }) as HeaderRows['window']
function header(pool: MobxPool): void {
  headerEntities(pool).apply([
    { kind: 'window', id: 'window', value: window('/shared/src/file') },
    ...['target', 'runner', 'ancestor'].flatMap((repoId, at) =>
      Array.from({ length: at + 1 }, (_, index) => ({
        kind: 'shipOrder' as const,
        id: `${repoId}-${index}`,
        value: {
          id: `${repoId}-${index}`,
          repoId,
          humanState: repoId === 'runner' ? 'waiting' : 'needs_you',
        } as HeaderRows['shipOrder'],
      })),
    ),
  ])
}
const counts = (unfinishedCount: number, decisionCount: number) => ({
  unfinishedCount,
  decisionCount,
})

it('bounds shipping fallback demand and updates with 1x/4x histories on the same path', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
    const target = issue('target', 1, '/shared/src'),
      runner = issue('runner', 2, '/shared/src')
    pool.apply({
      type: 'replace',
      rows: [
        target,
        runner,
        issue('ancestor', 0, '/shared'),
        issue('archived', 0, '/shared/src/file', { archived: true }),
        issue('deleted', 0, '/shared/src/file', { deletedAt: stamp }),
        ...Array.from({ length: 128 * scale }, (_, at) =>
          issue(`history-${at}`, 100 + at, '/shared/src'),
        ),
        ...Array.from({ length: 128 * scale }, (_, at) =>
          issue(`other-${at}`, 100 + at, `/elsewhere/${at}`),
        ),
      ],
    })
    header(pool)
    let value = counts(0, 0),
      paints = 0,
      stop = () => {}
    const ids = vi.spyOn(pool.queries, 'ids')
    const row = vi.spyOn(pool, 'row')
    const measure = (name: string, action: () => void) =>
      measureWork(async () => insideReader(name, () => runInAction(action)), { pool })
    const update = (record: RowRecord) => pool.apply({ type: 'update', rows: [record] })
    try {
      const first = await measure('shipping fallback first demand', () => {
        stop = autorun(() => {
          value = headerView(pool).shipping()
          paints++
        })
      })
      expect(value).toEqual(counts(1, 1))
      expect(
        row.mock.calls.filter(([entity, , mode]) => entity === 'issue' && mode === 'summary'),
      ).toEqual([['issue', 'target', 'summary']])
      const repeated = await measure('shipping fallback repeat', () => {
        expect(headerView(pool).shipping()).toEqual(counts(1, 1))
      })
      const before = paints
      const unrelated = await measure('unrelated issue title', () =>
        update(issue('other-0', 100, '/elsewhere/0', { title: 'Changed' })),
      )
      expect(paints).toBe(before)
      const peer = await measure('same path history title', () =>
        update(issue('history-0', 100, '/shared/src', { title: 'Changed' })),
      )
      expect(paints).toBe(before)
      const peerArchived = await measure('same path history archive', () =>
        update(issue('history-0', 100, '/shared/src', { archived: true })),
      )
      expect(paints).toBe(before)
      const repo = await measure('winner repository changes', () =>
        update(issue('target', 1, '/shared/src', { repoId: 'ancestor' })),
      )
      expect(value).toEqual(counts(3, 3))
      const rank = await measure('winner sequence changes', () =>
        update(issue('target', 3, '/shared/src')),
      )
      expect(value).toEqual(counts(2, 0))
      const restored = await measure('winner restored', () => update(target))
      expect(value).toEqual(counts(1, 1))
      const moved = await measure('winner path moves', () => update(issue('target', 1, '/moved')))
      expect(value).toEqual(counts(2, 0))
      const returned = await measure('winner path returns', () => update(target))
      expect(value).toEqual(counts(1, 1))
      const archived = await measure('winner archived', () =>
        update(issue('target', 1, '/shared/src', { archived: true })),
      )
      expect(value).toEqual(counts(2, 0))
      const readmitted = await measure('winner readmitted', () => update(target))
      expect(value).toEqual(counts(1, 1))
      const deleted = await measure('winner deleted', () =>
        update({ kind: 'issue', id: 'target', value: undefined }),
      )
      expect(value).toEqual(counts(2, 0))
      const boundary = await measure('non-containing sibling path', () =>
        headerEntities(pool).apply([
          { kind: 'window', id: 'window', value: window('/shared-sibling/file') },
        ]),
      )
      expect(value).toEqual(counts(0, 0))
      const explicit = await measure('explicit issue beats path fallback', () =>
        headerEntities(pool).apply([
          { kind: 'window', id: 'window', value: window('/shared/src/file', 'ancestor') },
        ]),
      )
      expect(value).toEqual(counts(3, 3))
      expect(ids.mock.calls.some(([question]) => question.kind === 'containingIssues')).toBe(false)
      stop()
      const closedPaints = paints
      const closed = await measure('closed shipping fallback update', () => update(target))
      expect(paints).toBe(closedPaints)
      row.mockClear()
      const control = await measure('planted previous shipping fallback', () => {
        let best: { id: string; seq: number; worktreePath: string } | undefined
        for (const id of pool.queries.ids({ kind: 'containingIssues', cwd: '/shared/src/file' })) {
          const candidate = omitGone(pool.row('issue', id, 'summary')) as
            | {
                id: string
                seq: number
                worktreePath: string
                archived?: boolean
                deletedAt?: string
              }
            | typeof LOADING
            | undefined
          if (
            !candidate ||
            candidate === LOADING ||
            candidate.archived ||
            candidate.deletedAt ||
            !candidate.worktreePath ||
            !(
              '/shared/src/file' === candidate.worktreePath ||
              '/shared/src/file'.startsWith(
                candidate.worktreePath.endsWith('/')
                  ? candidate.worktreePath
                  : `${candidate.worktreePath}/`,
              )
            )
          )
            continue
          if (
            !best ||
            candidate.worktreePath.length > best.worktreePath.length ||
            (candidate.worktreePath === best.worktreePath && candidate.seq < best.seq)
          )
            best = candidate
        }
        expect(best?.id).toBe('target')
      })
      const controlSummaries = row.mock.calls.filter(
        ([entity, , mode]) => entity === 'issue' && mode === 'summary',
      ).length
      samples.push({
        scale,
        actions: {
          first,
          repeated,
          unrelated,
          peer,
          peerArchived,
          repo,
          rank,
          restored,
          moved,
          returned,
          archived,
          readmitted,
          deleted,
          boundary,
          explicit,
          closed,
        },
        control,
        controlSummaries,
      })
    } finally {
      stop()
      ids.mockRestore()
      row.mockRestore()
      pool.dispose()
    }
  }
  console.info('[shipping fallback work1x4x]', JSON.stringify(samples))
  for (const action of Object.keys(
    samples[0]!.actions,
  ) as (keyof (typeof samples)[number]['actions'])[])
    for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(samples[1]!.actions[action].work[counter], `${action}:${counter}`).toBe(
        samples[0]!.actions[action].work[counter],
      )
  expect(samples[1]!.controlSummaries).toBeGreaterThan(samples[0]!.controlSummaries)
  expect(samples[1]!.control.work.rows).toBeGreaterThan(samples[0]!.control.work.rows ?? 0)
  expect(samples[1]!.control.work.elements).toBeGreaterThan(samples[0]!.control.work.elements)
})

it('uses cold containing-issue facts and follows addressed eligibility and replacement updates', () => {
  let source = createColdIndex(SCHEMA, {
    issue: [...HIDDEN_ISSUE_FIELDS, ...HEADER_ISSUE_SUMMARY_FIELDS, 'readAt'],
  })
  const target = issue('target', 1, '/shared/src', { stage: 'done', closedAt: stamp }),
    runner = issue('runner', 2, '/shared/src', { stage: 'done', closedAt: stamp })
  source.apply({ type: 'replace', rows: [target, runner] })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    header: true,
    cold: () => source,
    load: () => undefined,
    schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows: [] })
  header(pool)
  const ids = vi.spyOn(pool.queries, 'ids')
  const seen: ReturnType<typeof counts>[] = []
  const stop = autorun(() => seen.push(headerView(pool).shipping()))
  const publish = (event: RowSourceEvent) => {
    source.apply(event)
    pool.apply(event)
  }
  try {
    expect(seen.at(-1)).toEqual(counts(1, 1))
    expect(pool.tables.issue.has('target')).toBe(false)
    publish({
      type: 'update',
      rows: [
        issue('target', 1, '/shared/src', {
          stage: 'done',
          closedAt: stamp,
          repoId: 'ancestor',
        }),
      ],
    })
    expect(seen.at(-1)).toEqual(counts(3, 3))
    publish({ type: 'update', rows: [issue('target', 1, '/shared/src', { archived: true })] })
    expect(seen.at(-1)).toEqual(counts(2, 0))
    publish({ type: 'update', rows: [issue('runner', 2, '/shared/src', { deletedAt: stamp })] })
    expect(seen.at(-1)).toEqual(counts(0, 0))
    // Replace the source instance as the real feed does after reset.
    source = createColdIndex(SCHEMA, {
      issue: [...HIDDEN_ISSUE_FIELDS, ...HEADER_ISSUE_SUMMARY_FIELDS, 'readAt'],
    })
    const rows = [issue('ancestor', 0, '/shared', { stage: 'done', closedAt: stamp })]
    source.apply({ type: 'replace', rows })
    pool.apply({ type: 'replace', rows })
    expect(seen.at(-1)).toEqual(counts(3, 3))
    expect(ids.mock.calls.some(([question]) => question.kind === 'containingIssues')).toBe(false)
  } finally {
    stop()
    ids.mockRestore()
    pool.dispose()
  }
})
