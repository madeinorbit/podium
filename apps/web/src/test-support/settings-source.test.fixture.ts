import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { FIXTURE_MACHINE_ID, repositoriesAsCheckouts } from '@podium/client-core/test-support/machine-records'
import { headerEntities } from '@podium/client-graph/header-entities'
import { seedFixtureMachines } from '@podium/client-graph/live-fixture'
import type { MobxPool } from '@podium/client-graph/pool'
import { attachSettingsSource as attachSource, type SettingsOwner } from '@podium/client-graph/settings-source'
import { asMachineId, checkoutRepositoryId, type GitRepositoryWire, type MachineFacts } from '@podium/model'
import { runInAction } from 'mobx'

type Snapshot = { machines?: readonly MachineFacts[]; repos?: readonly GitRepositoryWire[] }
type Owner = Omit<SettingsOwner, 'replica'> & {
  replica?: SettingsOwner['replica']
  getSnapshot?(): object
  subscribe?(listener: () => void): () => void
}

/**
 * Provider-free settings fixtures (POD-6644). A fixture written as a store
 * snapshot with `machines` and `repos` has them delivered as the app receives
 * them: machine records in the pool with their live condition, repository
 * rows as the header source derives them from checkout records, and a replica
 * that answers the checkout and machine records. A publication of the
 * snapshot delivers them again.
 */
export function attachSettingsSource(pool: MobxPool, owner: Owner): void {
  const snapshot = () => (owner.getSnapshot?.() ?? {}) as Snapshot
  const listeners = new Set<(batch: ReplicaAddressedBatch) => void>()
  const records = () => {
    const state = snapshot()
    const repos = (state.repos ?? []).map((repo) => ({ ...repo, machineId: repo.machineId ?? asMachineId(FIXTURE_MACHINE_ID) }))
    return {
      repos,
      checkouts: repositoriesAsCheckouts(repos).map((record) => record.value),
      machines: (state.machines ?? []).map((machine) => ({
        id: machine.id,
        name: machine.name,
        loggedOutHarnesses: machine.loggedOutHarnesses ?? [],
      })),
    }
  }
  const replica =
    owner.replica ??
    ({
      rows: (kind: string) =>
        kind === 'checkouts' ? records().checkouts : kind === 'machines' ? records().machines : [],
      row: (kind: string, id: string) =>
        kind === 'machines' ? records().machines.find((machine) => machine.id === id) : undefined,
      subscribeAddressedBatch(listener: (batch: ReplicaAddressedBatch) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } as unknown as SettingsOwner['replica'])
  const deliver = () =>
    runInAction(() => {
      const { repos } = records()
      const state = snapshot()
      const headers = headerEntities(pool)
      const listed = new Set((state.machines ?? []).map((machine) => String(machine.id)))
      headers.apply([
        ...seedFixtureMachines(pool, state.machines ?? []),
        // A machine the snapshot no longer lists leaves the pool.
        ...[...headers.tables.machine.keys()]
          .filter((id) => !listed.has(id))
          .map((id) => ({ kind: 'machine' as const, id, value: undefined })),
      ] as never)
      headers.order('machine', (state.machines ?? []).map((machine) => machine.id))
      headers.apply(repos.map((repo) => ({ kind: 'repository' as const, id: checkoutRepositoryId(repo), value: repo })) as never)
      headers.order('repository', repos.map((repo) => checkoutRepositoryId(repo)))
    })
  deliver()
  attachSource(pool, { ...owner, replica } as SettingsOwner)
  pool.sources.view('test.settings.records', () => {
    // Only a publication that moved the machines or the repositories delivers.
    let held = { machines: snapshot().machines, repos: snapshot().repos }
    const stop =
      owner.subscribe?.(() => {
        const next = { machines: snapshot().machines, repos: snapshot().repos }
        if (next.machines === held.machines && next.repos === held.repos) return
        const rows = [
          ...(next.machines !== held.machines
            ? [...new Set([...(held.machines ?? []), ...(next.machines ?? [])].map((machine) => String(machine.id)))].map(
                (id) => ({ kind: 'machines' as const, id }),
              )
            : []),
          ...(next.repos !== held.repos ? [{ kind: 'checkouts' as const, id: 'repositories' }] : []),
        ]
        held = next
        deliver()
        for (const listener of [...listeners]) listener({ type: 'update', rows } as never)
      }) ?? (() => {})
    return { dispose: stop }
  })
}
