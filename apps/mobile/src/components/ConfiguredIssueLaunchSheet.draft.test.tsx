import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { observable, runInAction } from 'mobx'
import { createElement, useLayoutEffect, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { LaunchConfiguration, LaunchPlan } from '../lib/launch-configuration'

const api = vi.hoisted(() => ({ issues: {
  update: { mutate: vi.fn(async () => {}) },
  addSession: { mutate: vi.fn(async () => {}) },
  start: { mutate: vi.fn(async () => {}) },
} }))
vi.mock('../client/hooks', () => ({ useTrpc: () => api }))
vi.mock('./BottomSheet', () => ({ BottomSheet: ({ children, footer, visible }: { children: ReactNode; footer: ReactNode; visible: boolean }) =>
  visible ? createElement('div', null, children, footer) : null }))
vi.mock('./PressableScale', () => ({ PressableScale: ({ children, onPress, disabled, accessibilityLabel }: {
  children: ReactNode; onPress: () => void; disabled: boolean; accessibilityLabel: string
}) => createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children) }))
vi.mock('./LaunchConfigurationFields', () => ({ LaunchConfigurationFields: ({ value, onChange, onPlan }: {
  value: LaunchConfiguration; onChange: (next: LaunchConfiguration) => void; onPlan: (plan: LaunchPlan) => void
}) => {
  useLayoutEffect(() => onPlan({ configuration: value }), [value, onPlan])
  return createElement('div', null,
    createElement('span', null, `${value.modelPick} / ${value.effort}`),
    createElement('button', { onClick: () => onChange({ ...value, effort: 'high' }) }, 'Choose high'))
} }))
import { ConfiguredIssueLaunchSheet } from './ConfiguredIssueLaunchSheet'

afterEach(() => { cleanup(); vi.clearAllMocks() })
it('keeps untouched launch values live, drops edits on reopen and saves only touched fields before spawning', async () => {
  const record = observable({ id: 'iss_draft', title: 'Draft task', prefix: 'POD', seq: 1, repoPath: '/repo',
    defaultAgent: 'codex', defaultModel: 'auto', defaultEffort: 'auto', machineId: null })
  const close = vi.fn()
  const view = render(<ConfiguredIssueLaunchSheet issue={record as never} onClose={close} />)
  expect((screen.getByRole('button', { name: 'Start agent' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Choose high' }))
  act(() => runInAction(() => { record.defaultModel = 'gpt-6.1-sol' }))
  expect(await screen.findByText('codex:gpt-6.1-sol / high')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(close).toHaveBeenCalledTimes(1)
  view.rerender(<ConfiguredIssueLaunchSheet issue={null} onClose={close} />)
  view.rerender(<ConfiguredIssueLaunchSheet issue={record as never} onClose={close} />)
  expect(screen.getByText('codex:gpt-6.1-sol / auto')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Choose high' }))
  fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
  await waitFor(() => expect(api.issues.addSession.mutate).toHaveBeenCalledExactlyOnceWith({ id: record.id }))
  expect(api.issues.update.mutate).toHaveBeenCalledExactlyOnceWith({ id: record.id, patch: { defaultEffort: 'high' } })
  expect(api.issues.update.mutate.mock.invocationCallOrder[0]).toBeLessThan(api.issues.addSession.mutate.mock.invocationCallOrder[0]!)
})
