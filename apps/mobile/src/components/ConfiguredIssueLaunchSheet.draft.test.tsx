import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { observable, runInAction } from 'mobx'
import { createElement, type ReactNode, useLayoutEffect } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { LaunchConfiguration, LaunchPlan } from '../lib/launch-configuration'

const api = vi.hoisted(() => ({
  issues: {
    update: { mutate: vi.fn(async () => {}) },
    addSession: { mutate: vi.fn(async () => {}) },
    start: { mutate: vi.fn(async () => {}) },
  },
}))
// The spawn is the task's effect record (POD-6526): begin or add, never the routes.
const startIssueSession = vi.hoisted(() =>
  vi.fn((_args: unknown) => ({ settled: Promise.resolve(true) })),
)
// My coding default is my synced settings record (POD-6673).
vi.mock('../client/my-preferences', () => ({ useMyCodingHarness: () => 'codex' }))
vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<typeof import('@podium/client-core/react')>()),
  useCommands: () => ({ sessions: { startIssueSession } }),
}))
vi.mock('../client/hooks', () => ({ useTrpc: () => api }))
vi.mock('./PressableScale', () => ({
  PressableScale: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children: ReactNode
    onPress: () => void
    disabled: boolean
    accessibilityLabel: string
  }) =>
    createElement(
      'button',
      { type: 'button', onClick: onPress, disabled, 'aria-label': accessibilityLabel },
      children,
    ),
}))
vi.mock('./LaunchConfigurationFields', () => ({
  LaunchConfigurationFields: ({
    value,
    onChange,
    onPlan,
  }: {
    value: LaunchConfiguration
    onChange: (next: LaunchConfiguration) => void
    onPlan: (plan: LaunchPlan) => void
  }) => {
    useLayoutEffect(() => onPlan({ configuration: value }), [value, onPlan])
    return createElement(
      'div',
      null,
      createElement('span', null, `${value.modelPick} / ${value.effort}`),
      createElement(
        'button',
        { type: 'button', onClick: () => onChange({ ...value, effort: 'high' }) },
        'Choose high',
      ),
    )
  },
}))

import { ConfiguredIssueLaunchSheet } from './ConfiguredIssueLaunchSheet'

it('starts proposed work through the shared launch path after saving the native sheet draft', async () => {
  const record = observable({
    id: 'iss_proposed',
    title: 'Proposed task',
    prefix: 'POD',
    seq: 3,
    repoPath: '/repo',
    defaultAgent: 'codex',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    machineId: null,
  })
  const close = vi.fn()
  render(<ConfiguredIssueLaunchSheet issue={record as never} onClose={close} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose high' }))
  fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
  // One record starts it: upstream's default mode begins a never-started issue.
  await waitFor(() =>
    expect(startIssueSession).toHaveBeenCalledExactlyOnceWith({ issueId: record.id }),
  )
  expect(api.issues.start.mutate).not.toHaveBeenCalled()
  expect(api.issues.update.mutate.mock.invocationCallOrder[0]).toBeLessThan(
    startIssueSession.mock.invocationCallOrder[0]!,
  )
  expect(close).toHaveBeenCalledOnce()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
it('uses Settings for auto and saves a harness pin before spawning an effort override', async () => {
  const record = observable({
    id: 'iss_auto',
    title: 'Auto task',
    prefix: 'POD',
    seq: 2,
    repoPath: '/repo',
    defaultAgent: 'auto',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    machineId: null,
  })
  render(<ConfiguredIssueLaunchSheet issue={record as never} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Choose high' }))
  fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
  await waitFor(() => expect(startIssueSession).toHaveBeenCalledWith({ issueId: record.id }))
  expect(api.issues.addSession.mutate).not.toHaveBeenCalled()
  expect(api.issues.update.mutate).toHaveBeenCalledExactlyOnceWith({
    id: record.id,
    patch: { defaultAgent: 'codex', defaultEffort: 'high' },
  })
})
it('keeps untouched launch values live, drops edits on reopen and saves only touched fields before spawning', async () => {
  const record = observable({
    id: 'iss_draft',
    title: 'Draft task',
    prefix: 'POD',
    seq: 1,
    repoPath: '/repo',
    defaultAgent: 'codex',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    machineId: null,
  })
  const close = vi.fn()
  const view = render(<ConfiguredIssueLaunchSheet issue={record as never} onClose={close} />)
  expect((screen.getByRole('button', { name: 'Start agent' }) as HTMLButtonElement).disabled).toBe(
    false,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Choose high' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose high' }))
  expect((screen.getByRole('button', { name: 'Start agent' }) as HTMLButtonElement).disabled).toBe(
    false,
  )
  act(() =>
    runInAction(() => {
      record.defaultModel = 'gpt-6.1-sol'
    }),
  )
  expect(await screen.findByText('codex:gpt-6.1-sol / high')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(close).toHaveBeenCalledTimes(1)
  view.rerender(<ConfiguredIssueLaunchSheet issue={null} onClose={close} />)
  view.rerender(<ConfiguredIssueLaunchSheet issue={record as never} onClose={close} />)
  expect(screen.getByText('codex:gpt-6.1-sol / auto')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Choose high' }))
  fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
  await waitFor(() =>
    expect(startIssueSession).toHaveBeenCalledExactlyOnceWith({ issueId: record.id }),
  )
  expect(api.issues.update.mutate).toHaveBeenCalledExactlyOnceWith({
    id: record.id,
    patch: { defaultEffort: 'high' },
  })
  expect(api.issues.update.mutate.mock.invocationCallOrder[0]).toBeLessThan(
    startIssueSession.mock.invocationCallOrder[0]!,
  )
})
