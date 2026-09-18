import type { MachineId, SessionMeta } from '@podium/model'
import { recordSliceDerivation } from '../perf/store-stats'

type Material = Pick<SessionMeta, 'machineId' | 'status' | 'cwd'> & {
  archived: boolean
  resumable: boolean
  phase: string | undefined
}
const empty = () => ({
  count: 0,
  idleSplit: { idle: 0, parkable: 0, protected: 0 },
  phases: { working: 0, idle: 0, waiting: 0, other: 0 },
})
type Aggregate = ReturnType<typeof empty>
function build(material: readonly Material[]) {
  const machines = new Map<MachineId, Aggregate>()
  const missing = empty()
  const cwds: string[] = []
  for (const s of material) {
    if (s.status !== 'live' && s.status !== 'starting' && s.status !== 'reconnecting') continue
    // Occupancy intentionally includes archived and unattributed residents.
    cwds.push(s.cwd)
    if (!s.machineId || s.archived) continue
    let aggregate = machines.get(s.machineId)
    if (!aggregate) { aggregate = empty(); machines.set(s.machineId, aggregate) }
    aggregate.count++
    const { phase } = s
    if (phase === 'working' || phase === 'compacting') aggregate.phases.working++
    else if (phase === 'idle' || phase === 'ended') aggregate.phases.idle++
    else if (phase === 'needs_user') aggregate.phases.waiting++
    else aggregate.phases.other++
    if (s.status !== 'live' || (phase !== 'idle' && phase !== 'ended' && phase !== 'needs_user')) continue
    aggregate.idleSplit.idle++
    if (phase === 'needs_user' || !s.resumable) aggregate.idleSplit.protected++
    else aggregate.idleSplit.parkable++
  }
  return {
    occupancyKey: cwds.sort().join('\n'),
    forMachine: (id: MachineId | undefined): Aggregate => (id && machines.get(id)) || missing,
  }
}

/** One mounted consumer's latest immutable session scope, never a global cache.
 * Same-array clock/connection renders do no scanning. New arrays compare only
 * aggregate inputs; material changes rebuild every machine in one pass.
 */
export function createHostSessionAggregatesSelector() {
  let source: readonly SessionMeta[] | undefined
  let material: Material[] = []
  let result = build([])
  const select = (sessions: readonly SessionMeta[]) => {
    if (sessions === source) return result
    recordSliceDerivation(select, 'hostSessions.materialScan')
    const next: Material[] = []
    let changed = source === undefined || sessions.length !== material.length
    for (const s of sessions) {
      const row: Material = { machineId: s.machineId, status: s.status, cwd: s.cwd,
        archived: !!s.archived, resumable: !!s.resumable, phase: s.agentState?.phase }
      const previous = material[next.length]
      if (!previous || previous.machineId !== row.machineId || previous.status !== row.status ||
        previous.cwd !== row.cwd || previous.archived !== row.archived ||
        previous.resumable !== row.resumable || previous.phase !== row.phase) changed = true
      next.push(row)
    }
    source = sessions
    if (!changed) return result
    material = next
    recordSliceDerivation(select, 'hostSessions.aggregateBuild')
    result = build(material)
    return result
  }
  return select
}
