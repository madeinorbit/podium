/** Isolated machine records for the shipping first-run screens. No live requests. */
import '@podium/client-graph/synced-models'
import { seedFixtureMachines } from '@podium/client-graph/live-fixture'
import { MobxPool } from '@podium/client-graph/pool'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import {
  type AgentInventory,
  asMachineId,
  asUserId,
  BUILTIN_HARNESS_KINDS,
  resolveUserPreferences,
} from '@podium/model'
import { observable, runInAction } from 'mobx'
import { useMemo, useSyncExternalStore } from 'react'

const scene = new URLSearchParams(location.search).get('scene') ?? 'missing'
const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
const machine = {
  id: asMachineId('setup-machine'),
  name: 'Project server',
  hostname: 'project-server.example.com',
  online: true,
  serviceAssignment: { server: true, agentExecution: true },
  availability: { epoch: 'setup-boot', server: true, daemon: true, supervisor: true },
  lastSeenAt: new Date(0).toISOString(),
  inventory: {
    os: 'linux' as const,
    arch: 'x64' as const,
    agents: BUILTIN_HARNESS_KINDS.map(
      (kind): AgentInventory => ({
        kind,
        installed: scene === 'installed' && kind === 'codex',
        login: { state: 'out' },
        management: { installable: true },
      }),
    ),
    tools: [],
  },
}
function publishMachine() {
  pool.apply({ type: 'update', rows: seedFixtureMachines(pool, [structuredClone(machine)]) })
}
publishMachine()
pool.apply({
  type: 'update',
  rows: [
    {
      kind: 'userPreferences',
      id: 'demo',
      value: { ...resolveUserPreferences(undefined, asUserId('demo')), id: 'demo' } as never,
    },
  ],
})
const repo = {
  path: '/workspace/project',
  kind: 'repository' as const,
  branch: 'main',
  worktrees: [],
  machineId: machine.id,
}
const values = observable.map<string, string | null>()
const uiState = {
  get: (key: string) => values.get(key) ?? null,
  set: (key: string, value: string | null) => runInAction(() => values.set(key, value)),
}
pool.sources.register(['settingsCatalog', 'settingsRepository', 'preference'], {
  read(entity, id) {
    if (entity === 'settingsCatalog') return { machines: [machine.id], repositories: [repo.path] }
    if (entity === 'settingsRepository') return repo
    if (entity === 'preference') return { value: uiState.get(id) }
    return undefined
  },
  dispose() {},
})
const trpc = {
  credentials: { list: { query: async () => [] } },
  harnessInstalls: {
    action: {
      async mutate({ harness }: { harness: string }) {
        const agent = machine.inventory.agents.find((agent) => agent.kind === harness)
        if (!agent) throw new Error('Unknown harness')
        agent.install = { managed: { paused: false, installing: { version: '1.0.0' } } }
        publishMachine()
        await new Promise((resolve) => setTimeout(resolve, 500))
        agent.installed = true
        agent.install = {
          managed: {
            paused: false,
            active: { path: `/state/harnesses/${harness}/1/tool`, version: '1.0.0', release: 1 },
          },
        }
        publishMachine()
        return { ok: true, outcome: 'confirmed' }
      },
    },
  },
}
export const useSettingsClient = () => ({ trpc, uiState }) as never
export const useSettingsTrpc = () => trpc as never
export const useRequestClient = useSettingsTrpc
export const useWorklistPool = () => pool
export function useWorklistPoolProjection<T>(read: (pool: MobxPool) => T) {
  const projection = useMemo(() => createPoolProjection(pool, read), [read])
  return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
}
export const useHarnessDescriptors = () => ({ served: undefined, status: 'unavailable' })

export const useClientRuntime = () => ({})
export const useCommands = () => ({ sessions: {}, preferences: {}, instancePreferences: {} })
export const useDeviceState = () => uiState
export const useUi = () => ({})
