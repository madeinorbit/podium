import { NEW_WORK_MODEL_KEY, NEW_WORK_EFFORT_KEY, NEW_WORK_REPO_KEY, LAST_LAUNCH_PICK_KEY } from '@podium/client-core/ui-state'
import { headerEntities } from '@podium/client-graph/header-entities'
import { launchOptionViews } from '@podium/client-graph/launch-option-views'
/**
 * THE LAUNCH SHEET AFTER THE WIZARD [POD-1354].
 *
 * Two claims, and the first is the one the operator complained about: a project
 * list with ONE row in it is not a decision, so the sheet states the project and
 * starts from it. The second is the converse — where the choice is real, the
 * field is still a control.
 */

import { commandLaunchViews } from '@podium/client-graph/command-launch-views'
import type { MobxPool } from '@podium/client-graph/pool'
import type { GitRepositoryWire, MachineWire, SessionMeta } from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobilePool } from '../client/mobile-pool'
import { renderWithMobileStore } from '../client/test-support'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('./BottomSheet', () => ({
  BottomSheet: ({
    visible,
    onClose,
    head,
    children,
  }: {
    visible: boolean
    onClose: () => void
    head?: ReactNode
    children: ReactNode
  }) =>
    visible ? (
      <div>
        <button type="button" aria-label="Dismiss launcher" onClick={onClose}>
          Close
        </button>
        {head}
        {children}
      </div>
    ) : null,
}))
vi.mock('expo-router', () => ({
  usePathname: () => '/work',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

const catalogFixture = vi.hoisted(() => ({ byMachine: {} as Record<string, Record<string, Array<{ value: string; label: string; efforts?: string[] }>>> }))
const LIVE = { 'claude-code': [{ value: 'reported-opus', label: 'Reported Opus', efforts: ['low', 'high'] }] }
vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<typeof import('@podium/client-core/react')>()),
  useModelCatalog: (machineId?: string) => catalogFixture.byMachine[machineId ?? 'mine'] ?? {},
}))
beforeEach(() => { catalogFixture.byMachine = { mine: LIVE, remote: LIVE } })

const { NewWorkButton } = await import('./NewWorkButton')

function repo(path: string): GitRepositoryWire {
  return {
    path,
    kind: 'repository',
    branch: 'main',
    repoId: `repo_${path.split('/').pop()}`,
    machineId: 'mine',
    worktrees: [{ path: `${path}-wt`, branch: 'feature' }],
  } as unknown as GitRepositoryWire
}

type Login = 'in' | 'out' | 'unknown'

/** The one machine the fixtures' repos live on, reporting which harnesses it
 *  has and whether each is signed in — the inventory the readiness rule reads. */
function machine(
  agents: Partial<Record<string, Login>>,
  id = 'mine',
  name = 'Studio',
): MachineWire {
  return {
    id,
    name,
    hostname: name.toLowerCase(),
    online: true,
    serviceAssignment: { server: false, agentExecution: true },
    availability: { epoch: 'boot-1', server: false, daemon: true, supervisor: true },
    lastSeenAt: new Date(0).toISOString(),
    inventory: {
      os: 'linux',
      arch: 'x64',
      agents: Object.entries(agents).map(([kind, login]) => ({
        kind,
        installed: true,
        login: { state: login },
      })),
      tools: [],
    },
  } as unknown as MachineWire
}

const READY = [machine({ 'claude-code': 'in', opencode: 'in' })]
const NOT_READY =
  'The selected agent is not ready on this machine yet. Open Settings → Agents to finish setup.'

function historySession(id: string, patch: object = {}): SessionMeta {
  return {
    sessionId: id,
    agentKind: 'codex',
    status: 'live',
    archived: false,
    cwd: '/home/dev/podium',
    machineId: 'mine',
    createdAt: '2026-10-01T00:00:00Z',
    lastActiveAt: '2026-10-01T00:00:00Z',
    ...patch,
  } as SessionMeta
}

async function pressStart() {
  await waitFor(() => expect(screen.getByLabelText('Start in podium').getAttribute('aria-disabled')).not.toBe('true'))
  fireEvent.click(screen.getByLabelText('Start in podium'))
}

function pickFirstClaudeModel() {
  const choice = screen.getAllByLabelText(/^Claude Code /)[0]
  if (!choice) throw new Error('No Claude model choice')
  fireEvent.click(choice)
}

describe('phone launch demand bounds', () => {
  it('reads only root scan rows with flat demand at 1x/4x linked-worktree history', async () => {
    const readsByScale: number[] = []
    for (const scale of [1, 4]) {
      let pool: MobxPool | null = null
      function Capture() {
        pool = useMobilePool()
        return null
      }
      const path = '/home/dev/podium'
      const root = {
        ...repo(path),
        worktrees: Array.from({ length: 32 * scale }, (_, n) => ({ path: `${path}/wt-${n}` })),
      }
      const linked = root.worktrees.map((tree) => ({ ...repo(tree.path), worktrees: [] }))
      await renderWithMobileStore(
        <><Capture /><NewWorkButton /></>,
        { repos: [root, ...linked], machines: READY },
      )
      const attached = pool as MobxPool | null
      if (!attached) throw new Error('Pool did not attach')
      const rows = vi.spyOn(attached, 'row')
      fireEvent.click(screen.getByLabelText('New work'))
      await screen.findByLabelText('Start in podium')
      // Shared models read the root again for each stored field. Count addresses
      // separately from those scalar reads, and bound both size and growth.
      const rootReads = rows.mock.calls.filter(([kind]) => String(kind) === 'repository')
      expect(rootReads.length).toBeGreaterThan(0)
      expect(rootReads).toHaveLength(33)
      readsByScale.push(rootReads.length)
      expect(new Set(rootReads.map(([, id]) => id))).toEqual(new Set([JSON.stringify(['mine', path])]))
      rows.mockClear()
      await act(async () => {
        headerEntities(attached).apply([{ kind: 'repository', id: JSON.stringify(['mine', linked[0]!.path]),
          value: { ...linked[0]!, branch: 'unshown' } }])
      })
      expect(rows.mock.calls.filter(([kind]) => String(kind) === 'repository')).toHaveLength(0)
      expect(screen.getByLabelText('Start in podium')).toBeDefined()
      cleanup()
      rows.mockRestore()
    }
    expect(readsByScale[1]).toBe(readsByScale[0])
  })

  it.each([
    1, 4,
  ])('keeps catalogs and machine reads closed at %sx history, and opens without session rows', async (scale) => {
    let pool: MobxPool | null = null
    let machinesRead: ReturnType<typeof vi.spyOn> | undefined
    function Capture() {
      pool = useMobilePool()
      if (pool && !machinesRead) machinesRead = vi.spyOn(launchOptionViews(pool), 'machines')
      return null
    }
    const { replica } = await renderWithMobileStore(
      <>
        <Capture />
        <NewWorkButton />
      </>,
      {
        repos: [repo('/home/dev/podium')],
        machines: READY,
        sessions: Array.from({ length: scale * 32 }, (_, n) => historySession(`history-${n}`)),
      },
    )
    const attached = pool as MobxPool | null
    if (!attached || !machinesRead) throw new Error('Pool did not attach')
    const counts = commandLaunchViews(attached).counts
    const launchCounts = launchOptionViews(attached).counts
    expect(launchCounts).toEqual({ repositoryBuilds: 0, usageQueries: 0 })
    expect(counts.catalogBuilds).toBe(0)
    expect(counts.coldSessionVisits).toBe(0)
    expect(machinesRead).not.toHaveBeenCalled()
    const rows = vi.spyOn(attached, 'row')
    const history = vi.spyOn(attached.queries, 'latestMachineSession')
    const activity = vi.spyOn(attached.queries, 'activity')
    fireEvent.click(screen.getByLabelText('New work'))
    await screen.findByLabelText('Start in podium')
    expect(machinesRead).toHaveBeenCalled()
    expect(launchCounts).toEqual({ repositoryBuilds: 1, usageQueries: 1 })
    expect(history).toHaveBeenCalledWith(['mine'])
    expect(activity).toHaveBeenCalledWith({
      kind: 'commandRootActivity',
      roots: ['/home/dev/podium', '/home/dev/podium', '/home/dev/podium-wt'],
      match: 'exact',
    })
    expect(rows.mock.calls.filter(([kind]) => kind === 'session')).toHaveLength(0)
    expect(counts.catalogBuilds).toBe(0)
    expect(counts.coldSessionVisits).toBe(0)
    rows.mockClear()
    await act(async () => {
      replica.applyChanges(
        'sessions',
        [historySession('history-0', { lastActiveAt: '2026-10-02T00:00:00Z' })],
        [],
      )
    })
    expect(
      rows.mock.calls.filter(([kind, id]) => kind === 'session' && id !== 'history-0'),
    ).toHaveLength(0)
    expect(counts.addressedSessionReads).toBe(0)
    expect(launchCounts).toEqual({ repositoryBuilds: 1, usageQueries: 1 })
    fireEvent.click(screen.getByLabelText('Dismiss launcher'))
    machinesRead.mockClear()
    history.mockClear()
    activity.mockClear()
    await act(async () => {
      replica.applyChanges(
        'sessions',
        [historySession('history-0', { lastActiveAt: '2026-10-03T00:00:00Z' })],
        [],
      )
    })
    expect(machinesRead).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
    expect(activity).not.toHaveBeenCalled()
    expect(counts.addressedSessionReads).toBe(0)
    expect(launchCounts).toEqual({ repositoryBuilds: 1, usageQueries: 1 })
  })

  it('restores the prompt and persisted model, machine, and project after dismissal', async () => {
    const projects = [repo('/home/dev/podium'), repo('/home/dev/shared')]
    await renderWithMobileStore(<NewWorkButton />, {
      repos: [
        ...projects,
        ...projects.map((project) => ({ ...project, machineId: 'remote' }) as GitRepositoryWire),
      ],
      machines: [...READY, machine({ 'claude-code': 'in' }, 'remote', 'Remote')],
    })
    fireEvent.click(screen.getByLabelText('New work'))
    fireEvent.change(screen.getByLabelText('First prompt, optional'), {
      target: { value: 'Keep my prompt' },
    })
    fireEvent.click(screen.getByLabelText('Machine, Studio'))
    fireEvent.click(screen.getByLabelText('Remote'))
    fireEvent.click(screen.getByLabelText('Project, podium'))
    fireEvent.click(screen.getByLabelText('shared'))
    fireEvent.click(screen.getByLabelText('Model, Auto'))
    fireEvent.click(screen.getByLabelText('No agent Shell'))
    fireEvent.click(screen.getByLabelText('Dismiss launcher'))
    fireEvent.click(screen.getByLabelText('New work'))
    await screen.findByLabelText('Model, Shell')
    expect(screen.getByLabelText('Project, shared')).toBeTruthy()
    expect(screen.getByLabelText('Machine, Remote')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Model, Shell'))
    fireEvent.click(screen.getByLabelText('Auto'))
    expect(
      ((await screen.findByLabelText('First prompt, optional')) as HTMLInputElement).value,
    ).toBe('Keep my prompt')
  })

  it('uses machine creation and exact repository activity scalars for remembered defaults', async () => {
    const otherRepo = { ...repo('/home/dev/shared'), machineId: 'remote' } as GitRepositoryWire
    await renderWithMobileStore(<NewWorkButton />, {
      repos: [repo('/home/dev/podium'), otherRepo],
      machines: [...READY, machine({ 'claude-code': 'in' }, 'remote', 'Remote')],
      sessions: [
        historySession('old'),
        historySession('recent', {
          machineId: 'remote',
          cwd: '/home/dev/shared-wt',
          createdAt: '2026-10-02T00:00:00Z',
          lastActiveAt: '2026-10-02T00:00:00Z',
        }),
      ],
    })
    fireEvent.click(screen.getByLabelText('New work'))
    expect(await screen.findByLabelText('Machine, Remote')).toBeTruthy()
    expect(screen.getByLabelText('Project, shared')).toBeTruthy()
  })

  it('restores an explicit model and effort after the launcher remounts', async () => {
    await renderWithMobileStore(<NewWorkButton />, {
      repos: [repo('/home/dev/podium')],
      machines: READY,
    })
    fireEvent.click(screen.getByLabelText('New work'))
    fireEvent.click(screen.getByLabelText('Model, Auto'))
    pickFirstClaudeModel()
    await screen.findByLabelText('Effort, Auto')
    const modelLabel = screen.getByLabelText(/^Model, /).getAttribute('aria-label')
    if (!modelLabel) throw new Error('Missing selected model label')
    fireEvent.click(screen.getByLabelText('Effort, Auto'))
    fireEvent.click(screen.getByLabelText('High'))
    await screen.findByLabelText('Effort, High')
    fireEvent.click(screen.getByLabelText('Dismiss launcher'))
    fireEvent.click(screen.getByLabelText('New work'))
    expect(await screen.findByLabelText(modelLabel)).toBeTruthy()
    expect(await screen.findByLabelText('Effort, High')).toBeTruthy()
  })
})

describe('the phone launch sheet', () => {
  it('states the only project and starts from it, instead of asking for it', async () => {
    await renderWithMobileStore(<NewWorkButton />, {
      repos: [repo('/home/dev/podium')],
      machines: READY,
    })
    fireEvent.click(screen.getByLabelText('New work'))

    // Named on the primary control, so the sheet still says where this lands.
    expect(screen.getByLabelText('Start in podium')).toBeTruthy()
    // Present, but inert: a picker over a list of one is a tap the app collects
    // on the way to doing the only thing it could have done.
    const project = screen.getByLabelText('Project, podium')
    expect(project.getAttribute('role')).not.toBe('button')
    // And the wizard's last step is gone with it.
    expect(screen.queryByLabelText('Choose project')).toBeNull()
  })

  it('keeps the project a control when the choice is real', async () => {
    await renderWithMobileStore(<NewWorkButton />, {
      repos: [repo('/home/dev/podium'), repo('/home/dev/shared')],
      machines: READY,
    })
    fireEvent.click(screen.getByLabelText('New work'))

    const project = screen.getByLabelText(/^Project, /)
    expect(project.getAttribute('role')).toBe('button')
    fireEvent.click(project)
    expect(screen.getByLabelText('shared')).toBeTruthy()
    expect(screen.getByLabelText('podium')).toBeTruthy()
  })

  it('offers the shell inside the model list rather than as a second control', async () => {
    await renderWithMobileStore(<NewWorkButton />, {
      repos: [repo('/home/dev/podium')],
      machines: READY,
    })
    fireEvent.click(screen.getByLabelText('New work'))
    expect(screen.queryByLabelText('Shell')).toBeNull()

    fireEvent.click(screen.getByLabelText('Model, Auto'))
    fireEvent.click(screen.getByLabelText('No agent Shell'))
    expect(await screen.findByLabelText('Model, Shell')).toBeTruthy()
  })

  it('starts an agent with the written first prompt', async () => {
    const create = vi.fn(async (_request: unknown) => ({ sessionId: 'created' }))
    await renderWithMobileStore(<NewWorkButton />, {
      repos: [repo('/home/dev/podium')],
      machines: READY,
      api: { sessions: { create: { mutate: create } } },
    })
    fireEvent.click(screen.getByLabelText('New work'))
    fireEvent.change(screen.getByLabelText('First prompt, optional'), {
      target: { value: '  Fix the login race  ' },
    })
    await pressStart()

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ initialPrompt: 'Fix the login race' }),
      ),
    )
  })

  it('keeps the first prompt until the optimistic spawn settles', async () => {
    let confirmSpawn: ((value: { sessionId: string }) => void) | undefined
    const create = vi.fn(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          confirmSpawn = resolve
        }),
    )
    await renderWithMobileStore(<NewWorkButton />, {
      repos: [repo('/home/dev/podium')],
      machines: READY,
      api: { sessions: { create: { mutate: create } } },
    })
    fireEvent.click(screen.getByLabelText('New work'))
    fireEvent.change(screen.getByLabelText('First prompt, optional'), {
      target: { value: 'Keep this through settle' },
    })
    await pressStart()

    fireEvent.click(screen.getByLabelText('New work'))
    expect((screen.getByLabelText('First prompt, optional') as HTMLInputElement).value).toBe(
      'Keep this through settle',
    )

    confirmSpawn?.({ sessionId: 'created' })
    await waitFor(() =>
      expect((screen.getByLabelText('First prompt, optional') as HTMLInputElement).value).toBe(''),
    )
  })

  /**
   * A HARNESS THAT CANNOT RUN IS NOT A DEFAULT [POD-4639].
   *
   * The sheet used to send the registry's first harness whatever the machine
   * said about it, so on a host where Claude is signed out every phone launch
   * started a session that could only answer "Not logged in". The desktop
   * composer already refuses that launch; the phone reads the same rule.
   */
  describe('harness readiness on the target machine', () => {
    it('starts Auto on a harness that is ready there when the default is signed out', async () => {
      const create = vi.fn(async (_request: unknown) => ({ sessionId: 'created' }))
      await renderWithMobileStore(<NewWorkButton />, {
        repos: [repo('/home/dev/podium')],
        machines: [machine({ 'claude-code': 'out', opencode: 'in' })],
        api: { sessions: { create: { mutate: create } } },
      })
      fireEvent.click(screen.getByLabelText('New work'))
      expect(screen.queryByText(NOT_READY)).toBeNull()
      // Named, so the step over the signed-out default is visible, not guessed.
      expect(screen.getByLabelText('Model, Auto · OpenCode')).toBeTruthy()
      await pressStart()

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ agentKind: 'opencode' }))
    })

    it('keeps the default harness when it is ready', async () => {
      const create = vi.fn(async (_request: unknown) => ({ sessionId: 'created' }))
      await renderWithMobileStore(<NewWorkButton />, {
        repos: [repo('/home/dev/podium')],
        machines: READY,
        api: { sessions: { create: { mutate: create } } },
      })
      fireEvent.click(screen.getByLabelText('New work'))
      await pressStart()

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ agentKind: 'claude-code' }))
    })

    it('refuses with the desktop message when no harness is installed there', async () => {
      const create = vi.fn(async (_request: unknown) => ({ sessionId: 'created' }))
      await renderWithMobileStore(<NewWorkButton />, {
        repos: [repo('/home/dev/podium')],
        machines: [machine({})],
        api: { sessions: { create: { mutate: create } } },
      })
      fireEvent.click(screen.getByLabelText('New work'))

      expect(await screen.findByText(NOT_READY)).toBeTruthy()
      const start = screen.getByLabelText('Start in podium')
      expect(start.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(start)
      await Promise.resolve()
      expect(create).not.toHaveBeenCalled()
    })

    it('judges the harness on the machine the launch lands on, not on any machine', async () => {
      // Claude is signed in on a second host, but the project lives on Studio,
      // where it is signed out: Auto must still step over it.
      const create = vi.fn(async (_request: unknown) => ({ sessionId: 'created' }))
      await renderWithMobileStore(<NewWorkButton />, {
        repos: [repo('/home/dev/podium')],
        machines: [
          machine({ 'claude-code': 'out', opencode: 'in' }),
          machine({ 'claude-code': 'in' }, 'other', 'Laptop'),
        ],
        api: { sessions: { create: { mutate: create } } },
      })
      fireEvent.click(screen.getByLabelText('New work'))
      expect(screen.getByLabelText('Machine, Studio')).toBeTruthy()
      await pressStart()

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ agentKind: 'opencode' }))
    })

    it('launches an explicitly picked signed-out harness headed with the desktop sign-in sentence', async () => {
      const create = vi.fn(async (_request: unknown) => ({ sessionId: 'created' }))
      await renderWithMobileStore(<NewWorkButton />, {
        repos: [repo('/home/dev/podium')],
        machines: [machine({ 'claude-code': 'out', opencode: 'in' })],
        api: { sessions: { create: { mutate: create } } },
      })
      fireEvent.click(screen.getByLabelText('New work'))
      fireEvent.click(screen.getByLabelText(/^Model, Auto/))
      pickFirstClaudeModel()
      expect(await screen.findByText('Claude Code is not signed in on Studio. It opens in its terminal, where you can sign in.')).toBeTruthy()
      const start = screen.getByLabelText('Start in podium')
      expect(start.getAttribute('aria-disabled')).not.toBe('true')
      fireEvent.click(start)
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      const request = create.mock.calls[0]?.[0] as unknown as Record<string, unknown>
      expect(request).toMatchObject({ agentKind: 'claude-code', model: 'reported-opus' })
      // sessions.create's absent driver override is explicitly the headed default.
      expect(request).not.toHaveProperty('requestedDriverId')
      expect(request).not.toHaveProperty('headless')
    })
  })
})


describe('phone picker parity', () => {
  it('resets a retired remembered model and its effort visibly and before submitting', async () => {
    const create = vi.fn(async (_request: unknown) => ({ sessionId: 'created' }))
    const { runtime } = await renderWithMobileStore(<NewWorkButton />, {
      repos: [repo('/home/dev/podium')], machines: READY,
      api: { sessions: { create: { mutate: create } } },
    })
    act(() => {
      runtime.access.uiState.set(NEW_WORK_MODEL_KEY, 'claude-code:retired')
      runtime.access.uiState.set(NEW_WORK_EFFORT_KEY, 'high')
    })
    fireEvent.click(screen.getByLabelText('New work'))
    expect(await screen.findByLabelText('Model, Auto')).toBeTruthy()
    expect(screen.getByLabelText('Effort, Auto').getAttribute('role')).not.toBe('button')
    expect(runtime.access.uiState.get(NEW_WORK_MODEL_KEY)).toBe('auto')
    expect(runtime.access.uiState.get(NEW_WORK_EFFORT_KEY)).toBe('auto')
    await pressStart()
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('model')
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('effort')
  })

  it('keeps the draft on a project switch, and restores Auto on an unremembered machine', async () => {
    const create = vi.fn(async (_request: unknown) => ({ sessionId: 'created' }))
    const projects = [repo('/home/dev/podium'), repo('/home/dev/shared')]
    await renderWithMobileStore(<NewWorkButton />, {
      repos: [...projects, ...projects.map((project) => ({ ...project, machineId: 'remote' }) as GitRepositoryWire)],
      machines: [...READY, machine({ 'claude-code': 'in' }, 'remote', 'Remote')],
      api: { sessions: { create: { mutate: create } } },
    })
    fireEvent.click(screen.getByLabelText('New work'))
    fireEvent.click(screen.getByLabelText('Model, Auto'))
    pickFirstClaudeModel()
    await screen.findByRole('button', { name: 'Model, Claude Code · Reported Opus' })
    fireEvent.click(screen.getByLabelText('Effort, Auto'))
    fireEvent.click(screen.getByLabelText('High'))
    fireEvent.click(screen.getByLabelText('Project, podium'))
    fireEvent.click(screen.getByLabelText('shared'))
    expect(await screen.findByLabelText('Model, Claude Code · Reported Opus')).toBeTruthy()
    expect(screen.getByLabelText('Effort, High')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Machine, Studio'))
    fireEvent.click(screen.getByLabelText('Remote'))
    expect(await screen.findByLabelText('Model, Auto')).toBeTruthy()
    expect(screen.getByLabelText('Effort, Auto')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Start in shared'))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]?.[0]).toMatchObject({ machineId: 'remote' })
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('model')
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('effort')
  })

  it('offers no Use option for a typed model name', async () => {
    catalogFixture.byMachine.mine = { 'claude-code': Array.from({ length: 9 }, (_, n) => ({ value: `model-${n}`, label: `Model ${n}` })) }
    await renderWithMobileStore(<NewWorkButton />, { repos: [repo('/home/dev/podium')], machines: READY })
    fireEvent.click(screen.getByLabelText('New work'))
    fireEvent.click(screen.getByLabelText('Model, Auto'))
    fireEvent.change(screen.getByPlaceholderText(/Filter/), { target: { value: 'my-custom-model' } })
    expect(screen.queryByLabelText(/Use.*my-custom-model/)).toBeNull()
    expect(screen.queryByText(/Use.*my-custom-model/)).toBeNull()
  })
})

describe('phone last launched pair', () => {
  const picks = {
    mine: { 'claude-code': { model: 'reported-opus', effort: 'high' }, codex: { model: 'reported-gpt', effort: 'low' } },
    remote: { 'claude-code': { model: 'reported-sonnet', effort: 'low' }, codex: { model: 'reported-gpt', effort: 'high' } },
  }
  async function setup() {
    catalogFixture.byMachine = {
      mine: { ...LIVE, codex: [{ value: 'reported-gpt', label: 'Reported GPT', efforts: ['low', 'high'] }] },
      remote: { 'claude-code': [{ value: 'reported-sonnet', label: 'Reported Sonnet', efforts: ['low', 'high'] }],
        codex: [{ value: 'reported-gpt', label: 'Reported GPT', efforts: ['low', 'high'] }] },
    }
    const create = vi.fn(async (_request: unknown) => ({ sessionId: 'created' }))
    const layoutSet = vi.fn(async () => ({}))
    const view = await renderWithMobileStore(<NewWorkButton />, {
      repos: [repo('/home/dev/podium'), { ...repo('/home/dev/podium'), machineId: 'remote' } as GitRepositoryWire],
      machines: [machine({ 'claude-code': 'in', codex: 'in' }), machine({ 'claude-code': 'in', codex: 'in' }, 'remote', 'Remote')],
      api: { sessions: { create: { mutate: create } }, layout: { set: { mutate: layoutSet } } },
    })
    return { ...view, create, layoutSet }
  }
  async function choose(field: string, choice: string) {
    fireEvent.click(screen.getByLabelText(new RegExp(`^${field}, `)))
    fireEvent.click(await screen.findByLabelText(choice))
  }
  async function expectPair(model: string, effort: string) {
    expect(await screen.findByLabelText(`Model, ${model}`)).toBeTruthy()
    expect(screen.getByLabelText(`Effort, ${effort}`)).toBeTruthy()
  }

  it('restores all four machine/harness pairs and Auto when a combination is absent', async () => {
    const { runtime } = await setup()
    act(() => runtime.access.uiState.set(LAST_LAUNCH_PICK_KEY, JSON.stringify(picks)))
    fireEvent.click(screen.getByLabelText('New work'))
    await expectPair('Claude Code · Reported Opus', 'High')
    await choose('Model', 'Codex Reported GPT')
    await expectPair('Codex · Reported GPT', 'Auto')
    await choose('Machine', 'Remote')
    await expectPair('Codex · Reported GPT', 'High')
    await choose('Machine', 'Studio')
    await expectPair('Codex · Reported GPT', 'Low')
    await choose('Machine', 'Remote')
    await expectPair('Codex · Reported GPT', 'High')
    await choose('Model', 'Claude Code Reported Sonnet')
    await expectPair('Claude Code · Reported Sonnet', 'Auto')
    await choose('Machine', 'Studio')
    await expectPair('Claude Code · Reported Opus', 'High')
    await choose('Machine', 'Remote')
    await expectPair('Claude Code · Reported Sonnet', 'Low')
    act(() => runtime.access.uiState.set(LAST_LAUNCH_PICK_KEY, JSON.stringify({ mine: picks.mine })))
    await choose('Machine', 'Studio')
    await choose('Machine', 'Remote')
    await expectPair('Auto', 'Auto')
  })

  it('choosing menus writes no preference, while Start writes the launched pair including Auto', async () => {
    const { runtime, create } = await setup()
    const writes = vi.spyOn(runtime.access.uiState, 'set')
    const pairWrites = () => writes.mock.calls.filter(([key]) => key === LAST_LAUNCH_PICK_KEY)
    fireEvent.click(screen.getByLabelText('New work'))
    await choose('Model', 'Claude Code Reported Opus')
    await choose('Effort', 'High')
    await expectPair('Claude Code · Reported Opus', 'High')
    expect(pairWrites()).toHaveLength(0)
    await pressStart()
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]?.[0]).toMatchObject({ machineId: 'mine', agentKind: 'claude-code', model: 'reported-opus', effort: 'high' })
    expect(JSON.parse(runtime.access.uiState.get(LAST_LAUNCH_PICK_KEY)!)).toEqual({ mine: { 'claude-code': picks.mine['claude-code'] } })
    fireEvent.click(screen.getByLabelText('New work'))
    await choose('Model', 'Auto')
    expect(pairWrites()).toHaveLength(1)
    await pressStart()
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(JSON.parse(runtime.access.uiState.get(LAST_LAUNCH_PICK_KEY)!)).toEqual({ mine: { 'claude-code': { model: 'auto', effort: 'auto' } } })
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('model')
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('effort')
  })

  it('keeps a saved draft with different model and effort across reload, including explicit Auto', async () => {
    const { runtime } = await setup()
    act(() => {
      runtime.access.uiState.set(LAST_LAUNCH_PICK_KEY, JSON.stringify(picks))
      runtime.access.uiState.set(NEW_WORK_MODEL_KEY, 'codex:reported-gpt')
      runtime.access.uiState.set(NEW_WORK_EFFORT_KEY, 'high')
    })
    fireEvent.click(screen.getByLabelText('New work'))
    await expectPair('Codex · Reported GPT', 'High')
    fireEvent.click(screen.getByLabelText('Dismiss launcher'))
    fireEvent.click(screen.getByLabelText('New work'))
    await expectPair('Codex · Reported GPT', 'High')
    await choose('Model', 'Auto')
    fireEvent.click(screen.getByLabelText('Dismiss launcher'))
    fireEvent.click(screen.getByLabelText('New work'))
    await expectPair('Auto', 'Auto')
  })

  it('resets a restored stale model after the selected machine list arrives', async () => {
    const { runtime } = await setup()
    catalogFixture.byMachine.mine = {}
    act(() => runtime.access.uiState.set(LAST_LAUNCH_PICK_KEY, JSON.stringify(picks)))
    fireEvent.click(screen.getByLabelText('New work'))
    await expectPair('Claude Code · reported-opus', 'High')
    catalogFixture.byMachine.mine = { 'claude-code': [{ value: 'replacement', label: 'Replacement', efforts: ['high'] }] }
    act(() => runtime.access.uiState.set(NEW_WORK_REPO_KEY, '/home/dev/podium'))
    await expectPair('Auto', 'Auto')
    expect(JSON.parse(runtime.access.uiState.get(LAST_LAUNCH_PICK_KEY)!)).toEqual(picks)
  })

  it('changing model always resets effort, even when the new model supports the old level', async () => {
    const { runtime } = await setup()
    catalogFixture.byMachine.mine!['claude-code']!.push({ value: 'second', label: 'Second', efforts: ['high'] })
    act(() => runtime.access.uiState.set(LAST_LAUNCH_PICK_KEY, JSON.stringify(picks)))
    fireEvent.click(screen.getByLabelText('New work'))
    await expectPair('Claude Code · Reported Opus', 'High')
    await choose('Model', 'Claude Code Second')
    await expectPair('Claude Code · Second', 'Auto')
    expect(JSON.parse(runtime.access.uiState.get(LAST_LAUNCH_PICK_KEY)!)).toEqual(picks)
  })
})
