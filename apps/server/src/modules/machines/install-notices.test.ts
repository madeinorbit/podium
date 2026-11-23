/**
 * Notices about Podium-installed harnesses (POD-7281, managed installs §8):
 * one per harness and machine when updates have failed for three days, one per
 * machine when its install ledger was rebuilt, nothing on success.
 */
import {
  type AgentInventory,
  asMachineId,
  asUserId,
  type Inventory,
  Inventory as InventorySchema,
  type UserId,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { EmitNoticeInput } from '../notices/emit'
import {
  failingNoticeKey,
  INSTALL_FAILING_NOTICE_MS,
  planInstallNotices,
  raiseInstallNotices,
  rebuiltNoticeKey,
} from './install-notices'

const MACHINE = asMachineId('mch_one')
const OWNER = asUserId('usr_owner')
const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

type Install = NonNullable<AgentInventory['install']>

function agent(kind: string, install?: Install): AgentInventory {
  return {
    kind,
    installed: true,
    login: { state: 'in' },
    ...(install ? { install } : {}),
  } as AgentInventory
}

/** A report as the wire carries it: parsed by the schema the store reads it back with. */
function inventory(...agents: AgentInventory[]): Inventory {
  return InventorySchema.parse({ os: 'linux', arch: 'x64', agents, tools: [] })
}

const managed = (extra: Partial<NonNullable<Install['managed']>> = {}): Install => ({
  managed: { paused: false, ...extra },
})

const failingFor = (ms: number, message = 'vendor unreachable'): Install =>
  managed({ failingSince: iso(NOW - ms), lastError: { at: iso(NOW), message } })

describe('planInstallNotices', () => {
  it('raises nothing for a harness that updates fine, or fails for less than three days', () => {
    expect(
      planInstallNotices(MACHINE, undefined, inventory(agent('grok', managed())), NOW),
    ).toEqual({ emit: [], resolve: [] })
    expect(
      planInstallNotices(
        MACHINE,
        undefined,
        inventory(agent('grok', failingFor(INSTALL_FAILING_NOTICE_MS - 60_000))),
        NOW,
      ),
    ).toEqual({ emit: [], resolve: [] })
  })

  it('raises one notice per harness once its failing run is three days old', () => {
    const plan = planInstallNotices(
      MACHINE,
      undefined,
      inventory(
        agent('grok', failingFor(INSTALL_FAILING_NOTICE_MS, 'checksum mismatch')),
        agent('claude-code', failingFor(INSTALL_FAILING_NOTICE_MS + 1)),
        agent('codex'),
      ),
      NOW,
    )
    expect(plan.emit).toEqual([
      { kind: 'harness-install-failing', harness: 'grok', error: 'checksum mismatch' },
      { kind: 'harness-install-failing', harness: 'claude-code', error: 'vendor unreachable' },
    ])
    expect(plan.resolve).toEqual([])
  })

  it('resolves the notice when the failing run ends or the harness stops being managed', () => {
    const before = inventory(
      agent('grok', failingFor(INSTALL_FAILING_NOTICE_MS)),
      agent('opencode', failingFor(INSTALL_FAILING_NOTICE_MS)),
    )
    const plan = planInstallNotices(
      MACHINE,
      before,
      inventory(agent('grok', managed()), agent('opencode')),
      NOW,
    )
    expect(plan).toEqual({
      emit: [],
      resolve: [failingNoticeKey(MACHINE, 'grok'), failingNoticeKey(MACHINE, 'opencode')],
    })
  })

  it('raises a rebuilt ledger once, by the rebuild it names', () => {
    const rebuilt = {
      ...managed(),
      ledgerRebuilt: { at: '2026-11-19T08:00:00.000Z', reason: 'damaged' as const },
    }
    const first = inventory(agent('grok', rebuilt), agent('codex', rebuilt))
    expect(planInstallNotices(MACHINE, undefined, first, NOW).emit).toEqual([
      { kind: 'harness-ledger-rebuilt', at: '2026-11-19T08:00:00.000Z', reason: 'damaged' },
    ])
    // The next report still carries the flag: nothing new.
    expect(planInstallNotices(MACHINE, first, first, NOW).emit).toEqual([])
    // A later rebuild is a new notice.
    const again = inventory(
      agent('grok', {
        ...managed(),
        ledgerRebuilt: { at: '2026-11-20T09:00:00.000Z', reason: 'missing' },
      }),
    )
    expect(planInstallNotices(MACHINE, first, again, NOW).emit).toEqual([
      { kind: 'harness-ledger-rebuilt', at: '2026-11-20T09:00:00.000Z', reason: 'missing' },
    ])
  })
})

describe('raiseInstallNotices', () => {
  function deps(custodian: UserId | null = OWNER) {
    const emitted: EmitNoticeInput[] = []
    const resolved: string[] = []
    return {
      emitted,
      resolved,
      deps: {
        machine: async () => ({ name: 'build box', custodian }),
        emit: async (notice: EmitNoticeInput) => {
          emitted.push(notice)
        },
        resolve: async (key: string) => {
          resolved.push(key)
        },
        now: () => NOW,
      },
    }
  }

  it('sends the notices to the machine custodian, about the machine', async () => {
    const { emitted, deps: d } = deps()
    await raiseInstallNotices(
      d,
      MACHINE,
      undefined,
      inventory(
        agent('grok', {
          ...failingFor(INSTALL_FAILING_NOTICE_MS, 'HTTP 503'),
          ledgerRebuilt: { at: '2026-11-19T08:00:00.000Z', reason: 'missing' },
        }),
      ),
    )
    expect(emitted).toEqual([
      {
        recipientUserId: OWNER,
        kind: 'harness-install-failing',
        subject: { kind: 'machine', id: MACHINE },
        title: 'Updates for grok on build box have failed for three days',
        body: 'HTTP 503',
        dedupeKey: failingNoticeKey(MACHINE, 'grok'),
      },
      {
        recipientUserId: OWNER,
        kind: 'harness-ledger-rebuilt',
        subject: { kind: 'machine', id: MACHINE },
        title: 'Podium rebuilt its install record on build box',
        body: expect.stringContaining('was missing'),
        dedupeKey: rebuiltNoticeKey(MACHINE, '2026-11-19T08:00:00.000Z'),
      },
    ])
  })

  it('raises nothing for a machine nobody owns, and still resolves', async () => {
    const { emitted, resolved, deps: d } = deps(null)
    await raiseInstallNotices(
      d,
      MACHINE,
      inventory(agent('grok', failingFor(INSTALL_FAILING_NOTICE_MS))),
      inventory(agent('codex', failingFor(INSTALL_FAILING_NOTICE_MS)), agent('grok', managed())),
    )
    expect(emitted).toEqual([])
    expect(resolved).toEqual([failingNoticeKey(MACHINE, 'grok')])
  })
})

describe('MachinesService.recordInventory raises install notices', () => {
  it('compares each changed report with the one before, and with the stored one after a restart', async () => {
    const { openTestStore } = await import('../../test-support/open-test-store')
    const { MachinesService } = await import('./service')
    const { firstAdminMemberId } = await import('@podium/model')
    const store = await openTestStore(':memory:')
    const emitted: EmitNoticeInput[] = []
    const resolved: string[] = []
    const installNotices = {
      machine: async (machineId: string) => {
        const record = await store.machines.getMachine(machineId)
        return record
          ? { name: record.name, custodian: await store.machines.custodian(machineId) }
          : undefined
      },
      emit: async (notice: EmitNoticeInput) => {
        emitted.push(notice)
      },
      resolve: async (key: string) => {
        resolved.push(key)
      },
      now: () => NOW,
    }
    const service = () =>
      new MachinesService({
        store,
        hostMachine: store.hostMachine,
        instanceId: 'test',
        installNotices,
      })
    await store.machines.upsertMachine({
      id: MACHINE,
      name: 'build box',
      hostname: 'host',
      tokenHash: 'hash',
      ownerUserId: firstAdminMemberId(),
      assignment: { server: false, agentExecution: true },
      assignmentEvidence: { version: 1, source: 'test-enrollment', requestId: 'enroll-1' },
    })
    const failing = inventory(agent('grok', failingFor(INSTALL_FAILING_NOTICE_MS, 'HTTP 503')))
    let first = service()
    try {
      await first.recordInventory(MACHINE, failing)
      expect(emitted.map((n) => [n.kind, n.recipientUserId, n.dedupeKey])).toEqual([
        ['harness-install-failing', firstAdminMemberId(), failingNoticeKey(MACHINE, 'grok')],
      ])
      // The same report again changes nothing.
      await first.recordInventory(MACHINE, failing)
      expect(emitted).toHaveLength(1)
    } finally {
      first.dispose()
    }

    // A restarted server reads the stored report as the one before: the ledger
    // rebuild it already reported is not raised twice, the end of the run resolves.
    const rebuilt = { at: '2026-11-19T08:00:00.000Z', reason: 'missing' as const }
    first = service()
    try {
      await first.recordInventory(
        MACHINE,
        inventory(
          agent('grok', { ...failingFor(INSTALL_FAILING_NOTICE_MS), ledgerRebuilt: rebuilt }),
        ),
      )
      expect(emitted.at(-1)?.kind).toBe('harness-ledger-rebuilt')
      const count = emitted.length
      first.dispose()
      first = service()
      await first.recordInventory(
        MACHINE,
        inventory(agent('grok', { ...managed(), ledgerRebuilt: rebuilt })),
      )
      expect(emitted).toHaveLength(count)
      expect(resolved).toEqual([failingNoticeKey(MACHINE, 'grok')])
    } finally {
      first.dispose()
      await store.close()
    }
  })
})
