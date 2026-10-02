import { asAutomationId, asAutomationRunId, asSessionId, type AutomationWire, type AutomationRunWire } from '@podium/model/browser'
import { createHeaderFixture } from './header-fixture'

/** Synthetic fixture over the actual runtime/replica. No operator rows. */
export function createAutomationsFixture(issueCount = 32, sessionCount = issueCount) {
  const fixture = createHeaderFixture(issueCount, sessionCount)
  const stamp = new Date(Date.now() - 3600000).toISOString()
  const definitions: AutomationWire[] = Array.from({ length: 6 }, (_, index) => ({
    id: asAutomationId(`synthetic-auto-${index}`), name: `Synthetic automation ${index}`, enabled: index !== 1,
    repoPath: index === 2 ? null : '/synthetic/project', scheduleKind: index === 3 ? 'once' : 'cron',
    cron: index === 3 ? null : '0 9 * * *', runAt: index === 3 ? stamp : null,
    targetSessionId: index === 3 ? asSessionId('synthetic-session-0') : null,
    agentKind: 'codex', model: 'auto', effort: 'auto', prompt: 'Synthetic automation task', sessionMode: index % 2 ? 'resume' : 'fresh',
    nextRunAt: stamp, lastRunAt: index === 3 ? stamp : null, createdAt: stamp,
  }))
  const runs: AutomationRunWire[] = definitions.flatMap((automation, index) => Array.from({ length: 4 }, (_, run) => ({
    id: asAutomationRunId(`synthetic-run-${index}-${run}`), automationId: automation.id,
    firedAt: new Date(Date.parse(stamp) + run * 1000).toISOString(),
    sessionId: run === 0 ? asSessionId('synthetic-session-0') : run === 1 ? asSessionId('synthetic-deleted-session') : null,
    outcome: (['spawned', 'spawned', 'missed', 'skipped_overlap'] as const)[run]!, detail: run === 3 ? 'Synthetic overlap' : null,
  })))
  for (const [entity, values] of [['automation', definitions], ['automationRun', runs]] as const) {
    for (const value of values) fixture.records.set(`${entity}:${value.id}`, { entity, entityId: value.id, value, provenance: { seq: 1 } })
  }
  const calls: Record<string, number> = {}
  const query = (key: string, value: unknown) => async () => { calls[key] = (calls[key] ?? 0) + 1; return value }
  const meta = { id: 'SP-root', title: 'Synthetic specification', parent: '', order: 0, status: 'active', updatedAt: Date.now() }
  Object.assign(fixture.api, {
    issues: { subscriptionList: { query: query('subscriptions', []) } },
    specs: { list: { query: query('specList', [meta]) }, get: { query: query('specGet', { ...meta, body: '<p>Synthetic specification body.</p>' }) },
      save: { mutate: query('specSave', meta) }, search: { query: query('specSearch', []) } },
    automations: { create: { mutate: query('create', {}) }, update: { mutate: query('update', {}) },
      setEnabled: { mutate: query('toggle', {}) }, remove: { mutate: query('remove', {}) } },
  })
  return { ...fixture, get replica() { return fixture.replica }, definitions, runs, calls,
    remove(entity: string, id: string) {
      fixture.records.delete(`${entity}:${id}`)
      fixture.replica.onKernelEvent({ type: 'removed', entity, entityId: id })
    },
    replaceRuns() {
      for (const [key, record] of fixture.records) if (record.entity === 'automationRun') fixture.records.delete(key)
      fixture.replica.onKernelEvent({ type: 'bootstrap-installed', cause: 'rescope', snapshotSeq: 2,
        entityCount: fixture.records.size, bufferedFramesApplied: 0 })
    },
  }
}
