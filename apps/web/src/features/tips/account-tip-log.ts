import { useStoreHandle } from '@podium/client-core/react'
import {
  type RoutedUiState,
  TIP_SEEN_KEY_PREFIX,
  UI_STATE_KEYS,
} from '@podium/client-core/ui-state'
import type { MobxPool } from '@podium/client-graph'
import { headerView } from '@podium/client-graph/header-views'
import { LOADING } from '@podium/client-graph/loading'
import { isGone } from '@podium/client-graph/lookup'
import { preferenceSource } from '@podium/client-graph/preference-source'
import { lazy } from '@podium/mobx-helpers'
import { action, observable, runInAction } from 'mobx'
import { useEffect } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { TIP_IDS, type TipId, type TipLog, type TipOutcome } from './types'

export const ACCOUNT_TIP_IDS = TIP_IDS
export type AccountTipLogContract = TipLog

const tipKey = (id: TipId): string => `${TIP_SEEN_KEY_PREFIX}${id}`
const keys = [UI_STATE_KEYS.tipsEnabled, ...ACCOUNT_TIP_IDS.map(tipKey)]

/** Reads the shared preference rows, never a second copy of account state. */
export class AccountTipLog implements AccountTipLogContract {
  @observable accessor hydrated = false
  @observable private accessor disposed = false
  private loading: Promise<void> | undefined

  constructor(
    private readonly pool: MobxPool,
    private readonly ui: Pick<RoutedUiState, 'set'>,
    private readonly hydrate: () => Promise<void>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  @lazy get ready(): boolean {
    if (this.disposed || !this.hydrated) return false
    return keys.every((key) => {
      const row = this.pool.row('preference', key)
      return row !== LOADING && !isGone(row)
    })
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

  /** A cached empty layout is not proof of an unseen tip. Wait for the account's
   * authoritative layout, including rollout seeding, before the engine can show. */
  load(): Promise<void> {
    if (this.disposed || this.hydrated) return Promise.resolve()
    if (this.loading) return this.loading
    this.loading = this.hydrate()
      .then(() => {
        if (this.disposed) return
        runInAction(() => {
          for (const key of keys) {
            this.pool.row('preference', key)
            preferenceSource(this.pool)?.refreshKey(key)
          }
          this.hydrated = true
        })
      })
      .finally(() => {
        this.loading = undefined
      })
    return this.loading
  }

  @action dispose(): void {
    this.disposed = true
  }

  private write(key: string, value: string): void {
    this.ui.set(key, value)
    preferenceSource(this.pool)?.refreshKey(key)
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

const connectionStatus = (pool: MobxPool) => headerView(pool).connection()?.status ?? null

export function useAccountTipLog(): AccountTipLogContract {
  const pool = useWorklistPool()
  const connection = useWorklistPoolProjection(connectionStatus, null)
  const { uiState, replicatedLayout } = useStoreHandle().access
  const log = pool?.sources.view(
    'account-tip-log',
    () => new AccountTipLog(pool, uiState, () => replicatedLayout.hydrate()),
  )
  useEffect(() => {
    // Network failure keeps ready=false. Retry after reconnect or remount;
    // never show a tip against an account layout that has not arrived.
    if (connection === 'down') return
    void log?.load().catch(() => {})
  }, [log, connection])
  return log ?? pendingLog
}
