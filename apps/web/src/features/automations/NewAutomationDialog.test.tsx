import { type AutomationWire, asAutomationId, asSessionId } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { observable, runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/test-support/model-catalog-mock'

const create = vi.fn(async () => ({}))
const update = vi.fn(async () => ({}))
vi.mock('@/app/automation-readers', () => ({
  useAutomationTargets: () => ({
    ids: ['podium'],
    excluded: { unauthorized: 0, unreachable: 0, incapable: 0, disabled: 0, degraded: 0 }, pending: 0,
  }),
  useAutomationTarget: () => ({ value: '/repos/podium', label: 'podium', availability: 'available' }),
  useAutomationTargetForPath: () => ({ value: '/repos/podium', label: 'podium', availability: 'available' }),
  useAutomationTargetMachine: () => undefined,
}))

const { NewAutomationDialogBody: NewAutomationDialog } = await import('./NewAutomationDialog')

const automation: AutomationWire = {
  id: asAutomationId('aut_1'),
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
  it('keeps untouched inputs live, discards to live and submits only changed fields', async () => {
    const record = observable({ ...automation })
    render(<NewAutomationDialog trpc={{ automations: { create: { mutate: create }, update: { mutate: update } } } as never}
      automation={record} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByDisplayValue('Nightly sweep'), { target: { value: 'Local sweep' } })
    act(() => runInAction(() => { record.name = 'Remote sweep'; record.prompt = 'Remote prompt'; record.cron = '*/5 * * * *' }))
    expect(await screen.findByDisplayValue('Remote prompt')).toBeTruthy()
    expect(screen.getByDisplayValue('*/5 * * * *')).toBeTruthy()
    expect(screen.getByDisplayValue('Local sweep')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByDisplayValue('Remote sweep')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
    fireEvent.change(screen.getByDisplayValue('Remote sweep'), { target: { value: 'Saved sweep' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith({ id: record.id, patch: { name: 'Saved sweep' } }))
  })
  it('prefills the exact schedule and skips an unchanged save', async () => {
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

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(update).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalledTimes(1)
  })
  it('prefills and preserves an explicit targeted one-off schedule', async () => {
    const runAt = '2099-07-17T02:00:00.000Z'
    const oneOff: AutomationWire = {
      ...automation,
      id: asAutomationId('aut_once'),
      name: 'Overnight continuation',
      enabled: true,
      scheduleKind: 'once',
      cron: null,
      runAt,
      targetSessionId: asSessionId('sess_sleeping'),
      prompt: 'Continue overnight.',
      nextRunAt: runAt,
    }
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
        automation={oneOff}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    )

    const runAtInput = screen.getByLabelText('Run at') as HTMLInputElement
    expect(new Date(runAtInput.value).toISOString()).toBe(runAt)
    expect(screen.queryByLabelText('Cron expression')).toBeNull()
    expect(screen.getByText('Explicit session target: sess_sleeping')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(update).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
})
