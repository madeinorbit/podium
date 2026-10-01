import { expect, it } from 'vitest'
import { overlayRow } from '@podium/client-graph/shared/overlay-row'
import type { RowSource } from './arm'
import { createReadFence } from './instrument/reads'

it('borrows unchanged values, overlays an explicit null and enumerates a read-only record', () => {
  const row: Readonly<{ id: string; title: string; readAt: string | null; gitState: { ahead: number }; sessionFacts: { replicaActivityAt: string } }> =
    Object.freeze({ id: 'issue', title: 'Original', readAt: 'old', gitState: { ahead: 2 }, sessionFacts: { replicaActivityAt: 'internal' } })
  const value = overlayRow(row, { title: 'Pending', readAt: null }, new Set(['sessionFacts']))
  expect({ ...value }).toEqual({ id: 'issue', title: 'Pending', readAt: null, gitState: row.gitState })
  expect(JSON.parse(JSON.stringify(value))).toEqual({ id: 'issue', title: 'Pending', readAt: null, gitState: { ahead: 2 } })
  expect(value.gitState).toBe(row.gitState)
  expect('sessionFacts' in value).toBe(false)
  expect(() => Reflect.set(value, 'title', 'Mutation')).toThrow(/read-only/)
  expect(() => Reflect.deleteProperty(value, 'title')).toThrow(/read-only/)
  expect(() => Object.defineProperty(value, 'title', { value: 'Mutation' })).toThrow(/read-only/)
  expect(row.title).toBe('Original')
})

it('the unchanged copy fence accepts borrowed overlays and rejects full-record copies', () => {
  const row = { id: 'issue', seq: 42, title: 'Title', stage: 'planning', audience: 'human', repoPath: '/repo',
    branch: 'private', readAt: 'old', createdAt: '2026-09-30', updatedAt: '2026-09-30' }
  const source: RowSource = {
    snapshot: kind => kind === 'issue' ? [{ kind, id: row.id, value: row }] : [],
    subscribe: () => () => {},
  }
  const fence = createReadFence({ enabled: true })
  const borrowed = fence.wrapSource(source).snapshot('issue')[0]!.value as typeof row
  const shown = overlayRow(borrowed, { readAt: 'new' })
  expect(() => fence.assertNoCopies({ shown, borrowed })).not.toThrow()
  expect(() => fence.assertNoCopies({ copied: { ...borrowed, readAt: 'new' }, borrowed })).toThrow(/holds copies of fed rows/)
})
