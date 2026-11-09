import { useDeviceState } from '@podium/client-core/react'
import {
  type RoutedUiState,
  requireReplicatedLayoutKey,
  TIP_SEEN_KEY_PREFIX,
  UI_STATE_KEYS,
} from '@podium/client-core/ui-state'
import type { MobxPool } from '@podium/client-graph'
import { LOADING } from '@podium/client-graph/loading'
import { isGone } from '@podium/client-graph/lookup'
import { lazy } from '@podium/mobx-helpers'
import { action, observable } from 'mobx'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { TIP_IDS, type TipId, type TipLog, type TipOutcome } from './types'

export const ACCOUNT_TIP_IDS = TIP_IDS
export type AccountTipLogContract = TipLog

const tipKey = (id: TipId): string => `${TIP_SEEN_KEY_PREFIX}${id}`
const keys = [UI_STATE_KEYS.tipsEnabled, ...ACCOUNT_TIP_IDS.map(tipKey)]

/** Reads the shared preference rows, never a second copy of account state. */
export class AccountTipLog implements AccountTipLogContract {
  @observable private accessor disposed = false

  constructor(
    private readonly pool: MobxPool,
    private readonly ui: Pick<RoutedUiState, 'set'>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  @lazy get ready(): boolean {
    return (
      !this.disposed && keys.every((key) => this.pool.layoutReady(requireReplicatedLayoutKey(key)))
    )
  }

  @lazy get enabled(): boolean {
    return this.value(UI_STATE_KEYS.tipsEnabled) !== 'false'
  }

  isSeen(id: TipId): boolean {
    return this.value(tipKey(id)) !== null
  }

  private value(key: string): string | null {
    const row = this.pool.row('preference', key)
    return row === LOADING || isGone(row) ? null : row.value
  }

  @action dispose(): void {
    this.disposed = true
  }

  private write(key: string, value: string): void {
    this.ui.set(key, value)
  }

  @action record(id: TipId, outcome: TipOutcome): void {
    if (!this.ready || outcome === 'shown') return
    const at = this.now()
    for (const moment of outcome === 'skipped-all' ? ACCOUNT_TIP_IDS : [id]) {
      if (!this.isSeen(moment)) this.write(tipKey(moment), at)
    }
    if (outcome === 'skipped-all') this.setEnabled(false)
  }

  @action setEnabled(on: boolean): void {
    if (!this.ready) return
    this.write(UI_STATE_KEYS.tipsEnabled, String(on))
  }
}

const pendingLog: AccountTipLogContract = {
  ready: false,
  enabled: true,
  isSeen: () => false,
  record: () => {},
  setEnabled: () => {},
}

/** Readiness follows the same addressed pool records as the tip values. */
export function useAccountTipLog(): AccountTipLogContract {
  const pool = useWorklistPool()
  const ui = useDeviceState()
  return pool?.sources.view('account-tip-log', () => new AccountTipLog(pool, ui)) ?? pendingLog
}
