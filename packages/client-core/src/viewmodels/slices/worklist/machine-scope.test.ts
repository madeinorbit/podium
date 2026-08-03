import type { GitRepositoryWire, MachineWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { reposVisibleOnMachines } from './machine-scope'

const machine = (id: string): MachineWire => ({
  id: id as MachineWire['id'],
  name: id,
  hostname: id,
  online: true,
  lastSeenAt: '2026-08-01T12:00:00.000Z',
})

const repo = (path: string, machineId?: string): GitRepositoryWire =>
  ({
    path,
    kind: 'repository',
    ...(machineId ? { machineId } : {}),
    worktrees: [],
  }) as GitRepositoryWire

describe('reposVisibleOnMachines — the repo tree inherits machine SEE', () => {
  it('drops repos on machines the principal cannot see', () => {
    const out = reposVisibleOnMachines(
      [repo('/mine/podium', 'mine'), repo('/theirs/podium', 'theirs')],
      [machine('mine')],
    )
    expect(out.map((r) => r.path)).toEqual(['/mine/podium'])
  })

  // --- the two parity hinges -------------------------------------------------

  it('keeps a repo row that carries no machineId at all', () => {
    // Absence is NOT denial: pre-field rows and local registrations the server
    // never stamped. Dropping these would empty the sidebar on the deployments
    // that have no scoping to enforce in the first place.
    const out = reposVisibleOnMachines([repo('/local/podium')], [machine('mine')])
    expect(out.map((r) => r.path)).toEqual(['/local/podium'])
  })

  it('is inert while the machine list is still empty', () => {
    // A client that has not yet received `machinesChanged` holds an empty list.
    // Blanking the sidebar during boot is worse than showing a repo a moment early.
    const repos = [repo('/mine/podium', 'mine'), repo('/theirs/podium', 'theirs')]
    expect(reposVisibleOnMachines(repos, []).map((r) => r.path)).toEqual([
      '/mine/podium',
      '/theirs/podium',
    ])
  })

  it('is inert when the store carries no machine list at all', () => {
    // Not merely empty — ABSENT. Fixtures and partial stores predate this pass
    // and must not have their repo tree emptied by scoping they never opted into.
    const repos = [repo('/mine/podium', 'mine'), repo('/theirs/podium', 'theirs')]
    expect(reposVisibleOnMachines(repos, undefined).map((r) => r.path)).toEqual([
      '/mine/podium',
      '/theirs/podium',
    ])
  })

  it('leaves an all-visible list structurally untouched', () => {
    // Single-user parity: with one admin owning everything, nothing is filtered
    // and no row is needlessly cloned.
    const repos = [repo('/a', 'mine'), repo('/b', 'mine')]
    const out = reposVisibleOnMachines(repos, [machine('mine')])
    expect(out[0]).toBe(repos[0])
    expect(out[1]).toBe(repos[1])
  })
})
