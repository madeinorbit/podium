import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchView } from './SearchView'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})
beforeEach(() => {
  // Only fake setTimeout: the SearchView debounce is the one timer under test.
  // Faking the full clock (RAF/Date/interval) spins the Base UI Dialog's
  // animation frame loop forever under advanceTimersByTimeAsync.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

const omniQuery = vi.fn()
const convSearch = vi.fn()
const resumeMutate = vi.fn()
const setSelectedWorktree = vi.fn()
const setPane = vi.fn()
const setView = vi.fn()
const setSettingsTab = vi.fn()
const setOpenIssueId = vi.fn()

// One stable store object: useOmniSearch's effect depends on `trpc`, so a mock
// that rebuilt it per render would re-trigger the effect forever.
const store = {
  trpc: {
    search: { query: { query: omniQuery } },
    conversations: { search: { query: convSearch } },
    sessions: { resume: { mutate: resumeMutate } },
  },
  sessions: [{ sessionId: 'sess-1', cwd: '/repo/wt-a' }],
  setSelectedWorktree,
  setPane,
  setView,
  setSettingsTab,
  setOpenIssueId,
}
vi.mock('@/app/store', () => {
  const useStore = () => store
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})
vi.mock('@/lib/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))

function hit(over: Record<string, unknown>) {
  return { id: 'x', title: 'X', score: 1, ...over }
}

const input = () => screen.getByPlaceholderText(/^Search sessions/) as HTMLInputElement

async function type(value: string, settleMs = 260) {
  fireEvent.change(input(), { target: { value } })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(settleMs)
  })
}

describe('SearchView', () => {
  it('debounces as-you-type and skips queries under 2 chars', async () => {
    omniQuery.mockResolvedValue([])
    render(<SearchView onClose={vi.fn()} />)

    await type('s')
    expect(omniQuery).not.toHaveBeenCalled()

    fireEvent.change(input(), { target: { value: 'se' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100) // still inside the debounce window
    })
    fireEvent.change(input(), { target: { value: 'search' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(omniQuery).toHaveBeenCalledTimes(1)
    expect(omniQuery).toHaveBeenCalledWith({ text: 'search', limit: 50 })
  })

  it('renders results grouped by kind with section headers', async () => {
    omniQuery.mockResolvedValue([
      hit({ kind: 'transcript', id: 't1', title: 'Old chat', snippet: 'a **match** here' }),
      hit({ kind: 'session', id: 'sess-1', title: 'Fix login', sessionId: 'sess-1' }),
      hit({ kind: 'setting', id: 'keys', title: 'Settings › API keys', settingKey: 'keys' }),
      hit({ kind: 'issue', id: 'pod-1', title: 'Broken build' }),
      hit({ kind: 'conversation', id: 'c1', title: 'PWA work', nativeId: 'c1' }),
    ])
    render(<SearchView onClose={vi.fn()} />)
    await type('match')

    const headers = screen
      .getAllByText(/^(Sessions|Issues|Conversations|Transcripts|Settings)$/)
      .map((el) => el.textContent)
    expect(headers).toEqual(['Sessions', 'Issues', 'Conversations', 'Transcripts', 'Settings'])
    expect(screen.getByText('Fix login')).toBeTruthy()
    expect(screen.getByText('Broken build')).toBeTruthy()
  })

  it('builds highlight spans from ** markers without innerHTML', async () => {
    omniQuery.mockResolvedValue([
      hit({
        kind: 'transcript',
        id: 't1',
        title: 'T',
        snippet: 'before **hit** middle **hit2** after **dangling',
      }),
    ])
    const { container } = render(<SearchView onClose={vi.fn()} />)
    await type('hit')

    const marks = container.ownerDocument.querySelectorAll('mark')
    expect(Array.from(marks).map((m) => m.textContent)).toEqual(['hit', 'hit2'])
    // Markers are consumed, the unpaired tail stays plain text, no raw HTML.
    const snippetText = marks[0]!.parentElement!.textContent
    expect(snippetText).toBe('before hit middle hit2 after dangling')
    expect(snippetText).not.toContain('**')
  })

  it('session hit opens the session panel in its worktree', async () => {
    omniQuery.mockResolvedValue([
      hit({ kind: 'session', id: 'sess-1', title: 'Fix login', sessionId: 'sess-1' }),
    ])
    const onClose = vi.fn()
    render(<SearchView onClose={onClose} />)
    await type('login')

    fireEvent.click(screen.getByText('Fix login'))
    expect(setSelectedWorktree).toHaveBeenCalledWith('/repo/wt-a')
    expect(setPane).toHaveBeenCalledWith('A', 'sess-1')
    expect(setView).toHaveBeenCalledWith('workspace')
    expect(onClose).toHaveBeenCalled()
  })

  it('issue hit opens the issue detail', async () => {
    omniQuery.mockResolvedValue([hit({ kind: 'issue', id: 'pod-9', title: 'Broken build' })])
    const onClose = vi.fn()
    render(<SearchView onClose={onClose} />)
    await type('build')

    fireEvent.click(screen.getByText('Broken build'))
    expect(setOpenIssueId).toHaveBeenCalledWith('pod-9')
    expect(setView).toHaveBeenCalledWith('issues')
    expect(onClose).toHaveBeenCalled()
  })

  it('setting hit deep-links the settings tab', async () => {
    omniQuery.mockResolvedValue([
      hit({ kind: 'setting', id: 'keys', title: 'Settings › API keys', settingKey: 'keys' }),
    ])
    const onClose = vi.fn()
    render(<SearchView onClose={onClose} />)
    await type('keys')

    fireEvent.click(screen.getByText('Settings › API keys'))
    expect(setSettingsTab).toHaveBeenCalledWith('keys')
    expect(setView).toHaveBeenCalledWith('settings')
    expect(onClose).toHaveBeenCalled()
  })

  it('conversation hit resolves resume refs and resumes', async () => {
    omniQuery.mockResolvedValue([
      hit({ kind: 'conversation', id: 'c1', title: 'PWA work', nativeId: 'c1' }),
    ])
    convSearch.mockResolvedValue([
      {
        id: 'c1',
        title: 'PWA work',
        name: null,
        agentKind: 'claude-code',
        projectPath: '/repo/wt-b',
        resumeKind: 'claude',
        resumeValue: 'native-1',
      },
    ])
    resumeMutate.mockResolvedValue({ sessionId: 'sess-new' })
    const onClose = vi.fn()
    render(<SearchView onClose={onClose} />)
    await type('pwa')

    fireEvent.click(screen.getByText('PWA work'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(convSearch).toHaveBeenCalledWith({ query: 'pwa', limit: 50 })
    expect(resumeMutate).toHaveBeenCalledWith({
      agentKind: 'claude-code',
      cwd: '/repo/wt-b',
      resume: { kind: 'claude', value: 'native-1' },
      conversationId: 'c1',
      title: 'PWA work',
    })
    expect(setSelectedWorktree).toHaveBeenCalledWith('/repo/wt-b')
    expect(setPane).toHaveBeenCalledWith('A', 'sess-new')
    expect(onClose).toHaveBeenCalled()
  })

  it('transcript hit with a live sessionId opens the session directly', async () => {
    omniQuery.mockResolvedValue([
      hit({ kind: 'transcript', id: 't1', title: 'Old chat', sessionId: 'sess-1' }),
    ])
    const onClose = vi.fn()
    render(<SearchView onClose={onClose} />)
    await type('chat')

    fireEvent.click(screen.getByText('Old chat'))
    expect(setPane).toHaveBeenCalledWith('A', 'sess-1')
    expect(setView).toHaveBeenCalledWith('workspace')
    expect(onClose).toHaveBeenCalled()
  })

  it('transcript hit without a session falls back to its conversation', async () => {
    omniQuery.mockResolvedValue([
      hit({ kind: 'transcript', id: 't1', title: 'Old chat', podiumId: 'c9' }),
    ])
    convSearch.mockResolvedValue([
      {
        id: 'c9',
        title: 'Old chat',
        name: null,
        agentKind: 'codex',
        projectPath: '/repo/wt-c',
        resumeKind: 'codex',
        resumeValue: 'native-9',
      },
    ])
    resumeMutate.mockResolvedValue({ sessionId: 'sess-9' })
    render(<SearchView onClose={vi.fn()} />)
    await type('chat')

    fireEvent.click(screen.getByText('Old chat'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(resumeMutate).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo/wt-c', resume: { kind: 'codex', value: 'native-9' } }),
    )
    expect(setPane).toHaveBeenCalledWith('A', 'sess-9')
  })

  it('shows a quiet error line when the query fails', async () => {
    omniQuery.mockRejectedValue(new Error('boom'))
    render(<SearchView onClose={vi.fn()} />)
    await type('anything')

    expect(screen.getByText(/Search failed/)).toBeTruthy()
  })

  it('arrow keys + Enter navigate the flattened results', async () => {
    omniQuery.mockResolvedValue([
      hit({ kind: 'session', id: 'sess-1', title: 'Fix login', sessionId: 'sess-1' }),
      hit({ kind: 'issue', id: 'pod-9', title: 'Broken build' }),
    ])
    const onClose = vi.fn()
    render(<SearchView onClose={onClose} />)
    await type('b')
    await type('bui')

    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(screen.getByText('Broken build').closest('button')!.dataset.selected).toBe('true')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(setOpenIssueId).toHaveBeenCalledWith('pod-9')
    expect(setView).toHaveBeenCalledWith('issues')
    expect(onClose).toHaveBeenCalled()
  })
})
