import { fullDevice } from '@podium/client-graph/full-device-fixture'
/** Shipping presence badge and action gate, backed by a real pool and live readings. */
import '@podium/client-graph/synced-models'
import { liveFixture } from '@podium/client-graph/live-fixture'
import { requireHere } from '@podium/client-graph/lookup'
import { MobxPool } from '@podium/client-graph/pool'
import { observer } from 'mobx-react-lite'
import { createRoot } from 'react-dom/client'
import { Button } from '@/components/ui/button'
import { MachineStatus } from '@/features/settings/machine-status'
import { SettingsMachine } from '@/features/settings/machine-view'
import '@/index.css'
import '@/styles.css'

document.documentElement.setAttribute('data-theme', 'podium')
const pool = fullDevice(new MobxPool({ selectedIssueId: null, coarseNow: 0 }))
pool.apply({
  type: 'update',
  rows: [
    {
      kind: 'machine',
      id: 'fixture-machine',
      value: {
        id: 'fixture-machine',
        name: 'Build machine',
        use: 'granted',
        transferable: true,
        loggedOutHarnesses: [],
        serviceAssignment: { server: false, agentExecution: true },
        services: {
          server: { policy: 'disabled', state: 'stopped' },
          agentExecution: { policy: 'enabled', state: 'available' },
        },
      } as never,
    },
  ],
})
const state = new URLSearchParams(location.search).get('presence') ?? 'online'
const live = liveFixture(pool)
live.condition('fixture-machine', {
  online: state !== 'offline',
  since: null,
  lastSeenAt: new Date(Date.now() - 120_000).toISOString(),
  availability: { epoch: 'fixture', daemon: true, supervisor: true, server: false },
})
if (state === 'reconnecting') live.lost(Date.now())
const view = new SettingsMachine(requireHere(pool.model('machine', 'fixture-machine')))
const Harness = observer(function Harness() {
  return (
    <main className="mx-auto max-w-4xl px-10 py-12">
      <h1 className="settings-page-title">Machines</h1>
      <p className="settings-prose mt-2 mb-8">
        Machines that host your projects and agent sessions.
      </p>
      <div className="flex items-center justify-between gap-6 rounded-lg border border-border p-5">
        <div className="min-w-0">
          <h2 className="settings-label">{view.machine.name}</h2>
          <p className="settings-prose mt-1 text-muted-foreground">Looked after by you</p>
        </div>
        <MachineStatus view={view} />
      </div>
      <div className="mt-5 flex justify-end">
        <Button variant="outline" disabled={!view.canFindRepositories}>
          Find repositories
        </Button>
      </div>
    </main>
  )
})
createRoot(document.getElementById('root')!).render(<Harness />)
