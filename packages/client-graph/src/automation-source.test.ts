import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { asAutomationId, type AutomationWire } from '@podium/model/browser'
import { configure, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { AutomationSource } from './automation-source'
import { LOADING } from './worklist/rollup'

it('addressed publications honor the strict observable read trap', async () => {
  const row: AutomationWire = { id: asAutomationId('strict-auto'), name: 'Synthetic automation', enabled: true,
    repoPath: null, scheduleKind: 'cron', cron: '0 9 * * *', runAt: null, targetSessionId: null,
    agentKind: 'codex', model: 'auto', effort: 'auto', prompt: 'Synthetic task', sessionMode: 'fresh',
    nextRunAt: null, lastRunAt: null, createdAt: new Date().toISOString(),
  }
  const records = new Map([['automation:strict-auto', { entity: 'automation', entityId: 'strict-auto', value: row, provenance: { seq: 1 } }]])
  const replica = createKernelReplica({ cache: {
    readCursor: () => null, readEntities: () => [...records.values()], read: (entity, id) => records.get(`${entity}:${id}`), durability: () => 'durable',
  }, side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }) })
  const source = new AutomationSource(replica)
  configure({ enforceActions: 'always', observableRequiresReaction: true })
  const warn = vi.spyOn(console, 'warn').mockImplementation(message => { throw new Error(String(message)) })
  const read = () => runInAction(() => source.read('automation', 'strict-auto'))
  try {
    expect(read()).toBe(LOADING)
    await Promise.resolve()
    expect(read()).toMatchObject({ enabled: true })
    const record = { ...records.get('automation:strict-auto')!, value: { ...row, enabled: false } }
    records.set('automation:strict-auto', record)
    replica.onKernelEvent({ type: 'upserted', record, readmitted: false })
    expect(read()).toMatchObject({ enabled: false })
    expect(warn).not.toHaveBeenCalled()
  } finally {
    source.dispose(); await Promise.resolve()
    configure({ enforceActions: 'never', observableRequiresReaction: false })
    warn.mockRestore()
  }
})
