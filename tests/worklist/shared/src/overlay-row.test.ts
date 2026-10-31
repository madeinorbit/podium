import { overlayRow } from '@podium/client-graph/shared/overlay-row'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import { expect, it } from 'vitest'
import type { RowSource } from './arm'
import { createReadFence } from './instrument/reads'

it('borrows unchanged values, overlays an explicit null and enumerates a read-only record', () => {
  const row: Readonly<{
    id: string
    title: string
    readAt: string | null
    gitState: { ahead: number }
    sessionFacts: { replicaActivityAt: string }
  }> = Object.freeze({
    id: 'issue',
    title: 'Original',
    readAt: 'old',
    gitState: { ahead: 2 },
    sessionFacts: { replicaActivityAt: 'internal' },
  })
  const value = overlayRow(row, { title: 'Pending', readAt: null }, new Set(['sessionFacts']))
  expect({ ...value }).toEqual({
    id: 'issue',
    title: 'Pending',
    readAt: null,
    gitState: row.gitState,
  })
  expect(JSON.parse(JSON.stringify(value))).toEqual({
    id: 'issue',
    title: 'Pending',
    readAt: null,
    gitState: { ahead: 2 },
  })
  expect(value.gitState).toBe(row.gitState)
  expect('sessionFacts' in value).toBe(false)
  expect(Object.isFrozen(value)).toBe(true)
  expect(Reflect.set(value, 'title', 'Mutation')).toBe(false)
  expect(Reflect.deleteProperty(value, 'title')).toBe(false)
  expect(() => Object.defineProperty(value, 'title', { value: 'Mutation' })).toThrow(TypeError)
  expect(row.title).toBe('Original')
})

it('the copy fence rejects frozen full-record overlays as well as spread copies', () => {
  const row = {
    id: 'issue',
    seq: 42,
    title: 'Title',
    stage: 'planning',
    audience: 'human',
    repoPath: '/repo',
    branch: 'private',
    readAt: 'old',
    createdAt: '2026-09-30',
    updatedAt: '2026-09-30',
  } satisfies SliceIssue
  const source: RowSource = {
    snapshot: (kind) => (kind === 'issue' ? [{ kind, id: row.id, value: row }] : []),
    subscribe: () => () => {},
  }
  const fence = createReadFence({ enabled: true })
  const borrowed = fence.wrapSource(source).snapshot('issue')[0]!.value as typeof row
  const shown = overlayRow(borrowed, { readAt: 'new' })
  // overlayRow now freezes a shallow record. It is no longer a borrowed
  // proxy, so the fence must detect it just like an ordinary record copy.
  expect(() => fence.assertNoCopies({ shown, borrowed })).toThrow(/holds copies of fed rows/)
  expect(() => fence.assertNoCopies({ copied: { ...borrowed, readAt: 'new' }, borrowed })).toThrow(
    /holds copies of fed rows/,
  )
})
