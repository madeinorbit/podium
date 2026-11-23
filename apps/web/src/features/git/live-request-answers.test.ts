import { AnswerRefresh } from '@podium/client-graph/answer-refresh'
import { expect, it, vi } from 'vitest'
import { FileTreeView } from '../files/file-tree-view'
import { DiffView } from './diff-view'

const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve()
}
it('an open tree refreshes expanded listings and search after checkout changes, then stops on close', async () => {
  let changed!: () => void
  const stop = vi.fn()
  const listDir = vi.fn(async ({ path }: { path?: string }) => ({
    ok: true,
    path: path ?? '/repo',
    entries: [{ name: 'new.ts', isDir: false }],
  }))
  const search = vi.fn(async () => ({ paths: ['new.ts'] }))
  const view = new FileTreeView('/repo', undefined, {
    listDir,
    trpc: { files: { search: { query: search } } } as never,
    refreshSignal: (notify) => {
      changed = notify
      return stop
    },
  })
  view.open()
  await settle()
  view.toggleDir('/repo/src')
  await settle()
  await view.searchFiles('new')
  listDir.mockClear()
  search.mockClear()
  changed()
  await settle()
  expect(listDir.mock.calls.map(([input]) => input.path)).toEqual(['/repo', '/repo/src'])
  expect(view.expanded.has('/repo/src')).toBe(true)
  expect(search).toHaveBeenCalledTimes(1)
  view.close()
  changed()
  await settle()
  expect(stop).toHaveBeenCalledTimes(1)
  expect(listDir).toHaveBeenCalledTimes(2)
})
it('a selected diff refetches on checkout changes; commit diffs are immutable while open', async () => {
  let changed!: () => void
  const stop = vi.fn()
  const ports = {
    gitDiffFile: vi.fn(async () => ({
      ok: true,
      output: 'diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n',
    })),
    gitCommitDiffFile: vi.fn(async () => ({ ok: true, output: '' })),
    readFileScoped: vi.fn(),
    refreshSignal: (notify: () => void) => {
      changed = notify
      return stop
    },
  }
  const entry = { path: 'file', x: ' ', y: 'M', untracked: false }
  const view = new DiffView('/repo', undefined, ports)
  view.open()
  await settle()
  await view.load(entry)
  changed()
  await settle()
  expect(ports.gitDiffFile).toHaveBeenCalledTimes(2)
  expect(view.totals).toEqual({ settled: 1, added: 1, removed: 1 })
  view.close()
  expect(stop).toHaveBeenCalledTimes(1)
  const commit = new DiffView('/repo', undefined, ports, undefined, 'sha')
  commit.open()
  await commit.load(entry)
  expect(ports.gitCommitDiffFile).toHaveBeenCalledTimes(1)
  expect(stop).toHaveBeenCalledTimes(1)
  commit.close()
})
it('the spec list is fetched again after its checkout signal and no timer is needed', async () => {
  let write!: () => void
  let specs = ['SP-one']
  const list = vi.fn(async () => specs)
  let answer: string[] = []
  const owner = new AnswerRefresh(
    async () => {
      answer = await list()
    },
    (changed) => {
      write = changed
      return () => {}
    },
  )
  owner.open()
  await settle()
  specs = ['SP-one', 'SP-two']
  write()
  await settle()
  expect(answer).toEqual(['SP-one', 'SP-two'])
  expect(list).toHaveBeenCalledTimes(2)
  owner.close()
})
