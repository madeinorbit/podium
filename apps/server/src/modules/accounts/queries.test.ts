import { asMachineId, asUserId, type HarnessAgent, Inventory } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { MachineRecord } from '../../store/types'
import { ACCOUNT_QUERIES } from './queries'
import type { AccountState } from './registry'

function codexMachine(id = 'desk'): MachineRecord {
  return {
    id: asMachineId(id),
    name: 'Desk',
    hostname: id,
    revokedAt: null,
    createdAt: '2026-08-06T00:00:00.000Z',
    lastSeenAt: '2026-08-06T00:00:00.000Z',
    podiumManaged: true,
    updateChannelOverride: null,
    appVersion: null,
    wireSchemaDigest: null,
    installKind: null,
    deliveryCaps: [],
    presenceSource: null,
    assignmentEvidence: null,
    availability: null,
    serviceAssignment: { server: false, agentExecution: true },
    serviceReport: null,
    buildReportedAt: null,
    components: ['daemon'],
    inventory: Inventory.parse({
      os: 'linux',
      arch: 'x64',
      agents: [
        {
          kind: 'codex',
          installed: true,
          login: {
            state: 'in',
            identity: { fingerprint: 'fp-codex-1', email: 'user@example.com' },
          },
        },
      ],
    }),
  }
}

function stateWith(resolver: AccountState['resolveCodexServerAi']): AccountState {
  const machines = [codexMachine()]
  return {
    accounts: { list: async () => [] },
    machines: { listMachines: async () => machines },
    machineService: {
      listMachines: async () => machines,
      harnessDescriptorsFor: async () => [],
    },
    settings: { apiKeyFor: async () => undefined },
    nativeLogin: { attempt: () => undefined, isRequired: () => false },
    callerUserId: asUserId('viewer-1'),
    resolveCodexServerAi: resolver,
  } as unknown as AccountState
}

describe('accounts list — server-AI login marker (POD-4750)', () => {
  it('marks the row whose harness the viewer background role runs on', async () => {
    const rows = await ACCOUNT_QUERIES.list.run(
      stateWith(async () => ({
        harness: 'codex' as HarnessAgent,
        machineId: asMachineId('desk'),
        machineName: 'Desk',
      })),
      {},
    )
    const codex = rows.find((row) => row.id === 'native:codex')
    expect(codex).toBeDefined()
    expect(codex?.serverAi).toEqual({ machineId: asMachineId('desk'), machineName: 'Desk' })
  })

  it('marks no codex row when the role harness names a different login', async () => {
    const rows = await ACCOUNT_QUERIES.list.run(
      stateWith(async () => ({
        harness: 'claude-code' as HarnessAgent,
        machineId: asMachineId('desk'),
        machineName: 'Desk',
      })),
      {},
    )
    const codex = rows.find((row) => row.id === 'native:codex')
    expect(codex).toBeDefined()
    expect(codex?.serverAi).toBeUndefined()
  })

  it('omits the marker when no login is usable for the viewer (no invention)', async () => {
    const rows = await ACCOUNT_QUERIES.list.run(stateWith(async () => undefined), {})
    const codex = rows.find((row) => row.id === 'native:codex')
    expect(codex).toBeDefined()
    expect(codex?.serverAi).toBeUndefined()
  })

  it('omits the marker when no resolver is assembled (legacy test states)', async () => {
    const state = stateWith(undefined)
    const rows = await ACCOUNT_QUERIES.list.run(state, {})
    const codex = rows.find((row) => row.id === 'native:codex')
    expect(codex).toBeDefined()
    expect(codex?.serverAi).toBeUndefined()
  })
})
