import type { AutomationWire } from '@podium/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const create = vi.fn(async () => ({}))
const update = vi.fn(async () => ({}))
const trpc = {
  automations: {
    create: { mutate: create },
    update: { mutate: update },
  },
}

vi.mock('@/app/store', () => {
  const state = () => ({
    trpc,
    repos: [{ path: '/repos/podium', kind: 'repository', branch: 'main', worktrees: [] }],
    sessions: [],
  })
  return {
    useStoreSelector: (selector: (store: ReturnType<typeof state>) => unknown) => selector(state()),
  }
})

const { NewAutomationDialog } = await import('./NewAutomationDialog')

const automation: AutomationWire = {
  id: 'aut_1',
  name: 'Nightly sweep',
  enabled: false,
  repoPath: '/repos/podium',
  scheduleKind: 'cron',
  cron: '*/15 * * * *',
  runAt: null,
  targetSessionId: null,
  agentKind: 'codex',
  model: 'auto',
  effort: 'auto',
  prompt: 'Run the suite.',
  sessionMode: 'resume',
  nextRunAt: null,
  lastRunAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('NewAutomationDialog edit mode', () => {
  it('prefills the exact schedule and updates the existing automation', async () => {
    const onSaved = vi.fn()
    render(
      <NewAutomationDialog
        trpc={
          {
            automations: {
              create: { mutate: create },
              update: { mutate: update },
            },
          } as never
        }
        automation={automation}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    )

    expect(screen.getByText('Edit automation')).toBeTruthy()
    expect(screen.getByDisplayValue('Nightly sweep')).toBeTruthy()
    expect(screen.getByDisplayValue('*/15 * * * *')).toBeTruthy()
    expect(screen.getByDisplayValue('Run the suite.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        id: 'aut_1',
        patch: {
          name: 'Nightly sweep',
          repoPath: '/repos/podium',
          scheduleKind: 'cron',
          cron: '*/15 * * * *',
          runAt: null,
          targetSessionId: null,
          agentKind: 'codex',
          model: 'auto',
          effort: 'auto',
          prompt: 'Run the suite.',
          enabled: false,
          sessionMode: 'resume',
        },
      }),
    )
    expect(create).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalledTimes(1)
  })
  it('prefills and preserves an explicit targeted one-off schedule', async () => {
    const runAt = '2099-07-17T02:00:00.000Z'
    const oneOff: AutomationWire = {
      ...automation,
      id: 'aut_once',
      name: 'Overnight continuation',
      enabled: true,
      scheduleKind: 'once',
      cron: null,
      runAt,
      targetSessionId: 'sess_sleeping',
      prompt: 'Continue overnight.',
      nextRunAt: runAt,
    }
    render(
      <NewAutomationDialog
        trpc={
          {
            automations: {
              create: { mutate: create },
              update: { mutate: update },
            },
          } as never
        }
        automation={oneOff}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    )

    const runAtInput = screen.getByLabelText('Run at') as HTMLInputElement
    expect(new Date(runAtInput.value).toISOString()).toBe(runAt)
    expect(screen.queryByLabelText('Cron expression')).toBeNull()
    expect(screen.getByText('Explicit session target: sess_sleeping')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        id: 'aut_once',
        patch: {
          name: 'Overnight continuation',
          repoPath: '/repos/podium',
          scheduleKind: 'once',
          cron: null,
          runAt,
          targetSessionId: 'sess_sleeping',
          agentKind: 'codex',
          model: 'auto',
          effort: 'auto',
          prompt: 'Continue overnight.',
          enabled: true,
          sessionMode: 'resume',
        },
      }),
    )
  })
})
