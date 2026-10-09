import { createSettingsMachineReaders } from './settings-machine-readers'
import { omitGone } from '@podium/client-graph/lookup'
import { useSettingsOpening } from './settings-opening'
import type { MobxPool } from '@podium/client-graph'
import type { MobileSettingsDiagnostics } from '@podium/client-graph/mobile-settings'
import { visibleFleetOperations, type MachineOperationsView } from '@podium/client-core/values'
import { useCallback } from 'react'
import { useMobilePoolProjection } from '../client/mobile-pool'

export type SettingsMachineStatus = Pick<
  MachineOperationsView,
  'id' | 'name' | 'online' | 'statusLabel' | 'updateChannel' | 'updateLabel'
>
export interface SettingsData extends MobileSettingsDiagnostics {
  machineIds: readonly string[]
  machineCount: number
  fleetLabel: string
  updateLabel: string
  sessionCount: number
  outboxSize: number
  outboxDeadLetterCount: number
}
const EMPTY_IDS: readonly string[] = []
const UPDATE_STATES = ['current', 'behind', 'ahead', 'unreported', 'unknown'] as const
const EMPTY_SETTINGS: SettingsData = {
  machineIds: EMPTY_IDS,
  machineCount: 0,
  fleetLabel: 'No visible machines',
  updateLabel: 'No visible machines',
  sessionCount: 0,
  issueCount: 0,
  conversationCount: 0,
  cursor: null,
  outboxSize: 0,
  outboxDeadLetterCount: 0,
}
const loaded = <T extends object>(row: T | symbol | undefined): row is T =>
  typeof row === 'object' && row !== null

/** These lazy computeds belong to Settings. No host capacity is shown here;
 * only the twelve displayed machine identities and the fleet's scalar labels
 * leave this reader. Unrelated diagnostic changes do not rebuild the fleet. */

export function readSettingsData(
  pool: MobxPool,
  machines = createSettingsMachineReaders(pool),
): SettingsData {
  const diagnostics = omitGone(pool.row('mobileSettingsDiagnostics', 'diagnostics'))
  const window = omitGone(pool.row('window', 'window')) as { outboxSize: number } | undefined
  const notices = omitGone(pool.row('noticeCatalog', 'catalog'))
  return {
    ...machines.summary(null),
    machineIds: machines.shown(null),
    sessionCount: pool.queries.setupSessionCount(),
    issueCount: loaded(diagnostics) ? diagnostics.issueCount : 0,
    conversationCount: loaded(diagnostics) ? diagnostics.conversationCount : 0,
    cursor: loaded(diagnostics) ? diagnostics.cursor : null,
    outboxSize: window?.outboxSize ?? 0,
    outboxDeadLetterCount: loaded(notices) ? notices.deadLetters.length : 0,
  }
}
export function useSettingsMachineStatus(id: string): SettingsMachineStatus | null {
  const view = useSettingsOpening()
  const read = useCallback((_pool: MobxPool) => view?.machines.status(id) ?? null, [view, id])
  return useMobilePoolProjection(read, null)
}
export function useSettingsData(): SettingsData {
  const view = useSettingsOpening()
  const read = useCallback(
    (pool: MobxPool) => (view ? readSettingsData(pool, view.machines) : EMPTY_SETTINGS),
    [view],
  )
  return useMobilePoolProjection(read, EMPTY_SETTINGS)
}
