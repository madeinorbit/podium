// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  asIssueId,
  asMachineId,
  asMutationId,
  asSessionId,
  type GitRepositoryWire,
  type SessionMeta,
} from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ColdStartComposer } from './ColdStartComposer'

const styles = readFileSync(resolve(import.meta.dirname, '../../styles.css'), 'utf8')

const create = vi.fn()
const start = vi.fn()
const focusIssueSession = vi.fn(async () => null)
const setPanelMode = vi.fn()
const setSelectedIssueId = vi.fn()
const setSelectedWorktree = vi.fn()
const setPane = vi.fn()
const setView = vi.fn()
const spawnIssueAgent = vi.fn((_args: Record<string, unknown>) => ({
  sessionId: asSessionId('optimistic-session'),
  issueId: asIssueId('optimistic-issue'),
  mutationId: asMutationId('optimistic-mutation'),
  settled: Promise.resolve(true),
  outcome: Promise.resolve<'started' | 'issue-only' | 'failed'>('started'),
}))
const uploadImage = vi.fn()
const uiValues = new Map<string, string>()
const uiListeners = new Set<() => void>()
const machineId = asMachineId('machine-a')
const initialRepo = {
  path: '/work/podium',
  name: 'podium',
  kind: 'repository' as const,
  branch: 'main',
  worktrees: [],
  machineId,
} as GitRepositoryWire

const store = {
  repos: [initialRepo],
  // No sessions, so `resolveDefaultAgent` falls through to the persisted
  // setting rather than to a most-recently-used harness.
  sessions: [] as SessionMeta[],
  machines: [
    {
      id: machineId,
      name: 'Studio Mac',
      hostname: 'studio',
      online: true,
      lastSeenAt: new Date(0).toISOString(),
      inventory: {
        os: 'darwin' as const,
        arch: 'arm64' as const,
        agents: [{ kind: 'codex' as const, installed: true, login: { state: 'in' as const } }],
        tools: [],
      },
    },
  ],
  // A REAL ui-state, subscription and all: the composer SUBSCRIBES to its draft
  // key rather than seeding it (POD-1469), so a mock that only stores would show
  // nothing the operator typed.
  uiState: {
    get: (key: string) => uiValues.get(key) ?? null,
    set: (key: string, value: string | null) => {
      if (value === null) uiValues.delete(key)
      else uiValues.set(key, value)
      for (const listener of uiListeners) listener()
    },
    subscribe: (listener: () => void) => {
      uiListeners.add(listener)
      return () => uiListeners.delete(listener)
    },
  },
  focusIssueSession,
  spawnIssueAgent,
  setPanelMode,
  setSelectedIssueId,
  setSelectedWorktree,
  setPane,
  setView,
  trpc: {
    settings: {
      get: {
        query: vi.fn(async () => ({
          sessionDefaults: { agent: 'codex' },
          gitWorkflow: { defaultParentBranch: 'main' },
        })),
      },
    },
    issues: { create: { mutate: create }, start: { mutate: start } },
    sessions: { uploadImage: { mutate: uploadImage } },
  },
}

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (value: typeof store) => unknown) => selector(store),
}))

vi.mock('@/lib/ModelEffortPicker', () => ({
  ModelPicker: ({ onChange }: { onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange('gpt-5.6-sol')}>
      Model
    </button>
  ),
  EffortPicker: ({ onChange }: { onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange('high')}>
      Effort
    </button>
  ),
}))

afterEach(() => {
  cleanup()
  uiValues.clear()
  store.repos.splice(0, store.repos.length, initialRepo)
  store.sessions.splice(0)
  store.machines.splice(1)
  create.mockReset()
  start.mockReset()
  focusIssueSession.mockReset()
  focusIssueSession.mockResolvedValue(null)
  setPanelMode.mockClear()
  setSelectedIssueId.mockClear()
  setSelectedWorktree.mockClear()
  setPane.mockClear()
  setView.mockClear()
  spawnIssueAgent.mockReset()
  spawnIssueAgent.mockReturnValue({
    sessionId: asSessionId('optimistic-session'),
    issueId: asIssueId('optimistic-issue'),
    mutationId: asMutationId('optimistic-mutation'),
    settled: Promise.resolve(true),
    outcome: Promise.resolve<'started' | 'issue-only' | 'failed'>('started'),
  })
  uploadImage.mockReset()
})

/** The hidden `<input type=file>` the paperclip clicks — it has no accessible
 *  name by design, so it is reached the way the button reaches it. */
function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type=file]')
  if (!input) throw new Error('the composer has no file input')
  return input as HTMLInputElement
}

function attach(file: File): void {
  Object.defineProperty(fileInput(), 'files', { value: [file], configurable: true })
  fireEvent.change(fileInput())
}

function recentSession(cwd: string): SessionMeta {
  return {
    sessionId: asSessionId('recent-session'),
    agentKind: 'claude-code',
    title: 'Recent session',
    cwd,
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-08-20T00:00:00.000Z',
    lastActiveAt: '2026-08-21T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    busy: false,
    readAt: null,
    unread: false,
  } as unknown as SessionMeta
}

/* The headline's accessible name is the SENTENCE, not the sentence with the
 * project button's own label spliced into it. Both assertions below used to
 * read `Give Project: podium its first mission` — the trigger's
 * `aria-label="Project: podium"` leaking into the h2's computed name — and both
 * were already failing on main before this issue touched the file: the name
 * computation now takes the button's content, so the heading reads the way it
 * looks. The button keeps its own label when it is the focused thing, which is
 * where "Project:" is worth saying. */
describe('ColdStartComposer', () => {
  it('uses the reusable first-run wording and production task path', async () => {
    render(<ColdStartComposer first />)

    expect(screen.getByRole('heading', { name: /Give podium its first mission/ })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('What do you want to work on?'), {
      target: { value: 'Ship the new onboarding\nKeep the empty state subtle.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(screen.getByRole('button', { name: 'Effort' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }))

    await waitFor(() =>
      expect(spawnIssueAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: expect.any(String),
          sessionId: expect.any(String),
          mutationId: expect.any(String),
          target: expect.objectContaining({
            path: '/work/podium',
            repoPath: '/work/podium',
            machineId: 'machine-a',
          }),
          title: 'Ship the new onboarding',
          description: 'Ship the new onboarding\nKeep the empty state subtle.',
          parentBranch: 'main',
          agentKind: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high',
        }),
      ),
    )
    expect(setPanelMode).toHaveBeenCalledWith(asSessionId('optimistic-session'), 'chat')
    expect(setPane).toHaveBeenCalledWith('A', asSessionId('optimistic-session'))
  })

  /* The local issue/session identities are the route: navigation must happen in
   * the same click as the optimistic paint, without waiting for the create-and-
   * start response or for replica truth to publish the session row. */
  it('persists the reserved identities before dispatching create', () => {
    spawnIssueAgent.mockImplementationOnce((input) => {
      const saved = JSON.parse(uiValues.get('podium.firstTaskActivation.draft') ?? '{}') as Record<
        string,
        unknown
      >
      expect(saved.createIssueId).toBe(input.issueId)
      expect(saved.createSessionId).toBe(input.sessionId)
      expect(saved.createMutationId).toBe(input.mutationId)
      expect(saved.title).toBe('Crash-safe launch')
      return {
        issueId: asIssueId(String(input.issueId)),
        sessionId: asSessionId(String(input.sessionId)),
        mutationId: asMutationId(String(input.mutationId)),
        settled: new Promise<boolean>(() => {}),
        outcome: new Promise<'started' | 'issue-only' | 'failed'>(() => {}),
      }
    })
    render(<ColdStartComposer first={false} />)

    fireEvent.change(screen.getByLabelText('What do you want to work on?'), {
      target: { value: 'Crash-safe launch' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }))

    expect(spawnIssueAgent).toHaveBeenCalledTimes(1)
  })

  it('lands on the optimistic chat synchronously, without waiting for the server', () => {
    let settle: (outcome: 'started' | 'issue-only' | 'failed') => void = () => {}
    const outcome = new Promise<'started' | 'issue-only' | 'failed'>((resolve) => {
      settle = resolve
    })
    spawnIssueAgent.mockReturnValue({
      sessionId: asSessionId('instant-session'),
      issueId: asIssueId('instant-issue'),
      mutationId: asMutationId('instant-mutation'),
      settled: outcome.then((value) => value === 'started'),
      outcome,
    })
    render(<ColdStartComposer first={false} />)

    fireEvent.change(screen.getByLabelText('What do you want to work on?'), {
      target: { value: 'Ship the new onboarding' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }))

    expect(setSelectedIssueId).toHaveBeenCalledWith(asIssueId('instant-issue'))
    expect(setPanelMode).toHaveBeenCalledWith(asSessionId('instant-session'), 'chat')
    expect(setPane).toHaveBeenCalledWith('A', asSessionId('instant-session'))
    expect(setView).toHaveBeenCalledWith('workspace')
    expect(focusIssueSession).not.toHaveBeenCalled()
    expect(uiValues.has('podium.firstTaskActivation.draft')).toBe(true)
    settle('started')
  })

  it('keeps the written prompt available when the optimistic task is rejected', async () => {
    spawnIssueAgent.mockImplementation((input) => {
      return {
        issueId: asIssueId(String(input.issueId)),
        sessionId: asSessionId(String(input.sessionId)),
        mutationId: asMutationId(String(input.mutationId)),
        settled: Promise.resolve(false),
        outcome: Promise.resolve('failed'),
      }
    })
    render(<ColdStartComposer first={false} />)

    fireEvent.change(screen.getByLabelText('What do you want to work on?'), {
      target: { value: 'Do not lose this request' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }))

    await waitFor(() => expect(screen.getByText(/Couldn't start the task/)).toBeTruthy())
    const saved = uiValues.get('podium.firstTaskActivation.draft') ?? ''
    expect(saved).toContain('Do not lose this request')
    const firstInput = spawnIssueAgent.mock.calls[0]?.[0]
    if (!firstInput) throw new Error('launch was not dispatched')
    expect(saved).toContain(String(firstInput.issueId))
    expect(saved).toContain(String(firstInput.sessionId))
    expect(saved).toContain(String(firstInput.mutationId))

    cleanup()
    render(<ColdStartComposer first={false} />)
    expect(screen.getByText(/Couldn't start the task/)).toBeTruthy()
    expect(
      (screen.getByLabelText('What do you want to work on?') as HTMLTextAreaElement).value,
    ).toBe('Do not lose this request')
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }))
    expect(spawnIssueAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        issueId: firstInput.issueId,
        sessionId: firstInput.sessionId,
        mutationId: firstInput.mutationId,
        description: 'Do not lose this request',
      }),
    )
  })

  it('adopts a persisted launch error that arrives after the recovery composer mounts', async () => {
    const draft = {
      repoPath: '/work/podium',
      machineId: 'machine-a',
      agent: 'codex',
      model: 'auto',
      effort: 'auto',
      title: 'Keep the late failure visible',
      description: '',
      pendingIssueId: '',
      createIssueId: 'iss_late-failure',
      createSessionId: 'late-failure-session',
      createMutationId: 'late-failure-mutation',
      startMutationId: '',
      attachmentPaths: [],
      launchError: '',
    }
    uiValues.set('podium.firstTaskActivation.draft', JSON.stringify(draft))
    render(<ColdStartComposer first={false} />)

    store.uiState.set(
      'podium.firstTaskActivation.draft',
      JSON.stringify({ ...draft, launchError: "Couldn't start the task." }),
    )

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain("Couldn't start the task."),
    )
  })

  it('retries start on the saved issue when create committed before start failed', async () => {
    spawnIssueAgent.mockImplementationOnce((input) => {
      return {
        issueId: asIssueId(String(input.issueId)),
        sessionId: asSessionId(String(input.sessionId)),
        mutationId: asMutationId(String(input.mutationId)),
        settled: Promise.resolve(false),
        outcome: Promise.resolve('issue-only'),
      }
    })
    start.mockResolvedValue({ id: asIssueId('partial-issue') })
    render(<ColdStartComposer first={false} />)

    fireEvent.change(screen.getByLabelText('What do you want to work on?'), {
      target: { value: 'Keep the saved task' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }))
    await waitFor(() =>
      expect(screen.getByText(/task was saved, but its agent couldn't start/i)).toBeTruthy(),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Retry starting work' }))
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ id: spawnIssueAgent.mock.calls[0]?.[0].issueId }),
    )
    expect(spawnIssueAgent).toHaveBeenCalledTimes(1)
  })

  it('switches to reusable workspace wording when tasks already exist', () => {
    render(<ColdStartComposer first={false} />)
    expect(
      screen.getByRole('heading', { name: /What do you want to work on in podium/ }),
    ).toBeTruthy()
  })

  it('deduplicates multi-machine repos and selects and lists them by recent use', () => {
    const machineB = asMachineId('machine-b')
    store.repos.splice(
      0,
      store.repos.length,
      {
        path: '/work/alpha',
        name: 'alpha',
        kind: 'repository',
        branch: 'main',
        worktrees: [],
        machineId,
        originUrl: 'https://example.com/acme/alpha.git',
      } as GitRepositoryWire,
      {
        path: '/work/beta',
        name: 'beta',
        kind: 'repository',
        branch: 'main',
        worktrees: [],
        machineId,
        originUrl: 'https://example.com/acme/beta.git',
      } as GitRepositoryWire,
      {
        path: '/srv/beta',
        name: 'beta',
        kind: 'repository',
        branch: 'main',
        worktrees: [],
        machineId: machineB,
        originUrl: 'https://example.com/acme/beta.git',
      } as GitRepositoryWire,
    )
    store.machines.push({
      ...store.machines[0]!,
      id: machineB,
      name: 'Build host',
      hostname: 'builder',
    })
    store.sessions.push(recentSession('/srv/beta'))

    render(<ColdStartComposer first={false} />)

    const picker = screen.getByRole('button', { name: 'Project: beta' })
    fireEvent.click(picker)
    const repoItems = screen.getAllByRole('menuitem').map((item) => item.textContent?.trim())
    expect(repoItems).toEqual(['beta', 'alpha'])
  })

  /* POD-1582. `reposToViews` drops nothing by `kind`, but `checkoutForMachine`
   * refuses a `worktree` — so a linked worktree registered as its own root,
   * with no registered parent to nest it under, rendered as a project that
   * could never launch. The list and the resolver answer to one predicate now. */
  it('leaves out a project no launch could resolve to a checkout', () => {
    store.repos.splice(0, store.repos.length, initialRepo, {
      path: '/work/stray-worktree',
      name: 'stray',
      kind: 'worktree',
      branch: 'feature',
      worktrees: [],
      machineId,
      originUrl: 'https://example.com/acme/stray.git',
    } as GitRepositoryWire)

    render(<ColdStartComposer first={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Project: podium' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual([
      'podium',
    ])
  })

  /* POD-1582. Both dead ends reported `unavailable`, and the single message
   * sent this one to Settings → Agents, where nothing changes the outcome. The
   * agent is fine; there is no checkout on the machine that got selected — a
   * repo scanned without a machineId is the reachable way in, since the machine
   * list then falls back to every machine and none of them owns the path. */
  it('names the machine when the project has no checkout on it, not the agent setup', () => {
    const { machineId: _drop, ...homeless } = initialRepo
    store.repos.splice(0, store.repos.length, homeless as GitRepositoryWire)

    render(<ColdStartComposer first={false} />)

    expect(screen.queryByText(/Open Settings → Agents/)).toBeNull()
    expect(screen.getByText(/podium is not checked out on Studio Mac/)).toBeTruthy()
  })

  /* POD-1582. `selectedRepo` matches a draft whose repoPath is one of the
   * entry's machine-specific paths — that is how a draft written elsewhere
   * still finds its project. Reading that alias as a repo SWITCH wiped the
   * operator's model and effort on the first render after the draft loaded. */
  it('keeps model and effort when the draft names the project by an alias path', async () => {
    const machineB = asMachineId('machine-b')
    store.repos.splice(
      0,
      store.repos.length,
      {
        path: '/work/podium',
        name: 'podium',
        kind: 'repository',
        branch: 'main',
        worktrees: [],
        machineId,
        originUrl: 'https://example.com/acme/podium.git',
      } as GitRepositoryWire,
      {
        path: '/srv/podium',
        name: 'podium',
        kind: 'repository',
        branch: 'main',
        worktrees: [],
        machineId: machineB,
        originUrl: 'https://example.com/acme/podium.git',
      } as GitRepositoryWire,
    )
    const [primary] = store.machines as [(typeof store.machines)[number]]
    store.machines.push({ ...primary, id: machineB, name: 'Build host' })
    // The group's canonical path is /work/podium; this draft names the other one.
    uiValues.set(
      'podium.firstTaskActivation.draft',
      JSON.stringify({
        repoPath: '/srv/podium',
        machineId: machineB,
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        title: 'Ship it',
      }),
    )

    render(<ColdStartComposer first={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }))

    await waitFor(() => expect(spawnIssueAgent).toHaveBeenCalled())
    const input = spawnIssueAgent.mock.calls[0]?.[0]
    if (!input) throw new Error('launch was not dispatched')
    expect(input.model).toBe('gpt-5.6-sol')
    expect(input.effort).toBe('high')
    // …and the mission is created in the checkout the draft named, not in
    // whichever clone the scan happened to list first.
    expect(input.target).toEqual(expect.objectContaining({ repoPath: '/srv/podium' }))
  })

  /* POD-1169. The instrument strip clips its own contents (`overflow-hidden`)
   * to keep the three pickers in one groove, and that sets its automatic
   * minimum size to 0 — as a shrinkable flex item it SQUASHED instead of
   * wrapping, so a narrow pane lost the agent, model and effort controls
   * silently rather than moving them to a second line. `flex-none` is the fix
   * and it is invisible in a jsdom render, so assert it directly. */
  it('keeps the instrument strip unshrinkable, so a narrow pane wraps it whole', () => {
    render(<ColdStartComposer first={false} />)
    const strip = screen.getByRole('button', { name: 'Agent' }).parentElement
    expect(strip?.className).toContain('overflow-hidden')
    expect(strip?.className).toContain('flex-none')
  })

  /* POD-1184. The deck scrolls when a pane is too short for it, and a scroll
   * container that CENTERS its overflowing content pushes half the overrun out
   * of the start edge, where scrolling cannot reach it: at a 1200×260 window
   * the sentence sat 59px above the scroller's top, project picker and all.
   * `justify-center` is therefore forbidden here — the centring is the body's
   * own `margin-block: auto`, which resolves to zero the moment free space
   * runs out. Neither half shows up in a happy-dom render, so assert both. */
  it('centres the deck without putting its top out of scroll reach', () => {
    render(<ColdStartComposer first={false} />)
    // The scroller is the body's own parent. POD-1669 split it out of
    // `.cold-start`, which keeps the container query and now carries the pane's
    // drop veil — a veil inside the scroller would be laid out against the
    // SCROLLED content and ride away on exactly the short panes that scroll.
    const scroller = document.querySelector('.cold-start-body')?.parentElement
    expect(scroller).toBeTruthy()
    expect(scroller?.className).toContain('overflow-y-auto')
    expect(scroller?.className).not.toContain('justify-center')
    expect(document.querySelector('.cold-start')?.className).not.toContain('overflow-y-auto')
    expect(styles).toMatch(/\.cold-start-body\s*\{[^}]*margin-block:\s*auto/)
  })

  /* POD-1184. The headline is one SENTENCE with a control set into it, not a
   * flex row of three items: as a flex row the trailing mark was its own item
   * behind a 0.4em gap, and a narrow pane stranded it under the pill. Inline
   * flow puts it hard against the pill instead, joined by U+2060 so no line can
   * break between them. */
  it('keeps the sentence mark attached to the project pill', () => {
    render(<ColdStartComposer first={false} />)
    const heading = screen.getByRole('heading', { name: /What do you want to work on in podium/ })
    expect(heading.className).not.toContain('flex')
    expect(heading.textContent?.endsWith('⁠?')).toBe(true)
    expect(heading.lastElementChild?.className).toContain('cold-start-project')
  })

  /* POD-1203. The home box can be given a screenshot or a document, and the
   * whole point is that the agent receives it — a chip that only ever decorated
   * this screen would be worse than no affordance at all. */
  describe('attachments', () => {
    it('uploads to the SELECTED machine, because a path is only valid on one disk', async () => {
      uploadImage.mockResolvedValue({ path: '/home/a/.podium/uploads/scope/1.png' })
      render(<ColdStartComposer first />)

      attach(new File(['bytes'], 'shot.png', { type: 'image/png' }))

      await waitFor(() =>
        expect(uploadImage).toHaveBeenCalledWith(
          expect.objectContaining({
            filename: 'shot.png',
            mimeType: 'image/png',
            machineId: 'machine-a',
          }),
        ),
      )
      // The scope is a stand-in for a session that does not exist yet — it must
      // be SOMETHING (the uploads dir is named by it) and must not be a real
      // session id, which is why nothing here asserts a lookup.
      expect(uploadImage.mock.calls[0]?.[0].sessionId).toMatch(/^coldstart-/)
    })

    it('carries the uploaded path into the started mission, in the brief', async () => {
      uploadImage.mockResolvedValue({ path: '/home/a/.podium/uploads/scope/1.png' })
      render(<ColdStartComposer first />)

      fireEvent.change(screen.getByLabelText('What do you want to work on?'), {
        target: { value: 'Match this mock' },
      })
      attach(new File(['bytes'], 'mock.png', { type: 'image/png' }))
      await waitFor(() => expect(uploadImage).toHaveBeenCalled())
      fireEvent.click(screen.getByRole('button', { name: 'Start work' }))

      await waitFor(() => expect(spawnIssueAgent).toHaveBeenCalled())
      const input = spawnIssueAgent.mock.calls[0]?.[0]
      if (!input) throw new Error('launch was not dispatched')
      // The description stays the prose a human reads on the issue card…
      expect(input.description).toBe('Match this mock')
      expect(input.title).toBe('Match this mock')
      // …and the path rides in the brief, which the started session's first
      // prompt joins onto it ([spec:SP-6144]).
      expect(input.brief).toEqual(expect.stringContaining('/home/a/.podium/uploads/scope/1.png'))
    })

    it('keeps uploaded paths in an ambiguous launch retry', async () => {
      uploadImage.mockResolvedValue({ path: '/home/a/.podium/uploads/scope/retry.png' })
      spawnIssueAgent.mockReturnValue({
        sessionId: asSessionId('attachment-session'),
        issueId: asIssueId('attachment-issue'),
        mutationId: asMutationId('attachment-mutation'),
        settled: Promise.resolve(false),
        outcome: Promise.resolve('failed'),
      })
      render(<ColdStartComposer first />)

      fireEvent.change(screen.getByLabelText('What do you want to work on?'), {
        target: { value: 'Review the attachment' },
      })
      attach(new File(['bytes'], 'retry.png', { type: 'image/png' }))
      await waitFor(() => expect(uploadImage).toHaveBeenCalled())
      fireEvent.click(screen.getByRole('button', { name: 'Start work' }))
      await waitFor(() => expect(screen.getByText(/Couldn't start the task/)).toBeTruthy())

      expect(uiValues.get('podium.firstTaskActivation.draft')).toContain(
        '/home/a/.podium/uploads/scope/retry.png',
      )
      fireEvent.click(screen.getByRole('button', { name: 'Start work' }))
      expect(spawnIssueAgent.mock.calls[1]?.[0]?.brief).toEqual(
        expect.stringContaining('/home/a/.podium/uploads/scope/retry.png'),
      )
    })

    it('refuses to launch until the bytes have landed, so the brief cannot name a file in flight', async () => {
      let land: (result: { path: string }) => void = () => {}
      uploadImage.mockReturnValue(
        new Promise<{ path: string }>((resolve) => {
          land = resolve
        }),
      )
      render(<ColdStartComposer first />)

      fireEvent.change(screen.getByLabelText('What do you want to work on?'), {
        target: { value: 'Read this spec' },
      })
      attach(new File(['bytes'], 'spec.pdf', { type: 'application/pdf' }))

      const launch = () => screen.getByRole('button', { name: 'Start work' }) as HTMLButtonElement
      await waitFor(() => expect(launch().disabled).toBe(true))
      fireEvent.click(launch())
      expect(spawnIssueAgent).not.toHaveBeenCalled()

      land({ path: '/home/a/.podium/uploads/scope/1.pdf' })
      await waitFor(() => expect(launch().disabled).toBe(false))
    })

    it('takes a document, not only a screenshot', async () => {
      uploadImage.mockResolvedValue({ path: '/home/a/.podium/uploads/scope/1.pdf' })
      render(<ColdStartComposer first />)

      attach(new File(['%PDF'], 'brief.pdf', { type: 'application/pdf' }))

      await waitFor(() =>
        expect(uploadImage).toHaveBeenCalledWith(
          expect.objectContaining({ filename: 'brief.pdf', mimeType: 'application/pdf' }),
        ),
      )
      expect(screen.getByText('brief.pdf')).toBeTruthy()
    })

    /* THE DECK IS THE DROP TARGET, NOT THE WELL (POD-1669).
     *
     * Closed, the well is a 46px line adrift in a pane that is mostly air, so a
     * file dragged at "the box I am about to write in" lands on the document —
     * and the browser's default for a file dropped on a document is to NAVIGATE
     * to it. The gesture did not merely miss; it replaced the shell, the draft
     * and any launch in flight with a PDF in a tab. Both halves are guarded
     * here: the pane takes the file, and every drop is cancelled whether or not
     * it is taken. */
    describe('dropped on the deck', () => {
      const transfer = (files: File[]): unknown => ({
        files,
        types: ['Files'],
        items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      })
      const deck = (): HTMLElement => screen.getByTestId('cold-start-deck')
      const well = (): HTMLElement => screen.getByTestId('cold-start-field')

      it('attaches a file dropped on the empty air beside the well, and opens the box', async () => {
        uploadImage.mockResolvedValue({ path: '/home/a/.podium/uploads/scope/1.png' })
        render(<ColdStartComposer first={false} />)
        expect(well().dataset.expanded).toBe('false')

        const file = new File(['bytes'], 'shot.png', { type: 'image/png' })
        fireEvent.dragOver(deck(), { dataTransfer: transfer([file]) })
        // The answer to "will this land?" covers the same area as the question,
        // which takes a positioned pane to hang the veil on.
        expect(screen.getByText('Drop files to attach')).toBeTruthy()
        expect(deck().className).toContain('relative')
        fireEvent.drop(deck(), { dataTransfer: transfer([file]) })

        await waitFor(() =>
          expect(uploadImage).toHaveBeenCalledWith(
            expect.objectContaining({ filename: 'shot.png' }),
          ),
        )
        // An attachment unfolds the box by the rule a written prompt does — the
        // strip lives inside the well, so a closed box would hide what landed.
        expect(well().dataset.expanded).toBe('true')
        expect(screen.queryByText('Drop files to attach')).toBeNull()
      })

      it('cancels the browser default, so a stray drop cannot navigate the shell away', () => {
        render(<ColdStartComposer first={false} />)
        const file = new File(['bytes'], 'shot.png', { type: 'image/png' })
        // `fireEvent` returns false for a cancelled event; both halves of the
        // gesture have to be cancelled or the drop still reaches the document.
        expect(fireEvent.dragOver(deck(), { dataTransfer: transfer([file]) })).toBe(false)
        expect(fireEvent.drop(deck(), { dataTransfer: transfer([file]) })).toBe(false)
      })

      it('refuses files while a launch owns the box, and still swallows the drop', async () => {
        spawnIssueAgent.mockReturnValue({
          sessionId: asSessionId('busy-session'),
          issueId: asIssueId('busy-issue'),
          mutationId: asMutationId('busy-mutation'),
          settled: new Promise<boolean>(() => {}),
          outcome: new Promise(() => {}),
        })
        render(<ColdStartComposer first={false} />)
        fireEvent.change(screen.getByLabelText('What do you want to work on?'), {
          target: { value: 'Ship the new onboarding' },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Start work' }))
        await waitFor(() => expect(spawnIssueAgent).toHaveBeenCalled())

        const file = new File(['bytes'], 'late.png', { type: 'image/png' })
        expect(fireEvent.drop(deck(), { dataTransfer: transfer([file]) })).toBe(false)
        expect(uploadImage).not.toHaveBeenCalled()
        expect(screen.queryByText('Drop files to attach')).toBeNull()
      })
    })
  })
})
