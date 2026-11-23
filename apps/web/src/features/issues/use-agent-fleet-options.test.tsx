// @vitest-environment happy-dom
import type { MachineFacts } from '@podium/model'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAgentFleet } from './use-agent-fleet-options'

const fixture = vi.hoisted(() => ({ machines: [] as MachineFacts[] }))
vi.mock('@/app/header-data', () => ({
  usePoolMachines: () => fixture.machines,
  usePoolRepositories: () => [
    { path: '/repo', repoId: 'repo', machineId: 'a', kind: 'repository', worktrees: [] },
    { path: '/build/repo', repoId: 'repo', machineId: 'b', kind: 'repository', worktrees: [] },
  ],
}))
afterEach(() => {
  cleanup()
  fixture.machines = []
})
const machine = (id: string, installed: boolean) =>
  ({
    id,
    name: id,
    online: true,
    serviceAssignment: { server: false, agentExecution: true },
    availability: { daemon: true },
    inventory: {
      agents: [
        { kind: 'codex', installed, login: { state: 'in' } },
        { kind: 'pi', installed: true, login: { state: 'out' } },
      ],
    },
  }) as unknown as MachineFacts

it('uses the issue’s pinned machine even when another repository host has the harness', () => {
  fixture.machines = [machine('a', false), machine('b', true)]
  const pinned = renderHook(() => useAgentFleet({ repoPath: '/repo', machineId: 'a' as never }))
    .result.current
  expect(pinned.options.find((option) => option.value === 'codex')?.status.hidden).toBe(true)
  expect(pinned.options.find((option) => option.value === 'pi')?.status.hint).toBe('signed out')
  expect(pinned.machines.map((host) => host.id)).toEqual(['a'])
  const fleet = renderHook(() => useAgentFleet({ repoPath: '/repo' })).result.current
  expect(fleet.options.find((option) => option.value === 'codex')?.status.hidden).toBeUndefined()
})

it('keeps offline and unknown inventory choices visible', () => {
  fixture.machines = [{ ...machine('a', false), online: false }]
  const offline = renderHook(() => useAgentFleet({ repoPath: '/repo' })).result.current
  expect(offline.options.find((option) => option.value === 'codex')?.status.hint).toBe('offline')
  fixture.machines = [{ ...machine('a', false), inventory: undefined }]
  const unknown = renderHook(() => useAgentFleet({ repoPath: '/repo' })).result.current
  expect(unknown.options.find((option) => option.value === 'codex')?.status).toEqual({})
})

it('keeps an unknown repository unrefused and can plan a global automation across the fleet', () => {
  fixture.machines = [machine('a', false)]
  const unknown = renderHook(() => useAgentFleet({ repoPath: '/not-loaded' })).result.current
  expect(unknown.options.find((option) => option.value === 'codex')?.status).toEqual({})
  expect(unknown.machines).toEqual([])
  expect(unknown.setupMachines.map((host) => host.id)).toEqual(['a'])
  const global = renderHook(() => useAgentFleet({}, true)).result.current
  expect(global.options.find((option) => option.value === 'codex')?.status.hidden).toBe(true)
})
