/**
 * THE LAUNCH SHEET AFTER THE WIZARD [POD-1354].
 *
 * Two claims, and the first is the one the operator complained about: a project
 * list with ONE row in it is not a decision, so the sheet states the project and
 * starts from it. The second is the converse — where the choice is real, the
 * field is still a control.
 */

import type { GitRepositoryWire, MachineWire } from '@podium/model'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'

afterEach(cleanup)

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('./BottomSheet', () => ({
  BottomSheet: ({
    visible,
    head,
    children,
  }: {
    visible: boolean
    head?: ReactNode
    children: ReactNode
  }) =>
    visible ? (
      <div>
        {head}
        {children}
      </div>
    ) : null,
}))
vi.mock('expo-router', () => ({
  usePathname: () => '/work',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

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
    expect(screen.getByLabelText('Model, Shell')).toBeTruthy()
  })

  it('starts an agent with the written first prompt', async () => {
    const create = vi.fn(async () => ({ sessionId: 'created' }))
    await renderWithMobileStore(<NewWorkButton />, {
      repos: [repo('/home/dev/podium')],
      machines: READY,
      api: { sessions: { create: { mutate: create } } },
    })
    fireEvent.click(screen.getByLabelText('New work'))
    fireEvent.change(screen.getByLabelText('First prompt, optional'), {
      target: { value: '  Fix the login race  ' },
    })
    fireEvent.click(screen.getByLabelText('Start in podium'))

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
    fireEvent.click(screen.getByLabelText('Start in podium'))

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
      const create = vi.fn(async () => ({ sessionId: 'created' }))
      await renderWithMobileStore(<NewWorkButton />, {
        repos: [repo('/home/dev/podium')],
        machines: [machine({ 'claude-code': 'out', opencode: 'in' })],
        api: { sessions: { create: { mutate: create } } },
      })
      fireEvent.click(screen.getByLabelText('New work'))
      expect(screen.queryByText(NOT_READY)).toBeNull()
      // Named, so the step over the signed-out default is visible, not guessed.
      expect(screen.getByLabelText('Model, Auto · OpenCode')).toBeTruthy()
      fireEvent.click(screen.getByLabelText('Start in podium'))

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ agentKind: 'opencode' }))
    })

    it('keeps the default harness when it is ready', async () => {
      const create = vi.fn(async () => ({ sessionId: 'created' }))
      await renderWithMobileStore(<NewWorkButton />, {
        repos: [repo('/home/dev/podium')],
        machines: READY,
        api: { sessions: { create: { mutate: create } } },
      })
      fireEvent.click(screen.getByLabelText('New work'))
      fireEvent.click(screen.getByLabelText('Start in podium'))

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ agentKind: 'claude-code' }))
    })

    it('refuses with the desktop message when no harness is ready there', async () => {
      const create = vi.fn(async () => ({ sessionId: 'created' }))
      await renderWithMobileStore(<NewWorkButton />, {
        repos: [repo('/home/dev/podium')],
        machines: [machine({ 'claude-code': 'out' })],
        api: { sessions: { create: { mutate: create } } },
      })
      fireEvent.click(screen.getByLabelText('New work'))

      expect(screen.getByText(NOT_READY)).toBeTruthy()
      const start = screen.getByLabelText('Start in podium')
      expect(start.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(start)
      await Promise.resolve()
      expect(create).not.toHaveBeenCalled()
    })

    it('judges the harness on the machine the launch lands on, not on any machine', async () => {
      // Claude is signed in on a second host, but the project lives on Studio,
      // where it is signed out: Auto must still step over it.
      const create = vi.fn(async () => ({ sessionId: 'created' }))
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
      fireEvent.click(screen.getByLabelText('Start in podium'))

      await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ agentKind: 'opencode' }))
    })

    it('refuses an explicitly picked harness that is signed out, rather than swapping it', async () => {
      const create = vi.fn(async () => ({ sessionId: 'created' }))
      await renderWithMobileStore(<NewWorkButton />, {
        repos: [repo('/home/dev/podium')],
        machines: [machine({ 'claude-code': 'out', opencode: 'in' })],
        api: { sessions: { create: { mutate: create } } },
      })
      fireEvent.click(screen.getByLabelText('New work'))
      fireEvent.click(screen.getByLabelText(/^Model, Auto/))
      fireEvent.click(screen.getAllByLabelText(/^Claude Code /)[0]!)

      expect(screen.getByText(NOT_READY)).toBeTruthy()
      const start = screen.getByLabelText('Start in podium')
      expect(start.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(start)
      await Promise.resolve()
      expect(create).not.toHaveBeenCalled()
    })
  })
})
