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

function stateWithMachines(
  machines: MachineRecord[],
  resolver: AccountState['resolveCodexServerAi'],
  onlineById: Record<string, boolean> = {},
): AccountState {
  return {
    accounts: { list: async () => [] },
    machines: { listMachines: async () => machines },
    machineService: {
      listMachines: async () =>
        machines.map((m) => ({
          ...m,
          online: onlineById[String(m.id)] ?? true,
          inventory: m.inventory,
        })),
      harnessDescriptorsFor: async () => [],
    },
    settings: { apiKeyFor: async () => undefined },
    nativeLogin: { attempt: () => undefined, isRequired: () => false },
    callerUserId: asUserId('viewer-1'),
    resolveCodexServerAi: resolver,
  } as unknown as AccountState
}

function staleHostMachine(): MachineRecord {
  return {
    id: asMachineId('stale-host'),
    name: 'stale-host',
    hostname: 'stale-host',
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
          kind: 'claude-code',
          installed: true,
          login: {
            state: 'in',
            identity: { fingerprint: 'fp-claude-stale', email: 'op@example.com' },
          },
        },
        {
          kind: 'grok',
          installed: true,
          login: {
            state: 'in',
            identity: { fingerprint: 'fp-grok-stale', email: 'grace@example.com' },
          },
        },
      ],
    }),
  }
}

function loggedOutMachine(): MachineRecord {
  return {
    id: asMachineId('pod4604-sbx'),
    name: 'pod4604-sbx',
    hostname: 'pod4604-sbx',
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
          kind: 'claude-code',
          installed: true,
          // Claude credentials file removed: detector reports out. The
          // stale .claude.json email lingers, so identity is still present
          // (as the real daemon reports via loginIdentity).
          login: {
            state: 'out',
            identity: { fingerprint: 'fp-claude-stale', email: 'op@example.com' },
          },
        },
        {
          kind: 'grok',
          installed: true,
          // Grok key expired 2026-09-29 05:19, no refresh token: POD-4803
          // detector reports out, but the auth record still carries an
          // identity (newestRecord does not check expiry).
          login: {
            state: 'out',
            identity: { fingerprint: 'fp-grok-stale', email: 'grace@example.com' },
          },
        },
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

  it('carries the background last-error on the matching row (POD-4805)', async () => {
    const rows = await ACCOUNT_QUERIES.list.run(
      stateWith(async () => ({
        harness: 'codex' as HarnessAgent,
        machineId: asMachineId('desk'),
        machineName: 'Desk',
        lastError: "codex 400: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
      })),
      {},
    )
    const codex = rows.find((row) => row.id === 'native:codex')
    expect(codex?.serverAi).toEqual({
      machineId: asMachineId('desk'),
      machineName: 'Desk',
      lastError: "codex 400: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
    })
  })

  it('carries a machine-less last-error on the matching row when no login is usable', async () => {
    const rows = await ACCOUNT_QUERIES.list.run(
      stateWith(async () => ({
        harness: 'codex' as HarnessAgent,
        lastError: 'no connected Codex login is available to you — run `codex login`.',
      })),
      {},
    )
    const codex = rows.find((row) => row.id === 'native:codex')
    expect(codex?.serverAi).toEqual({
      lastError: 'no connected Codex login is available to you — run `codex login`.',
    })
  })
})

describe('accounts list — logged-out native logins (POD-4832)', () => {
  it('reports a logged-out Claude and an expired Grok as not connected', async () => {
    const rows = await ACCOUNT_QUERIES.list.run(
      stateWithMachines([loggedOutMachine()], async () => undefined),
      {},
    )
    const claude = rows.find((row) => row.id === 'native:claude-code')
    const grok = rows.find((row) => row.id === 'native:grok')
    expect(claude).toBeDefined()
    expect(grok).toBeDefined()
    // The pane says "Claude isn't logged in" and the picker skips both: the
    // hub must agree — one login-state source, not a second copy.
    expect(claude?.status).not.toBe('connected')
    expect(grok?.status).not.toBe('connected')
  })

  it('ignores a stale offline login when no online machine reports it', async () => {
    // POD-4604 re-check: pod4604-sbx is online with Claude logged out and
    // Grok expired (out), while a stale host still carries an old in report
    // but is offline. The picker (online + login in) skips both and starts
    // Codex; the hub must agree, not stay connected from the offline row.
    const rows = await ACCOUNT_QUERIES.list.run(
      stateWithMachines([staleHostMachine(), loggedOutMachine()], async () => undefined, {
        'stale-host': false,
        'pod4604-sbx': true,
      }),
      {},
    )
    const claude = rows.find((row) => row.id === 'native:claude-code')
    const grok = rows.find((row) => row.id === 'native:grok')
    expect(claude?.status).not.toBe('connected')
    expect(grok?.status).not.toBe('connected')
    // Login candidates are online + installed (the sandbox), matching the
    // reported loginMachines [pod4604-sbx] — but status must not be connected.
    expect(claude?.loginMachines?.map((m) => String(m.id))).toEqual(['pod4604-sbx'])
  })
})
