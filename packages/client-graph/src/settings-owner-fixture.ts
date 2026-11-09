/**
 * TESTS ONLY: a settings source owner over a replica that answers checkout and
 * machine records (POD-6644). Tests give the repositories and machines in the
 * listing shape; `setRepos` and `setMachines` move them and announce the
 * change the way the replica's addressed batch does.
 */
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import {
  FIXTURE_MACHINE_ID,
  machineRecords,
  repositoriesAsCheckouts,
} from '@podium/client-core/test-support/machine-records'
import type { GitRepositoryWire, MachineFacts } from '@podium/model'
import { headerEntities } from './header-entities'
import { seedFixtureMachines } from './live-fixture'
import type { MobxPool } from './pool'
import type { SettingsOwner } from './settings-source'

type Repo = Pick<GitRepositoryWire, 'path' | 'kind'> & Partial<GitRepositoryWire>
type Machine = { readonly id: string } & Record<string, unknown>

/** The machine a repository without one lands on: mine, online, running agents. */
const DEFAULT_MACHINE: Machine = {
  id: FIXTURE_MACHINE_ID,
  name: 'Synthetic machine',
  hostname: 'synthetic',
  online: true,
  lastSeenAt: '2026-10-05T07:00:00Z',
  use: 'granted',
  availability: { daemon: true, server: false, supervisor: false, epoch: 'fixture' },
  serviceAssignment: { server: false, agentExecution: true },
}

export function settingsOwnerFixture(input: {
  repos?: readonly Repo[]
  machines?: readonly Machine[]
  userId?: string
  settingsTab?: () => unknown
}) {
  const userId = input.userId ?? 'operator'
  let checkouts: readonly Record<string, unknown>[] = []
  let machines = new Map<string, Record<string, unknown>>()
  let access: readonly Record<string, unknown>[] = []
  const listeners = new Set<(batch: ReplicaAddressedBatch) => void>()
  const setRepos = (repos: readonly Repo[]) => {
    checkouts = repositoriesAsCheckouts(repos).map((record) => record.value)
  }
  const setMachines = (list: readonly Machine[]) => {
    const records = list.flatMap((machine) => machineRecords(userId, machine))
    machines = new Map(
      records.filter((record) => record.entity === 'machine').map((record) => [record.entityId, record.value]),
    )
    access = records.filter((record) => record.entity === 'machineAccess').map((record) => record.value)
  }
  const given = input.machines ?? []
  const listed = [
    ...given,
    ...((input.repos ?? []).some((repo) => !repo.machineId) && !given.some((m) => m.id === FIXTURE_MACHINE_ID)
      ? [DEFAULT_MACHINE]
      : []),
  ]
  setRepos(input.repos ?? [])
  setMachines(listed)
  const announce = (kind: 'checkouts' | 'machines', id: string) => {
    for (const listener of [...listeners]) listener({ type: 'update', rows: [{ kind, id }] })
  }
  const owner = {
    readLocal: () => input.settingsTab?.() ?? 'sessions',
    onLocals: () => () => {},
    replica: {
      rows: (kind: string) =>
        kind === 'checkouts'
          ? checkouts
          : kind === 'machines'
            ? [...machines.values()]
            : kind === 'machineAccess'
              ? access
              : [],
      row: (kind: string, id: string) => (kind === 'machines' ? machines.get(id) : undefined),
      subscribeAddressedBatch(listener: (batch: ReplicaAddressedBatch) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  } as unknown as SettingsOwner
  return {
    owner,
    listeners,
    /** Put the machines in `pool` as the row source would: records, and online on the LiveStore. */
    seed(pool: MobxPool) {
      headerEntities(pool).apply(seedFixtureMachines(pool, listed as unknown as MachineFacts[]) as never)
      headerEntities(pool).order('machine', listed.map((machine) => machine.id))
    },
    /** Replace the repositories; announced as one checkout change. */
    setRepos(repos: readonly Repo[], changedPath = repos[0]?.path ?? '') {
      setRepos(repos)
      announce('checkouts', changedPath)
    },
    /** Replace the machines; announced per machine. */
    setMachines(list: readonly Machine[]) {
      setMachines(list)
      for (const machine of list) announce('machines', machine.id)
    },
  }
}
