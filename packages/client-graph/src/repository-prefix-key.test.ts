import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../worklist-proto/harness/src/work-meter'
import { MobxPool } from './pool'
import type { RowRecord } from './shared/source'

const repo = (id: string, prefix: string | undefined, patch: object = {}): RowRecord =>
  ({
    kind: 'worktree',
    id,
    value: { prefix, ...patch },
  }) as RowRecord
const lane = (id: string, prefix: string): RowRecord =>
  repo(id, prefix, {
    path: id,
    repoId: 'held',
    repoPath: '/held',
    repoName: 'Held',
  })

it('maintains sorted unique registered prefixes without requiring an issue', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const publish = (rows: RowRecord[]) => pool.apply({ type: 'update', rows })
  const seen: string[] = []
  const stop = autorun(() => {
    seen.push(pool.queries.repositoryPrefixKey())
  })
  try {
    expect(seen).toEqual([''])
    pool.apply({
      type: 'replace',
      rows: [repo('z', 'Z'), repo('a', 'APP'), repo('other-a', 'APP'), repo('empty', '')],
    })
    expect(seen.at(-1)).toBe('APP,Z')
    const beforeMetadata = seen.length
    publish([repo('z', 'Z', { repoName: 'Renamed' }), repo('other-a', 'APP', { branch: 'new' })])
    expect(seen).toHaveLength(beforeMetadata)
    publish([{ kind: 'worktree', id: 'a', value: undefined }])
    expect(seen).toHaveLength(beforeMetadata)
    publish([repo('other-a', 'NEW')])
    expect(seen.at(-1)).toBe('NEW,Z')
    publish([repo('z', undefined)])
    expect(seen.at(-1)).toBe('NEW')
    publish([repo('other-a', '')])
    expect(seen.at(-1)).toBe('')
    publish([lane('/held/a', 'POD'), lane('/held/b', 'ALT')])
    expect(seen.at(-1)).toBe('ALT')
    publish([{ kind: 'worktree', id: '/held/b', value: undefined }])
    expect(seen.at(-1)).toBe('POD')
    publish([{ kind: 'worktree', id: '/held/a', value: undefined }])
    expect(seen.at(-1)).toBe('')
    pool.apply({ type: 'replace', rows: [repo('replacement', 'REPLACED')] })
    expect(seen.at(-1)).toBe('REPLACED')
    runInAction(() => pool.tables.repo.set('local', { prefix: 'LOCAL' } as never))
    expect(seen.at(-1)).toBe('LOCAL,REPLACED')
    runInAction(() => pool.tables.repo.set('local', { prefix: 'EDITED' } as never))
    expect(seen.at(-1)).toBe('EDITED,REPLACED')
    runInAction(() => pool.tables.repo.delete('local'))
    expect(seen.at(-1)).toBe('REPLACED')
  } finally {
    stop()
    pool.dispose()
  }
})

it('reads no repo catalog at first demand and bounds update row reads and derivations at 1x/4x', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    pool.apply({
      type: 'replace',
      rows: Array.from({ length: 128 * scale }, (_, n) => repo(`r${n}`, `PREFIX${n}`)),
    })
    const ids = vi.spyOn(pool.queries, 'ids'),
      keys = vi.spyOn(pool.tables.repo, 'keys')
    let value = '',
      runs = 0,
      stop: (() => void) | undefined
    try {
      const first = await measureWork(
        async () =>
          insideReader('registered prefix key', () => {
            value = pool.queries.repositoryPrefixKey()
          }),
        { pool },
      )
      expect(value.split(',')).toHaveLength(128 * scale)
      stop = autorun(() => {
        runs++
        value = pool.queries.repositoryPrefixKey()
      })
      const metadata = await measureWork(
        async () => {
          pool.apply({ type: 'update', rows: [repo('r0', 'PREFIX0', { repoName: 'Changed' })] })
        },
        { pool },
      )
      expect(runs).toBe(1)
      const rename = await measureWork(
        async () => {
          pool.apply({ type: 'update', rows: [repo('r0', 'RENAMED')] })
        },
        { pool },
      )
      expect(runs).toBe(2)
      expect(value.split(',')).toContain('RENAMED')
      expect(value.split(',')).not.toContain('PREFIX0')
      expect(ids).not.toHaveBeenCalled()
      expect(keys).not.toHaveBeenCalled()
      expect(first.work.rows).toBe(0)
      expect(first.work.elements).toBe(0)
      const legacy = await measureWork(
        async () =>
          insideReader('planted old prefix catalog', () => {
            const prefixes = new Set<string>()
            for (const id of pool.tables.repo.keys()) {
              const row = pool.row('repo', id) as { prefix?: string } | undefined
              if (row?.prefix) prefixes.add(row.prefix)
            }
            expect([...prefixes].sort().join(',')).toBe(value)
          }),
        { pool },
      )
      expect(legacy.work.rows).toBe(128 * scale)
      // The changed prefix string is genuine aggregate output. Its length can
      // grow; the reader and mutation must not read that many repository rows.
      samples.push({
        first: first.work,
        metadata: metadata.work,
        rename: rename.work,
        legacy: legacy.work,
      })
    } finally {
      stop?.()
      ids.mockRestore()
      keys.mockRestore()
      pool.dispose()
    }
  }
  for (const action of ['first', 'metadata', 'rename'] as const)
    for (const counter of ['rows', 'derivations'] as const)
      expect(samples[1]![action][counter]).toBe(samples[0]![action][counter])
  console.info('[repository prefix key work1x4x]', JSON.stringify(samples))
})
