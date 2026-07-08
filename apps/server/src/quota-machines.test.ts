/**
 * #136: per-machine agent quota + machine-scoped memory breakdown.
 *
 * Two machines can run agents under different accounts. The quota overlay must
 * fan out to every online daemon (one section per machine); the memory breakdown
 * must route to the machine whose chip was clicked, not always the first one.
 *
 * TDD red → green:
 *   1. agentQuotaAll() fans out to each online daemon, tagging each reply with machineId+name.
 *   2. agentQuota(refresh, machineId) targets exactly that machine.
 *   3. single-machine invariant: agentQuotaAll() == one entry with agentQuota()'s agents.
 *   4. memoryBreakdown(roots, machineId) routes to that machine.
 */
import type { AgentQuotaWire, ControlMessage, DaemonMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

function agent(over: Partial<AgentQuotaWire> = {}): AgentQuotaWire {
  return {
    agent: 'claude-code',
    status: 'ok',
    account: { email: 'a@example.com', plan: 'max' },
    windows: [
      { key: '5h', label: '5-hour', usedPercent: 40, resetsAt: '', windowMinutes: 300 },
      { key: 'weekly', label: 'Weekly', usedPercent: 12, resetsAt: '', windowMinutes: 10080 },
    ],
    fetchedAt: '2026-07-07T00:00:00.000Z',
    ...over,
  }
}

function regWithTwoDaemons() {
  const store = new SessionStore(':memory:')
  store.machines.upsertMachine({ id: 'm1', name: 'podium-host', hostname: 'podium-host', tokenHash: 'x' })
  store.machines.upsertMachine({ id: 'm2', name: 'VMI', hostname: 'vmi', tokenHash: 'y' })
  const reg = new SessionRegistry(store)
  const m1Out: ControlMessage[] = []
  const m2Out: ControlMessage[] = []
  reg.modules.sessions.attachDaemon('m1', (msg) => m1Out.push(msg))
  reg.modules.sessions.attachDaemon('m2', (msg) => m2Out.push(msg))
  return { reg, store, m1Out, m2Out }
}

const reqId = (msgs: ControlMessage[], type: string): string => {
  const m = msgs.find((x) => x.type === type)
  expect(m, `expected a ${type}`).toBeDefined()
  return (m as { requestId: string }).requestId
}

describe('SessionRegistry.agentQuotaAll()', () => {
  it('fans out to every online daemon, tagging each reply with machineId + machineName', async () => {
    const { reg, m1Out, m2Out } = regWithTwoDaemons()
    const p = reg.modules.rpc.agentQuotaAll()

    reg.modules.sessions.onDaemonMessageFrom('m1', {
      type: 'agentQuotaResult',
      requestId: reqId(m1Out, 'agentQuotaRequest'),
      hostname: 'podium-host',
      agents: [agent({ account: { email: 'lud@example.com', plan: 'max' } })],
    } as DaemonMessage)
    reg.modules.sessions.onDaemonMessageFrom('m2', {
      type: 'agentQuotaResult',
      requestId: reqId(m2Out, 'agentQuotaRequest'),
      hostname: 'vmi',
      agents: [agent({ account: { email: 'vmi@example.com', plan: 'pro' } })],
    } as DaemonMessage)

    const result = await p
    const byMachine = new Map(result.map((r) => [r.machineId, r]))
    expect(result).toHaveLength(2)
    expect(byMachine.get('m1')).toMatchObject({ machineName: 'podium-host', hostname: 'podium-host' })
    expect(byMachine.get('m1')?.agents[0]?.account?.email).toBe('lud@example.com')
    expect(byMachine.get('m2')).toMatchObject({ machineName: 'VMI', hostname: 'vmi' })
    expect(byMachine.get('m2')?.agents[0]?.account?.email).toBe('vmi@example.com')
  })

  it('agentQuota(refresh, machineId) sends the request to only that machine', async () => {
    const { reg, m1Out, m2Out } = regWithTwoDaemons()
    void reg.modules.rpc.agentQuota(false, 'm2')
    expect(m2Out.some((m) => m.type === 'agentQuotaRequest')).toBe(true)
    expect(m1Out.some((m) => m.type === 'agentQuotaRequest')).toBe(false)
  })

  it('single-machine invariant: one online daemon → one entry with that machine agents', async () => {
    const store = new SessionStore(':memory:')
    store.machines.upsertMachine({ id: 'm1', name: 'Solo', hostname: 'solo', tokenHash: 'x' })
    const reg = new SessionRegistry(store)
    const out: ControlMessage[] = []
    reg.modules.sessions.attachDaemon('m1', (msg) => out.push(msg))

    const p = reg.modules.rpc.agentQuotaAll()
    reg.modules.sessions.onDaemonMessageFrom('m1', {
      type: 'agentQuotaResult',
      requestId: reqId(out, 'agentQuotaRequest'),
      hostname: 'solo',
      agents: [agent()],
    } as DaemonMessage)

    const result = await p
    expect(result).toHaveLength(1)
    expect(result[0]?.machineId).toBe('m1')
    expect(result[0]?.agents).toHaveLength(1)
    expect(result[0]?.agents[0]?.agent).toBe('claude-code')
  })

  it('returns [] when no daemon is online', async () => {
    const store = new SessionStore(':memory:')
    const reg = new SessionRegistry(store)
    expect(await reg.modules.rpc.agentQuotaAll()).toEqual([])
  })
})

describe('SessionRegistry.memoryBreakdown(roots, machineId)', () => {
  it('routes the breakdown request to the requested machine', async () => {
    const { reg, m1Out, m2Out } = regWithTwoDaemons()
    void reg.modules.hosts.memoryBreakdown(['/x'], 'm2')
    expect(m2Out.some((m) => m.type === 'memoryBreakdownRequest')).toBe(true)
    expect(m1Out.some((m) => m.type === 'memoryBreakdownRequest')).toBe(false)
  })
})
