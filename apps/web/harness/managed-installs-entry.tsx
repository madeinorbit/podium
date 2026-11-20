/** Seven section 8 states, rendered by the product's shared model and real list component. */
import type { MachineModel } from '@podium/client-graph'
import { MachineHarness } from '@podium/client-graph/machine-harness'
import { type AgentInventory, asMachineId, type Inventory } from '@podium/model'
import { observableRef } from 'mobx'
import { createRoot } from 'react-dom/client'
import { MachineHarnesses } from '@/features/settings/machine-harnesses'
import '@/index.css'
import '@/styles.css'

const scene = new URLSearchParams(location.search).get('state') ?? 'managed'
const kind = scene === 'shared' ? 'grok' : 'codex'
const managed = ['managed', 'both', 'shared', 'installing'].includes(scene)
const own = ['own', 'own-too-old', 'both', 'shared'].includes(scene)
const current = kind === 'codex' ? '0.171.0' : '1.0.89'
const agent: AgentInventory = {
  kind,
  installed: managed || own,
  login: { state: 'out' },
  ...(own
    ? {
        path: `/person/bin/${kind}`,
        version: scene === 'own-too-old' ? '0.100.0' : kind === 'codex' ? '0.170.0' : '1.0.80',
      }
    : {}),
  management: {
    installable: scene !== 'shared',
    ...(kind === 'codex' ? { homeVariable: 'CODEX_HOME' } : {}),
  },
  ...(managed
    ? {
        install: {
          ...(own
            ? {
                external: {
                  path: `/person/bin/${kind}`,
                  version: kind === 'codex' ? '0.170.0' : '1.0.80',
                },
              }
            : {}),
          managed: {
            active: {
              path: `/state/harnesses/${kind}/3-${current}/tool`,
              version: current,
              release: 3,
            },
            previousVersion: kind === 'codex' ? '0.169.0' : '1.0.87',
            paused: false,
            lastCheckAt: new Date(Date.now() - 2 * 3600000).toISOString(),
            ...(scene === 'installing' ? { installing: { version: '0.172.0' } } : {}),
          },
        },
      }
    : {}),
}
class FixtureMachine {
  readonly id = asMachineId('fixture-machine')
  readonly name = 'Research machine'
  readonly online = true
  readonly use = 'granted' as const
  @observableRef accessor inventory: Inventory = {
    os: 'linux',
    arch: 'x64',
    agents: [agent],
    tools: [],
  }
  readonly harnessInstalls = [new MachineHarness(this as unknown as MachineModel, kind)]
}
const machine = new FixtureMachine() as unknown as MachineModel
const client = {
  harnessInstalls: { action: { mutate: async () => ({ ok: true, outcome: 'confirmed' }) } },
}
document.documentElement.setAttribute('data-theme', 'podium')
document.documentElement.classList.add('dark')
createRoot(document.getElementById('root')!).render(
  <main className="min-h-screen bg-background p-6 text-foreground sm:p-10">
    <div className="mx-auto max-w-4xl">
      <p className="text-xs text-muted-foreground">Settings / Machines</p>
      <div className="mt-6 flex items-center justify-between">
        <h1 className="text-xl font-medium">Research machine</h1>
        <span className="text-xs text-muted-foreground">● Online</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Linux · x86-64</p>
      <MachineHarnesses machine={machine} client={client} />
    </div>
  </main>,
)
