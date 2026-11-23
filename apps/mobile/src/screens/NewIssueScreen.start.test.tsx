/**
 * "CREATE AND START" IS AN `issue.start` (POD-6421).
 *
 * The phone's new task screen starts its agent the way the web composer does:
 * the pool's `spawnIssueAgent`, whose `effects.create` of kind `issue.start`
 * goes out on `sync.submit` with the task's fields, its priority and its chosen
 * stage. It no longer files through `issues.create` with `startNow`.
 */

import { asMachineId, type GitRepositoryWire, type MachineWire } from '@podium/model'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import { NewIssueScreen } from './NewIssueScreen'

const { router } = vi.hoisted(() => ({ router: { back: () => {}, replace: vi.fn() } }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 430, height: 900 }),
}))
vi.mock('expo-router', () => ({ useRouter: () => router }))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('../components/Screen', () => ({
  Screen: ({ children }: { children: import('react').ReactNode }) => <>{children}</>,
}))
afterEach(() => {
  cleanup()
  router.replace.mockClear()
})

const machine: MachineWire = {
  id: asMachineId('launch-host'),
  name: 'Launch host',
  hostname: 'launch-host',
  online: true,
  lastSeenAt: new Date().toISOString(),
  use: 'granted',
  serviceAssignment: { server: false, agentExecution: true },
  availability: { epoch: 'one', daemon: true, server: false, supervisor: true },
  inventory: {
    os: 'linux',
    arch: 'x64',
    tools: [],
    agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }],
  },
}
const repo: GitRepositoryWire = {
  path: '/synthetic',
  kind: 'repository',
  worktrees: [],
  originUrl: 'https://example.invalid/repository.git',
}

interface Submitted {
  command: string
  input: { kind?: string; target?: { kind: string; id: string }; input?: Record<string, unknown> }
}

/** Every write the screen sends, as `sync.submit` envelopes. */
function submitApi(sent: Submitted[]) {
  const noop = async () => ({})
  return {
    // The procedures the screen's writes are sent in place of.
    issues: {
      create: { mutate: noop },
      update: { mutate: noop },
      panelApply: { mutate: noop },
      clearNeedsHuman: { mutate: noop },
    },
    sync: {
      submit: {
        mutate: async (envelope: Submitted) => {
          sent.push(envelope)
          return {
            outcome: 'applied',
            result: {},
            receipt: { feedId: 'f', epoch: 'e', seq: 0 },
            replayed: false,
          }
        },
      },
    },
  }
}

it('starts the task through issue.start with its priority and chosen stage', async () => {
  const sent: Submitted[] = []
  await renderWithMobileStore(<NewIssueScreen />, {
    repos: [repo],
    machines: [machine],
    api: submitApi(sent),
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), {
    target: { value: 'Fix the login' },
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'First prompt and task context' }), {
    target: { value: 'The login loops.\n' },
  })
  fireEvent.click(screen.getByRole('radio', { name: 'P1' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Planning' }))
  const create = screen.getByRole('button', { name: 'Create task' }) as HTMLButtonElement
  await waitFor(() => expect(create.disabled).toBe(false))
  fireEvent.click(create)

  await waitFor(() => expect(router.replace).toHaveBeenCalled())
  const start = sent.find((e) => e.command === 'effects.create')
  expect(start?.input).toMatchObject({
    kind: 'issue.start',
    target: { kind: 'issue' },
    input: {
      repoPath: '/synthetic',
      title: 'Fix the login',
      // The prompt verbatim, as the create carried it.
      description: 'The login loops.\n',
      priority: 1,
      stage: 'planning',
    },
  })
  // Agent stays Auto: the configured coding role decides when it runs.
  expect(start?.input.input).not.toHaveProperty('defaultAgent')
  expect(sent.map((e) => e.command)).not.toContain('issues.create')
  expect(router.replace).toHaveBeenCalledWith(
    `/issue/${encodeURIComponent(start?.input.target?.id ?? '')}`,
  )
})

it('files a task for later through the create, with no start', async () => {
  const sent: Submitted[] = []
  await renderWithMobileStore(<NewIssueScreen />, {
    repos: [repo],
    machines: [machine],
    api: submitApi(sent),
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), {
    target: { value: 'Later' },
  })
  fireEvent.click(screen.getByRole('switch', { name: 'Start work now' }))
  const create = screen.getByRole('button', { name: 'Create task' }) as HTMLButtonElement
  await waitFor(() => expect(create.disabled).toBe(false))
  fireEvent.click(create)

  await waitFor(() => expect(sent.map((e) => e.command)).toContain('issues.create'))
  expect(sent.map((e) => e.command)).not.toContain('effects.create')
})
