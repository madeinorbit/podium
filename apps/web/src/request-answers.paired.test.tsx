import { DiffView } from './features/git/diff-view'
import { parseDiff as parseDesktopDiff } from './features/git/diff-model'
import { MergeQueueView } from './features/merge-queue/merge-queue-view'
import { queuePanelState } from './features/merge-queue/MergeQueuePanel'
import { readyMergeCandidates } from './features/merge-queue/merge-queue-model'
import { makeIssue } from './lib/test-issue'
import { MobxPool } from '@podium/client-graph'
import { GitView } from '@podium/client-graph/git-view'
import { RequestAnswer } from '@podium/client-graph/request-answer'
import { ConversationSearchView } from '@podium/client-graph/conversation-search'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useFileDocument } from './test-support/legacy-request-answers/useFileDocument'
import { FileDocumentView } from './features/files/file-document-view'
import { FileTreeView } from './features/files/file-tree-view'
import { FileBrowserView } from './features/files/file-browser-view'
import { NetworkSettingsView } from './features/settings/network-view'
import { ReceiptView } from './features/shipping/receipt-view'
import {
  parseStatus,
  parseLog,
  parseCommitFiles,
} from './test-support/legacy-request-answers/git-panel'
import {
  parseStatus as parsePhoneStatus,
  parseDiff,
  untrackedDiff,
} from './test-support/legacy-request-answers/git-review'
import { compareEntries } from './features/files/entry-order'
import { useConversationSearch } from './test-support/legacy-request-answers/useConversationSearch'
import { useFileMentions } from './test-support/legacy-request-answers/useFileMentions'
import { FileMentionView } from './lib/search-views'
import { fileMentions } from './lib/at-mention/mention-sources'

const f = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), search: vi.fn(), files: vi.fn() }))
const trpc = {
  conversations: { search: { query: f.search } },
  files: { search: { query: f.files } },
}
vi.mock('@podium/client-core/react', () => ({
  LOCK_POLL_MS: 5000,
  MERGE_LOCK_NAME: 'merge:main',
  HEAVY_TEST_LOCK_NAME: 'test:heavy',
  useStoreHandle: () => ({ access: { readFileScoped: f.read, writeFileScoped: f.write } }),
}))
vi.mock('@/app/store', () => ({
  useRuntimeSelector: (read: (s: unknown) => unknown) => read({ trpc }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})
const notices = { success() {}, error() {} }
const readFixture = { ok: true, content: 'same file\n', baseHash: 'hash' }
const status =
  '## branch...origin/branch [ahead 2, behind 1]\n M src/a.ts\nR  old.ts -> new.ts\n?? notes.md\n'
const log = 'abc\tabcdef\t2026-10-09T10:00:00Z\tAda\tAnswer ownership\n'
const commits = 'M\tsrc/a.ts\nA\tnotes.md\n'
const diff = '@@ -1 +1 @@\n-old\n+new\n'

describe('legacy and view-owned answers on identical fixtures', () => {
  it('compares the old document hook with the new buffer and save answer', async () => {
    f.read.mockResolvedValue(readFixture)
    f.write.mockResolvedValue({ ok: true, baseHash: 'saved' })
    const old = renderHook(() => useFileDocument({ kind: 'worktree', root: '/repo' }, 'a.md'))
    const next = new FileDocumentView(
      { kind: 'worktree', root: '/repo' },
      'a.md',
      { readFileScoped: f.read, writeFileScoped: f.write },
      notices,
    )
    await next.open()
    await waitFor(() => expect(old.result.current.status).toBe('ready'))
    expect([next.status, next.content, next.baseHash, next.dirty]).toEqual([
      old.result.current.status,
      old.result.current.content,
      old.result.current.baseHash,
      old.result.current.dirty,
    ])
    act(() => old.result.current.setContent('edited'))
    next.setContent('edited')
    await act(async () => {
      await old.result.current.save()
      await next.save()
    })
    expect([next.content, next.baseHash, next.dirty, next.saveFeedback]).toEqual([
      old.result.current.content,
      old.result.current.baseHash,
      old.result.current.dirty,
      old.result.current.saveFeedback,
    ])
    next.close()
    expect(next.answer).toBeUndefined()
    expect(next.content).toBe('')
  })
  it('compares desktop and phone Git status, log, expanded commit files and per-file diffs', async () => {
    const ports = {
      gitStatus: async () => ({ ok: true, output: status }),
      gitLog: async () => ({ ok: true, output: log }),
      gitCommitFiles: async () => ({ ok: true, output: commits }),
      gitDiffFile: async () => ({ ok: true, output: diff }),
      readFileScoped: async () => ({ ok: true, content: 'new file' }),
    }
    const next = new GitView('/repo', undefined, ports)
    await next.refresh(true)
    expect(next.status).toEqual(parseStatus(status))
    expect(next.reviewStatus).toEqual(parsePhoneStatus(status))
    expect(next.log).toEqual(parseLog(log))
    await next.loadCommit('abcdef')
    expect(next.commitFiles.abcdef?.entries).toEqual(parseCommitFiles(commits))
    const tracked = next.reviewStatus!.entries.find((entry) => entry.path === 'src/a.ts')!
    await next.loadDiff(tracked)
    expect(next.diffs[tracked.path]?.answer?.parsed).toEqual(parseDiff(diff))
    await next.loadDiff({ x: '?', y: '?', path: 'notes.md', untracked: true })
    expect(next.diffs['notes.md']?.answer?.parsed).toEqual(parseDiff(untrackedDiff('new file')))
    const sheet = new DiffView('/repo', undefined, {
      ...ports,
      gitCommitDiffFile: async () => ({ ok: true, output: diff }),
    })
    await sheet.load(tracked)
    expect(sheet.states.get(tracked.path)?.parsed).toEqual(parseDesktopDiff(diff))
    sheet.close()
    expect(sheet.states.size).toBe(0)
    next.close()
    expect(next.inventory.answer).toBeUndefined()
    expect(next.commitFiles).toEqual({})
    expect(next.diffs).toEqual({})
  })
  it('compares directory answers with the old ordering and browser path', async () => {
    const fixture = {
      ok: true,
      path: '/repo',
      entries: [
        { name: 'img10', isDir: false },
        { name: 'src', isDir: true },
        { name: 'img2', isDir: false },
      ],
    }
    const listDir = vi.fn(async () => fixture)
    const next = new FileTreeView('/repo', undefined, { listDir, trpc: trpc as never })
    await next.load('/repo')
    expect(next.children['/repo']).toEqual([...fixture.entries].sort(compareEntries))
    expect(listDir).toHaveBeenCalledTimes(1)
    const browser = new FileBrowserView('/repo', undefined, listDir)
    await browser.open()
    expect(browser.entries).toEqual(next.children['/repo'])
    expect(browser.path).toBe(fixture.path)
    next.close()
    browser.close()
    expect(next.children).toEqual({})
    expect(browser.answer).toBeUndefined()
  })
  it('compares network and receipt payloads without making a receipt record', async () => {
    const info = { mode: 'client', serverUrl: 'https://server', publicUrl: null }
    const network = new NetworkSettingsView({
      setup: { info: { query: async () => info } },
    } as never)
    await network.refresh(true)
    expect(network.answer).toEqual(info)
    const proof = {
      id: 'receipt',
      orderId: 'order',
      approvedBaseSha: 'base',
      approvedHeadSha: 'head',
      resultCommitSha: 'result',
      testedIntegrationSha: 'tested',
      landedRefSha: 'landed',
      destinationSha: 'destination',
      destination: 'origin/main',
      validationProfileId: 'profile',
      validationResult: 'passed',
      completedAt: '2026-10-09T00:00:00Z',
    }
    const receipt = new ReceiptView('order' as never, { getReceipt: async () => proof } as never)
    await receipt.refresh()
    expect(receipt.answer).toEqual(proof)
    network.close()
    receipt.close()
    expect(network.answer).toBeUndefined()
    expect(receipt.answer).toBeUndefined()
  })
  it('compares the old lock projection and issue filter with pooled lazy candidates', async () => {
    const rows = [
      makeIssue({
        id: 'first',
        seq: 1,
        stage: 'done',
        repoPath: '/repo',
        sortKey: 'a',
        gitState: {
          branch: 'issue/one',
          shared: false,
          merged: false,
          ahead: 1,
          dirtyFiles: 0,
          updatedAt: '2026-10-09T00:00:00Z',
        },
        branch: 'issue/one',
      }),
      makeIssue({ id: 'other', seq: 2, stage: 'in_progress', repoPath: '/repo' }),
    ]
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const locks: never[] = []
    const scope = { repoPath: '/repo' }
    try {
      pool.apply({
        type: 'update',
        rows: rows.map((value) => ({ kind: 'issue' as const, id: value.id, value })),
      })
      const query = vi.fn(async () => locks)
      const view = new MergeQueueView(pool, scope, { lock: { status: { query } } } as never)
      view.setIssues(rows.map((row) => row.id))
      view.open()
      await waitFor(() => expect(view.answer).toEqual(locks))
      expect(view.state).toEqual(
        queuePanelState({
          loading: false,
          locks,
          refreshing: false,
          error: null,
          refreshedAt: 1,
          refresh() {},
        }),
      )
      expect(view.candidates.map((issue) => issue.id)).toEqual(
        readyMergeCandidates(rows, scope, null).map((issue) => issue.id),
      )
      expect(view.candidates[0]).toBe(pool.model('issue', rows[0]!.id))
      view.close()
      expect(view.answer).toBeUndefined()
      expect(view.candidates).toEqual([])
    } finally {
      pool.dispose()
    }
  })
  it('compares old debounced search/mention hooks with new answers and pooled records', async () => {
    const rows = [
      {
        id: 'native',
        machineId: 'machine',
        agentKind: 'codex',
        providerId: 'codex',
        title: 'Same conversation',
        updatedAt: '2026-10-09T00:00:00Z',
      },
    ]
    const paths = ['src/a.ts', 'src/b.ts']
    f.search.mockResolvedValue(rows)
    f.files.mockResolvedValue({ paths })
    const oldSearch = renderHook(() =>
      useConversationSearch({ query: 'same', limit: 6, debounceMs: 0 }),
    )
    const oldMentions = renderHook(() =>
      useFileMentions({ query: 'src', root: '/repo', debounceMs: 0 }),
    )
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    try {
      const search = new ConversationSearchView(pool, f.search)
      const mentions = new FileMentionView(trpc as never)
      await search.search({ query: 'same', limit: 6 })
      await mentions.search({ root: '/repo', query: 'src', limit: 6 })
      await waitFor(() => expect(oldSearch.result.current.hits).toHaveLength(1))
      await waitFor(() => expect(oldMentions.result.current).toHaveLength(2))
      expect(
        search.hits.map((hit) =>
          Object.fromEntries(Object.keys(rows[0]!).map((key) => [key, Reflect.get(hit, key)])),
        ),
      ).toEqual(oldSearch.result.current.hits)
      expect(mentions.options).toEqual(oldMentions.result.current)
      expect(mentions.options).toEqual(fileMentions(paths))
      expect(search.hits[0]).toBe(pool.model('conversation', search.answer![0]!))
      search.close()
      mentions.close()
      expect(search.hits).toEqual([])
      expect(mentions.answer).toBeUndefined()
    } finally {
      pool.dispose()
    }
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
it('fences stale success, stale failure and close, including null as a successful answer', async () => {
  const view = new RequestAnswer<string | null>()
  const old = deferred<string>(),
    current = deferred<string>()
  const a = view.load(() => old.promise),
    b = view.load(() => current.promise)
  current.resolve('current')
  await b
  old.reject(new Error('stale'))
  await a
  expect([view.answer, view.error, view.loading]).toEqual(['current', null, false])
  const late = deferred<string>()
  const c = view.load(() => late.promise)
  view.close()
  late.resolve('closed')
  await c
  expect([view.answer, view.error, view.loading]).toEqual([undefined, null, false])
  await view.load(async () => null)
  expect(view.answer).toBeNull()
})
