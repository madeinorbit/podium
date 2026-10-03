import { asAccountId, asMachineId, asSessionId, type MachineWire } from '@podium/model/browser'
import type { ExecutionProfileWire, WorkflowDetailWire, WorkflowRunWire } from '@podium/protocol'
import type { Trpc } from '../src/app/trpc'
import { createHeaderFixture } from './header-fixture'

/** Synthetic workflow RPC data over the actual provider runtime and replica.
 * The RPC hook is the only workflow source; no workflow rows enter the feed. */
export function createWorkflowsFixture(issueCount = 32, sessionCount = issueCount) {
  const fixture = createHeaderFixture(issueCount, sessionCount)
  const stamp = new Date(Date.now() - 3600000).toISOString()
  const machines: MachineWire[] = ['available', 'unauthorized', 'unreachable', 'incapable', 'disabled', 'degraded'].map(state => ({
    id: asMachineId(`synthetic-${state}`), name: `Synthetic ${state}`, hostname: `synthetic-${state}`,
    online: state !== 'unreachable', lastSeenAt: stamp, use: state === 'unauthorized' ? 'denied' : 'granted',
    availability: { daemon: state !== 'incapable', agentExecution: state !== 'degraded', server: false, supervisor: false, epoch: 'fixture' },
    serviceAssignment: { server: false, agentExecution: state !== 'disabled' },
  }))
  const profiles: ExecutionProfileWire[] = [...machines.map(machine => machine.id), asMachineId('synthetic-missing'), null].map((machineId, index) => ({
    id: `synthetic-profile-${index}`, name: `Synthetic profile ${index}`, accountId: asAccountId('synthetic-account'), machineId,
    harness: 'codex', model: 'auto', effort: 'auto', createdAt: stamp, updatedAt: stamp,
  }))
  const detail: WorkflowDetailWire = {
    workflow: { id: 'synthetic-workflow', name: 'Synthetic workflow', description: 'Synthetic instructions', scope: 'global', scopeRef: null,
      latestRevisionId: 'synthetic-revision', latestVersion: 1, archivedAt: null, createdAt: stamp, updatedAt: stamp },
    revisions: [{ id: 'synthetic-revision', workflowId: 'synthetic-workflow', version: 1, instructions: 'Synthetic instructions', steps: [], createdAt: stamp, publishedAt: stamp }],
  }
  const runs: WorkflowRunWire[] = [
    ['issue', 'synthetic-0'], ['issue', 'synthetic-5'], ['issue', 'synthetic-missing'],
    ['session', 'synthetic-session-0'], ['session', 'synthetic-session-5'], ['session', 'synthetic-missing'],
  ].map(([subjectKind, subjectId], index) => ({
    id: `synthetic-workflow-run-${index}`, subjectKind: subjectKind as 'issue' | 'session', subjectId: subjectId!,
    coordinatorSessionId: asSessionId('synthetic-session-0'), revision: detail.revisions[0]!, status: 'active', supersedesRunId: null,
    steps: [], history: [{ kind: 'run.started', actorKind: 'session', actorId: 'synthetic-session-0', onBehalfOf: index ? null : 'synthetic-human', createdAt: stamp }],
    startedAt: stamp, completedAt: null,
  }))
  const calls: Record<string, number> = {}
  let denial: string | null = null
  const query = <T>(key: string, read: () => T) => async () => { calls[key] = (calls[key] ?? 0) + 1; return read() }
  const mutate = query('profileSave', () => { if (denial) throw new Error(denial); return profiles[0] })
  Object.assign(fixture.api, {
    discovery: { refreshRepos: { mutate: query('discovery', () => ({ repositories: [], machines, diagnostics: [] })) } },
    workflows: {
      list: { query: query('list', () => [detail.workflow]) }, bindings: { query: query('bindings', () => []) },
      profiles: { query: query('profiles', () => profiles) }, runs: { query: query('runs', () => runs) },
      get: { query: query('get', () => detail) }, profileSave: { mutate },
    },
    lock: { status: { query: async (input: unknown) => { calls.locks = (calls.locks ?? 0) + 1; lockInputs.push(input); return [] } } },
  })
  const lockInputs: unknown[] = []
  return { ...fixture, get replica() { return fixture.replica }, api: fixture.api as unknown as Trpc, machines, profiles, runs, detail, calls, lockInputs,
    denyProfileSave(message: string | null) { denial = message },
    remove(entity: string, id: string) {
      fixture.records.delete(`${entity}:${id}`)
      fixture.replica.onKernelEvent({ type: 'removed', entity, entityId: id })
    },
    replace() { fixture.replica.onKernelEvent({ type: 'bootstrap-installed', cause: 'rescope', snapshotSeq: 2, entityCount: fixture.records.size, bufferedFramesApplied: 0 }) },
  }
}
