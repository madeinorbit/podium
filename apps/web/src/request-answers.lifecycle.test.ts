import { GitView } from '@podium/client-graph/git-view'
import { RequestAnswer } from '@podium/client-graph/request-answer'
import { describe, expect, it, vi } from 'vitest'
import { FileBrowserView } from './features/files/file-browser-view'
import { FileDocumentView } from './features/files/file-document-view'
import { FileTreeView } from './features/files/file-tree-view'
import { DiffView } from './features/git/diff-view'
import { ConversationSearchView } from './lib/conversation-search-view'
import { FileMentionView } from './lib/search-views'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
const notices = { success: vi.fn(), error: vi.fn() }

describe('request answer lifetime', () => {
  it('invalidates reads immediately when a debounce replaces or disables its query', async () => {
    const old = deferred<string[]>()
    const view = new RequestAnswer<string[]>()
    const loading = view.load(() => old.promise)
    view.prepare(true)
    old.resolve(['stale'])
    await loading
    expect(view.answer).toBeUndefined()
    expect(view.loading).toBe(true)
    view.close()
    expect([view.answer, view.loading, view.error]).toEqual([undefined, false, null])
  })
  it('drops stale and closed conversation answers while preserving each native result', async () => {
    const row = {
      id: 'native',
      machineId: 'm1' as never,
      agentKind: 'codex',
      providerId: 'codex',
      title: 'First',
    }
    const old = deferred<(typeof row)[]>()
    const view = new ConversationSearchView(() => old.promise)
    const request = view.search({ query: 'old', limit: 6 })
    view.close()
    old.resolve([row])
    await request
    expect(view.answer).toBeUndefined()
    expect(view.hits).toEqual([])
    const rows = [row, { ...row, machineId: 'm2' as never, title: 'Second' }]
    const live = new ConversationSearchView(async () => rows)
    await live.search({ limit: 6 })
    expect(live.answer).toBe(rows)
    expect(live.hits.map((hit) => hit.title)).toEqual(['First', 'Second'])
    live.close()
    expect(live.answer).toBeUndefined()
    expect(live.hits).toEqual([])
  })
  it('fences directory refresh, navigation and close without prefetching collapsed directories', async () => {
    type Listing = { ok: boolean; path: string; entries: { name: string; isDir: boolean }[] }
    const old = deferred<Listing>(),
      current = deferred<Listing>(),
      late = deferred<Listing>()
    let roots = 0
    const listDir = vi.fn((input: { path?: string }) => {
      if (input.path === '/repo/new') return late.promise
      roots++
      return roots === 1 ? old.promise : current.promise
    })
    const view = new FileTreeView('/repo', undefined, { listDir, trpc: {} as never })
    view.open()
    await vi.waitFor(() => expect(roots).toBe(1))
    view.refresh()
    // Refresh is serialized behind the in-flight read, with one trailing
    // request. Its invalidated answer must never paint in the new generation.
    expect(view.children).toEqual({})
    old.resolve({ ok: true, path: '/repo', entries: [{ name: 'old', isDir: false }] })
    await vi.waitFor(() => expect(roots).toBe(2))
    expect(view.children).toEqual({})
    current.resolve({ ok: true, path: '/repo', entries: [{ name: 'new', isDir: true }] })
    await vi.waitFor(() => expect(view.children['/repo']).toEqual([{ name: 'new', isDir: true }]))
    expect(view.children['/repo']).toEqual([{ name: 'new', isDir: true }])
    expect(listDir.mock.calls.every(([input]) => input.path === '/repo')).toBe(true)
    view.toggleDir('/repo/new')
    await vi.waitFor(() =>
      expect(listDir.mock.calls.some(([input]) => input.path === '/repo/new')).toBe(true),
    )
    view.close()
    late.resolve({ ok: true, path: '/repo/new', entries: [{ name: 'late', isDir: false }] })
    await late.promise
    await Promise.resolve()
    expect(view.children).toEqual({})
    expect(view.loadingDirs.size).toBe(0)
    const a = deferred<Listing>(),
      b = deferred<Listing>()
    listDir.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const browser = new FileBrowserView('/repo', undefined, listDir)
    const opening = browser.open(),
      navigation = browser.open('/repo/new')
    b.resolve({ ok: true, path: '/repo/new', entries: [] })
    await navigation
    a.resolve({ ok: true, path: '/repo', entries: [] })
    await opening
    expect(browser.path).toBe('/repo/new')
    browser.close()
    expect(browser.answer).toBeUndefined()
  })
  it('drops the document buffer and ignores late reads and saves after closing', async () => {
    const read = deferred<{ ok: boolean; content: string; baseHash: string }>()
    const write = deferred<{ ok: boolean; baseHash: string }>()
    const view = new FileDocumentView(
      { kind: 'worktree', root: '/repo' },
      'a.md',
      { readFileScoped: () => read.promise, writeFileScoped: () => write.promise },
      notices,
    )
    const opening = view.open()
    view.close()
    read.resolve({ ok: true, content: 'late', baseHash: 'hash' })
    await opening
    expect(view.content).toBe('')
    expect(view.answer).toBeUndefined()
    await view.open()
    view.setContent('edited')
    const saving = view.save()
    view.close()
    write.resolve({ ok: true, baseHash: 'saved' })
    await saving
    expect(view.content).toBe('')
    expect(view.saving).toBe(false)
    expect(view.saveFeedback).toBeNull()
    expect(notices.success).not.toHaveBeenCalled()
  })
  it('ignores old Git status, expanded files and selected diffs after refresh or closing', async () => {
    const a = deferred<{ ok: boolean; output: string }>(),
      b = deferred<{ ok: boolean; output: string }>(),
      files = deferred<{ ok: boolean; output: string }>(),
      diff = deferred<{ ok: boolean; output: string }>()
    const ports = {
      gitStatus: vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise),
      gitCommitFiles: () => files.promise,
      gitDiffFile: () => diff.promise,
      readFileScoped: async () => ({ ok: true, content: '' }),
    }
    const view = new GitView('/repo', undefined, ports)
    const old = view.refresh(),
      current = view.refresh()
    b.resolve({ ok: true, output: '## current\n M current.ts' })
    await current
    a.resolve({ ok: true, output: '## stale\n M stale.ts' })
    await old
    expect(view.status?.header.branch).toBe('current')
    const commit = view.loadCommit('sha'),
      reading = view.loadDiff({ x: ' ', y: 'M', path: 'current.ts', untracked: false })
    view.close()
    files.resolve({ ok: true, output: 'M\tlate.ts' })
    diff.resolve({ ok: true, output: '+late' })
    await commit
    await reading
    expect(view.inventory.answer).toBeUndefined()
    expect(view.commitFiles).toEqual({})
    expect(view.diffs).toEqual({})
    const late = deferred<{ ok: boolean; output: string }>()
    const sheet = new DiffView('/repo', undefined, {
      ...ports,
      gitDiffFile: () => late.promise,
      gitCommitDiffFile: () => late.promise,
    })
    const selected = sheet.load({ x: ' ', y: 'M', path: 'selected.ts', untracked: false })
    sheet.close()
    late.resolve({ ok: true, output: '+late' })
    await selected
    expect(sheet.states.size).toBe(0)
    expect(sheet.totals.settled).toBe(0)
  })
  it('records mention errors and releases paths when the menu closes', async () => {
    const result = deferred<{ paths: string[] }>()
    const view = new FileMentionView({
      files: { search: { query: () => result.promise } },
    } as never)
    const request = view.search({ root: '/repo', query: 'src', limit: 6 })
    result.reject(new Error('offline'))
    await request
    expect(view.error).toBe('offline')
    expect(view.options).toEqual([])
    view.close()
    expect(view.answer).toBeUndefined()
    expect(view.error).toBeNull()
  })
})
