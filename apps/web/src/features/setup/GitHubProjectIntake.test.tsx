// @vitest-environment happy-dom
import { GITHUB_PROJECT_INTAKE_DRAFT_KEY } from '@podium/client-core/ui-state'
import { asMachineId } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Profiler, useRef, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubProjectIntake } from './GitHubProjectIntake'

const values = new Map<string, string>()
const uiState = {
  get: (key: string) => values.get(key) ?? null,
  set: vi.fn((key: string, value: string | null) => {
    if (value === null) values.delete(key)
    else values.set(key, value)
  }),
}
const githubList = vi.fn()
let publication = 0
const storeListeners = new Set<() => void>()
let storeSnapshot = {
  trpc: { repos: { githubList: { query: githubList } } },
  uiState,
  publication,
}

function useTestStoreSelector<T>(
  selector: (store: typeof storeSnapshot) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const equalityRef = useRef(isEqual)
  equalityRef.current = isEqual
  const cache = useRef<{ snapshot: typeof storeSnapshot; selected: T } | null>(null)

  return useSyncExternalStore(
    (listener) => {
      storeListeners.add(listener)
      return () => storeListeners.delete(listener)
    },
    () => {
      if (cache.current?.snapshot === storeSnapshot) return cache.current.selected
      const next = selectorRef.current(storeSnapshot)
      const selected =
        cache.current && equalityRef.current(cache.current.selected, next)
          ? cache.current.selected
          : next
      cache.current = { snapshot: storeSnapshot, selected }
      return selected
    },
  )
}

function publishUnchangedSelection(): void {
  publication++
  storeSnapshot = { ...storeSnapshot, publication }
  for (const listener of storeListeners) listener()
}

vi.mock('@/app/store', () => ({
  useStoreSelector: useTestStoreSelector,
}))

const machine = {
  id: asMachineId('laptop'),
  name: 'Laptop',
  online: true,
  inventory: { os: 'darwin' as const, arch: 'arm64' as const, agents: [], tools: [] },
}

afterEach(() => {
  cleanup()
  values.clear()
  vi.clearAllMocks()
  publication = 0
  storeSnapshot = {
    trpc: { repos: { githubList: { query: githubList } } },
    uiState,
    publication,
  }
})

describe('GitHub project intake', () => {
  it('does not rerender when a store publication leaves its selected fields unchanged', async () => {
    githubList.mockResolvedValue({ status: { state: 'ready', login: 'octocat' }, repositories: [] })
    let updates = 0
    render(
      <Profiler
        id="github-project-intake"
        onRender={(_id, phase) => {
          if (phase === 'update') updates++
        }}
      >
        <GitHubProjectIntake machine={machine} homePath="/Users/me" onClone={vi.fn()} />
      </Profiler>,
    )
    expect(await screen.findByText('Signed in as octocat')).toBeTruthy()
    const updatesBeforePublication = updates

    act(() => publishUnchangedSelection())

    expect(updates).toBe(updatesBeforePublication)
    expect(githubList).toHaveBeenCalledTimes(1)
  })

  it('keeps missing-CLI controls focusable and offers install plus check-again recovery', async () => {
    const missing = {
      ...machine,
      inventory: { ...machine.inventory, tools: [{ name: 'gh', installed: false }] },
    }
    render(<GitHubProjectIntake machine={missing} homePath="/Users/me" onClone={vi.fn()} />)

    expect(await screen.findByText('GitHub CLI is not installed')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Install GitHub CLI/ }).getAttribute('href')).toBe(
      'https://cli.github.com/',
    )
    expect(
      screen
        .getByRole('textbox', { name: 'Search GitHub repositories' })
        .getAttribute('aria-disabled'),
    ).toBe('true')
    expect(
      (screen.getByRole('button', { name: 'Choose a repository' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    githubList.mockResolvedValue({ status: { state: 'ready', login: 'octocat' }, repositories: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(githubList).toHaveBeenCalledWith({ machineId: 'laptop' })
    expect(await screen.findByText('Signed in as octocat')).toBeTruthy()
    expect(screen.queryByText('GitHub CLI is not installed')).toBeNull()
  })

  it('checks again when focus returns after GitHub CLI recovery', async () => {
    const missing = {
      ...machine,
      inventory: { ...machine.inventory, tools: [{ name: 'gh', installed: false }] },
    }
    render(<GitHubProjectIntake machine={missing} homePath="/Users/me" onClone={vi.fn()} />)

    expect(await screen.findByText('GitHub CLI is not installed')).toBeTruthy()
    githubList.mockResolvedValue({ status: { state: 'ready', login: 'octocat' }, repositories: [] })

    fireEvent.focus(window)

    await waitFor(() => expect(githubList).toHaveBeenCalledWith({ machineId: 'laptop' }))
    expect(await screen.findByText('Signed in as octocat')).toBeTruthy()
  })

  it('does not check again when a successful machine snapshot is refreshed', async () => {
    githubList
      .mockResolvedValueOnce({ status: { state: 'logged-out' }, repositories: [] })
      .mockResolvedValue({ status: { state: 'ready', login: 'octocat' }, repositories: [] })
    const view = render(
      <GitHubProjectIntake machine={machine} homePath="/Users/me" onClone={vi.fn()} />,
    )

    expect(await screen.findByText('Sign in to GitHub CLI')).toBeTruthy()
    fireEvent.focus(window)
    expect(await screen.findByText('Signed in as octocat')).toBeTruthy()
    expect(githubList).toHaveBeenCalledTimes(2)

    view.rerender(
      <GitHubProjectIntake
        machine={{ ...machine, inventory: { ...machine.inventory } }}
        homePath="/Users/me"
        onClone={vi.fn()}
      />,
    )

    expect(githubList).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Signed in as octocat')).toBeTruthy()
  })

  it('keeps a logged-out GitHub CLI recoverable without discarding the draft', async () => {
    values.set(
      GITHUB_PROJECT_INTAKE_DRAFT_KEY,
      JSON.stringify({ query: 'podium', repository: '', destination: '/Users/me/src/podium' }),
    )
    githubList.mockResolvedValue({ status: { state: 'logged-out' }, repositories: [] })
    render(<GitHubProjectIntake machine={machine} homePath="/Users/me" onClone={vi.fn()} />)

    expect(await screen.findByText('Sign in to GitHub CLI')).toBeTruthy()
    expect(screen.getByText('gh auth login')).toBeTruthy()
    expect(screen.getByText('Authorize GitHub first')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy sign-in command' })).toBeTruthy()
    expect(
      (screen.getByRole('textbox', { name: 'Search GitHub repositories' }) as HTMLInputElement)
        .value,
    ).toBe('podium')
    expect(uiState.set).not.toHaveBeenCalledWith(GITHUB_PROJECT_INTAKE_DRAFT_KEY, null)
  })

  it('restores search, selection, and destination drafts and clears them only after clone', async () => {
    values.set(
      GITHUB_PROJECT_INTAKE_DRAFT_KEY,
      JSON.stringify({
        query: 'hello',
        repository: 'octocat/hello-world',
        destination: '/Users/me/src/hello-world',
      }),
    )
    githubList.mockResolvedValue({
      status: { state: 'ready', login: 'octocat' },
      repositories: [
        {
          nameWithOwner: 'octocat/hello-world',
          description: 'Hello',
          isPrivate: false,
          url: 'https://github.com/octocat/hello-world',
          pushedAt: null,
        },
      ],
    })
    const onClone = vi.fn(async () => undefined)
    render(<GitHubProjectIntake machine={machine} homePath="/Users/me" onClone={onClone} />)

    expect(await screen.findByText('octocat/hello-world')).toBeTruthy()
    expect(
      (screen.getByRole('textbox', { name: 'Search GitHub repositories' }) as HTMLInputElement)
        .value,
    ).toBe('hello')
    expect((screen.getByLabelText('Where should Podium keep it?') as HTMLInputElement).value).toBe(
      '/Users/me/src/hello-world',
    )
    // The restored draft selects the row, so cloning is the second step rather
    // than a per-row "Use <repo>" button.
    expect(
      screen
        .getByRole('button', { name: 'octocat/hello-world Hello' })
        .getAttribute('aria-pressed'),
    ).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /Clone repository/ }))

    await waitFor(() =>
      expect(onClone).toHaveBeenCalledWith('octocat/hello-world', '/Users/me/src/hello-world'),
    )
    expect(uiState.set).toHaveBeenLastCalledWith(GITHUB_PROJECT_INTAKE_DRAFT_KEY, null)
  })
})
