/** Capture-only control: the pre-delta header algorithms, with their original
 * memo boundaries. Injected by header-session-speed.ts; never app-imported. */
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import { coldSessionIds, knownSessionIds } from '@podium/client-graph/enumerate'
import { EMPTY_HOST_AGGREGATE, headerHostSession, headerWorkingSession } from '@podium/client-graph/header-session'
import type { MachineId } from '@podium/model/browser'

type Memo = <T>(key: string, read: () => T) => T
export function createScanningHeaderSessions(pool: MobxPool, memo: Memo) {
  return {
    working: () => memo('sessionKeys', () => knownSessionIds(pool)).flatMap(id => {
      const cold = pool.hidden('session', id)
      const member = cold ? (cold.status === 'live' && cold.archived !== true
        ? memo(`coldWorking:${id}`, () => headerWorkingSession(pool.hidden('session', id) as unknown as SessionView, at => pool.clock.passed(at))) : null)
        : pool.model('session', id)?.headerWorking
      return member ? [member] : []
    }),
    aggregate: (machineId: MachineId | undefined) => {
      const result = structuredClone(EMPTY_HOST_AGGREGATE)
      if (!machineId) return result
      const members = pool.header.members('machine', machineId, 'sessions').map(id => pool.model('session', id)?.headerHost)
      for (const id of coldSessionIds(pool)) {
        const summary = pool.hidden('session', id)
        if (summary?.machineId === machineId) members.push(memo(`coldHost:${id}`, () => headerHostSession(pool.hidden('session', id) as unknown as SessionView)))
      }
      for (const member of members) {
        if (!member || member.archived) continue
        result.count++
        const phase = member.phase
        if (phase === 'working' || phase === 'compacting') result.phases.working++
        else if (phase === 'idle' || phase === 'ended') result.phases.idle++
        else if (phase === 'needs_user') result.phases.waiting++
        else result.phases.other++
        if (member.status !== 'live' || !['idle', 'ended', 'needs_user'].includes(phase ?? '')) continue
        result.idleSplit.idle++
        if (phase === 'needs_user' || !member.resumable) result.idleSplit.protected++
        else result.idleSplit.parkable++
      }
      return result
    },
    dispose() {},
  }
}
