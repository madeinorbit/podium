import { runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import { MobxPool } from './pool'
import { SHELL_SUMMARIES } from './shell-schema'
import { createColdIndex } from './shared/cold-index'
import { SCHEMA } from './shared/schema'
import type { RowRecord, RowSourceEvent } from './shared/source'
import { createTerminalReferences } from './terminal-references'

const stamp = '2020-01-01T00:00:00Z'
const issue = (id: string, seq = 1, patch: object = {}): RowRecord => ({ kind: 'issue', id, value: {
  id, seq, repoId: 'target-repo', title: id, description: '', stage: 'review', archived: true,
  audience: 'human', labels: [], deps: [], priority: 2, createdAt: stamp, updatedAt: stamp, ...patch,
} } as RowRecord)
const repo = (id = 'target-repo', prefix = 'POD'): RowRecord => ({ kind: 'worktree', id: `/${id}`, value: {
  path: `/${id}`, repoId: id, prefix, repoPath: `/${id}`, repoName: id,
} } as RowRecord)
function fixture(scale: 1 | 4 = 1, resident = false) {
  const rows = [repo(), issue('target'), issue('second', 2),
    ...Array.from({ length: 128 * scale }, (_, n) => repo(`foreign-repo-${n}`, `F${n}`)),
    ...Array.from({ length: 128 * scale }, (_, n) => issue(`foreign-${n}`, n + 10, { repoId: `foreign-repo-${n}` })),
  ]
  let source = createColdIndex(SCHEMA, SHELL_SUMMARIES)
  source.apply({ type: 'replace', rows })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse('2026-10-05') }, undefined, {
    cold: () => source, summaries: SHELL_SUMMARIES, worklist: 'demand', load: () => undefined, schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows })
  if (resident) runInAction(() => {
    for (const row of rows) if (row.kind === 'issue') pool.tables.issue.set(row.id, row.value as never)
  })
  return { pool,
    publish(event: RowSourceEvent) { source.apply(event); pool.apply(event) },
    replace(rows: RowRecord[], fresh: boolean) {
      if (fresh) source = createColdIndex(SCHEMA, SHELL_SUMMARIES)
      this.publish({ type: 'replace', rows })
    },
  }
}

it('preserves archived stages, excludes deleted destinations and resolves refs independently of raw IDs', () => {
  const f = fixture(), reader = createTerminalReferences(f.pool)
  try {
    f.publish({ type: 'update', rows: [issue('POD-1', 9), issue('deleted', 3, { deletedAt: stamp }), repo('empty', 'EMPTY'), issue('only-deleted', 1, { repoId: 'empty', deletedAt: stamp })] })
    expect(f.pool.queries.linkedIssueId('POD-1')).toBe('POD-1')
    expect(reader.issueId(' POD-01 ')).toBe('target')
    expect(reader.issueId('POD-1')).toBe('target')
    expect(reader.resolveStage('POD-1')).toBe('review')
    expect(reader.resolveStage('POD-3')).toBeNull()
    expect(reader.issueId('POD-3')).toBeUndefined()
    expect(reader.isKnownPrefix('EMPTY')).toBe(false)
    for (const token of ['POD-1-A', 'POD-DRAFT-1', '#1', 'bad', 'POD-404']) {
      expect(reader.resolveStage(token)).toBeNull()
      expect(reader.issueId(token)).toBeUndefined()
    }
  } finally { reader.dispose(); f.pool.dispose() }
})

it('observes only painted prefix presence across creation, deletion, rename and source replacement', () => {
  const f = fixture(), reader = createTerminalReferences(f.pool), paint = vi.fn()
  const stop = reader.subscribe(paint)
  function prefixPaint() {
    reader.beginPaint()
    const value = [reader.isKnownPrefix('NEW'), reader.isKnownPrefix('POD')]
    reader.endPaint()
    return value
  }
  try {
    expect(prefixPaint()).toEqual([false, true])
    f.publish({ type: 'update', rows: [repo('new-repo', 'NEW'), issue('new-issue', 1, { repoId: 'new-repo' })] })
    expect(paint).toHaveBeenCalledTimes(1)
    expect(prefixPaint()).toEqual([true, true]); paint.mockClear()
    f.publish({ type: 'update', rows: [issue('new-issue', 1, { repoId: 'new-repo', deletedAt: stamp })] })
    expect(paint).toHaveBeenCalledTimes(1)
    expect(prefixPaint()).toEqual([false, true]); paint.mockClear()
    f.publish({ type: 'update', rows: [repo('target-repo', 'NEW')] })
    expect(prefixPaint()).toEqual([true, false]); paint.mockClear()
    for (const fresh of [false, true]) {
      f.replace([repo(), issue(`replacement-${fresh}`)], fresh)
      expect(prefixPaint()).toEqual([false, true])
      f.publish({ type: 'update', rows: [repo('target-repo', 'NEW')] })
      expect(prefixPaint()).toEqual([true, false])
    }
    reader.beginPaint(); reader.endPaint(); paint.mockClear()
    f.publish({ type: 'update', rows: [repo()] })
    expect(paint).not.toHaveBeenCalled()
  } finally { stop(); reader.dispose(); f.pool.dispose() }
})

it('keeps first paint, repaint, activation and updates flat at 1x/4x with cold and resident histories', async () => {
  async function measured(scale: 1 | 4, resident: boolean) {
    const f = fixture(scale, resident), row = vi.spyOn(f.pool, 'row')
    const references = vi.spyOn(f.pool, 'references', 'get'), ids = vi.spyOn(f.pool.queries, 'ids')
    const reader = createTerminalReferences(f.pool), paint = vi.fn(), stop = reader.subscribe(paint)
    expect(row).not.toHaveBeenCalled()
    function viewport(token: string | null) {
      reader.beginPaint()
      if (token !== null) {
        expect(reader.isKnownPrefix('POD')).toBe(true)
        expect(reader.resolveStage(token)).toBe('review')
      }
      reader.endPaint()
    }
    const measure = (name: string, action: () => void) => measureWork(async () => insideReader(name, action), { pool: f.pool })
    try {
      const firstPaint = await measure('terminal first paint', () => viewport('POD-1'))
      expect(row.mock.calls.every(([entity, id]) => entity === 'issue' && id === 'target')).toBe(true)
      row.mockClear()
      const repaint = await measure('terminal repaint', () => viewport('POD-1'))
      expect(row).not.toHaveBeenCalled()
      const activation = await measure('terminal activation', () => expect(reader.issueId('POD-1')).toBe('target'))
      const unrelated = await measure('terminal unrelated issue', () => f.publish({ type: 'update', rows: [issue('foreign-0', 10, { repoId: 'foreign-repo-0', title: 'Rename' })] }))
      expect(paint).not.toHaveBeenCalled()
      const target = await measure('terminal visible stage', () => f.publish({ type: 'update', rows: [issue('target', 1, { stage: 'done' })] }))
      expect(paint).toHaveBeenCalledTimes(1)
      viewport('POD-2'); paint.mockClear()
      const offscreen = await measure('terminal offscreen issue', () => f.publish({ type: 'update', rows: [issue('target')] }))
      expect(paint).not.toHaveBeenCalled()
      reader.setActive(false); paint.mockClear()
      const hidden = await measure('terminal hidden pane', () => {
        reader.beginPaint()
        expect(reader.isKnownPrefix('POD')).toBe(false)
        expect(reader.resolveStage('POD-2')).toBeNull()
        reader.endPaint()
        f.publish({ type: 'update', rows: [issue('second', 2, { stage: 'done' })] })
      })
      expect(paint).not.toHaveBeenCalled()
      reader.setActive(true); viewport(null); paint.mockClear()
      const empty = await measure('terminal empty viewport', () => f.publish({ type: 'update', rows: [issue('second', 2)] }))
      expect(paint).not.toHaveBeenCalled()
      reader.dispose(); row.mockClear()
      expect(reader.issueId('POD-1')).toBeUndefined()
      expect(reader.resolveStage('POD-1')).toBeNull()
      expect(reader.isKnownPrefix('POD')).toBe(false)
      expect(row).not.toHaveBeenCalled()
      expect(references).not.toHaveBeenCalled(); expect(ids).not.toHaveBeenCalled()
      return Object.fromEntries(Object.entries({ firstPaint, repaint, activation, unrelated, target, offscreen, hidden, empty }).map(([key, value]) => [key, value.work]))
    } finally { stop(); reader.dispose(); row.mockRestore(); references.mockRestore(); ids.mockRestore(); f.pool.dispose() }
  }
  for (const resident of [false, true]) {
    const first = await measured(1, resident), second = await measured(4, resident)
    console.info('terminal reference work1x4x', JSON.stringify({ resident, first, second }))
    for (const action of Object.keys(first)) for (const counter of ['rows', 'derivations', 'elements', 'visits'] as const)
      expect(second[action]?.[counter]).toBe(first[action]?.[counter])
  }
})
