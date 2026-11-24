/** In-memory machine boundary for phone setup component checks and screenshots. */

import type { MachineModel } from '@podium/client-graph'
import { type AgentSetupOptions, AgentSetupView } from '@podium/client-graph/agent-setup-view'
import { MachineHarness } from '@podium/client-graph/machine-harness'
import {
  type AgentInventory,
  asMachineId,
  BUILTIN_HARNESS_KINDS,
  type BuiltinHarnessKind,
  type Inventory,
  type SessionId,
} from '@podium/model'
import {
  CAP_HARNESS_INSTALL_CANCEL,
  type HarnessActionResult,
  type HarnessInstallAction,
} from '@podium/protocol'
import { observable, observableRef, runInAction } from 'mobx'

export class SetupMachine {
  readonly id = asMachineId('setup-machine')
  readonly name = 'Research machine'
  @observable accessor online = true
  use = 'granted' as const
  readonly serviceAssignment = { server: false, agentExecution: true }
  readonly availability = { epoch: 'fixture', daemon: true, server: false, supervisor: true }
  @observableRef accessor deliveryCaps: readonly string[] = [CAP_HARNESS_INSTALL_CANCEL]
  @observableRef accessor inventory: Inventory | undefined
  readonly harnessInstalls = BUILTIN_HARNESS_KINDS.map(
    (kind) => new MachineHarness(this as unknown as MachineModel, kind),
  )
  constructor(agents = setupAgents()) {
    this.inventory = { os: 'linux', arch: 'x64', tools: [], agents }
  }
  patch(kind: BuiltinHarnessKind, patch: Partial<AgentInventory>) {
    runInAction(() => {
      this.inventory = {
        os: 'linux',
        arch: 'x64',
        tools: [],
        agents: (this.inventory?.agents ?? []).map((agent) =>
          agent.kind === kind ? { ...agent, ...patch } : agent,
        ),
      }
    })
  }
}
export function missing(kind: BuiltinHarnessKind): AgentInventory {
  return {
    kind,
    installed: false,
    login: { state: 'unknown' },
    management: { installable: true, homeVariable: 'AGENT_HOME' },
  }
}
export function installed(kind: BuiltinHarnessKind, login: 'in' | 'out' = 'in'): AgentInventory {
  return {
    ...missing(kind),
    installed: true,
    version: '2.0.0',
    login: { state: login },
    install: {
      external: { path: '/own/agent', version: '1.9.0' },
      managed: {
        paused: false,
        active: { path: '/state/agent', version: '2.0.0', release: 2 },
        previousVersion: '1.9.9',
      },
    },
  }
}
export function setupAgents(): AgentInventory[] {
  return [
    missing('codex'),
    installed('claude-code'),
    {
      ...missing('opencode'),
      install: {
        managed: {
          paused: false,
          installing: {
            version: '1.14.2',
            progress: { phase: 'download', receivedBytes: 31_000_000, totalBytes: 50_000_000 },
          },
        },
      },
    },
    installed('pi', 'out'),
    missing('grok'),
    missing('cursor'),
    {
      ...missing('antigravity'),
      management: { installable: false, reason: 'This agent is not available for this platform.' },
    },
  ]
}
export function setupFixture(
  options: Partial<Pick<AgentSetupOptions, 'origin' | 'focus'>> & {
    agents?: AgentInventory[]
  } = {},
) {
  const machine = new SetupMachine(options.agents)
  const actions: {
    harness: BuiltinHarnessKind
    action: HarnessInstallAction
    resolve: (value: HarnessActionResult) => void
  }[] = []
  const logins: { resolve: (value: { sessionId: SessionId }) => void }[] = []
  const saves: Partial<Record<BuiltinHarnessKind, string>>[] = []
  const client: AgentSetupOptions['client'] = {
    harnessInstalls: {
      action: {
        mutate: (input) => new Promise((resolve) => actions.push({ ...input, resolve })),
      },
    },
    credentials: { login: { mutate: () => new Promise((resolve) => logins.push({ resolve })) } },
  }
  const view = new AgentSetupView({
    machine: machine as unknown as MachineModel,
    client,
    preferences: {
      credentialDefaults: () => ({}),
      saveCredentialDefaults: (next) => {
        saves.push(next)
      },
      savedCredentials: () => [{ id: 'saved-key', label: 'Work key' }],
    },
    origin: options.origin ?? { kind: 'settings' },
    ...(options.focus ? { focus: options.focus } : {}),
  })
  return { machine, view, actions, logins, saves }
}
