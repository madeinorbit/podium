import type { ClientRuntime } from '@podium/client-core/engine'
import type { PoolSource } from './source-registry'
import type { Loaded } from './worklist/rollup'

/** Phone diagnostics are scalar summaries, never a mirror of conversation or
 * issue payloads. All projections count, including archived and deleted ones,
 * exactly as the legacy Settings useIssues() membership does. */
export interface MobileSettingsDiagnostics {
  issueCount: number
  conversationCount: number
  cursor: ReturnType<ClientRuntime['replica']['getCursor']>
}
export interface MobileSettingsRows {
  mobileSettingsDiagnostics: MobileSettingsDiagnostics
}
declare module './source-registry' {
  interface PoolSourceRows extends MobileSettingsRows {}
}
export const MOBILE_SETTINGS_SOURCE_KEY = 'mobile-settings'
export const MOBILE_SETTINGS_ENTITIES = ['mobileSettingsDiagnostics'] as const

type DiagnosticsOwner = Pick<ClientRuntime, 'replica'>

/** Demand batches one O(1) summary from the existing runtime. Cardinality is
 * maintained by the replica's keyed map; no issue models or table walks
 * are needed. The cursor refreshes on the replica's cursor signal, watermark-only
 * frames included; those frames still never invalidate replica rows. */
export async function createMobileSettingsSource(
  owner: DiagnosticsOwner,
): Promise<PoolSource<keyof MobileSettingsRows> & { counts: { batches: number } }> {
  const [{ observable, runInAction, compareStructural }, rollup] = await Promise.all([
    import('mobx'),
    import('./worklist/rollup'),
  ])
  const { defineSource } = await import('./source-registry')
  const LOADING: typeof import('./worklist/rollup').LOADING = rollup.LOADING
  const value = observable.box<MobileSettingsDiagnostics | undefined>(undefined, {
    deep: false,
    equals: compareStructural,
  })
  let demanded = false
  if (!owner.replica.rowCount) throw new Error('Phone diagnostics require keyed replica counts')
  const counts = { batches: 0 }
  function schedule(): void {
    if (demanded) source.schedule()
  }
  const source = defineSource({
    readById(_entity: keyof MobileSettingsRows, id: string): Loaded<MobileSettingsDiagnostics> {
      if (id !== 'diagnostics') return undefined
      demanded = true
      const current = value.get()
      if (current === undefined) {
        schedule()
        return LOADING
      }
      return current
    },
    refresh() {
      const next = {
        issueCount: owner.replica.rowCount!('issueProjections'),
        conversationCount: owner.replica.rowCount!('conversations'),
        cursor: owner.replica.getCursor(),
      }
      runInAction(() => value.set(next))
      counts.batches++
    },
    release() {
      for (const stop of stops) stop()
      queueMicrotask(() => runInAction(() => value.set(undefined)))
    },
  })
  // Keyed (POD-5433): the two counts move only with their lists; the cursor
  // has its own signal.
  if (!owner.replica.subscribeCursor) throw new Error('Phone diagnostics require the replica cursor signal')
  const stops = [owner.replica.subscribeRows('issueProjections', schedule), owner.replica.subscribeRows('conversations', schedule), owner.replica.subscribeCursor(schedule)]
  return Object.assign(source, { counts })
}
