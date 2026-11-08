import { type QuotaLedgerView, quotaLedger } from '@podium/client-core/values'
import type { QuotaWindowHistoryWire } from '@podium/model/browser'
import { useMemo } from 'react'
import type { Trpc } from '@/app/trpc'
import { resetQuotaRefreshedAnswer, useQuotaRefreshedRequest } from './use-quota-refreshed-request'

/**
 * The reset ledger's feed: a request answer (POD-5798).
 *
 * A window instance changes only when the server's quota sampler folds a new
 * reading, which is the same pass that pushes `account.quota`. So the ledger is
 * asked for when the sheet opens and again for each new quota value; no timer.
 * This read is durable on the server (the one quota number Podium keeps), so
 * the tab's copy is a convenience, not the only one.
 */

const CACHE_KEY = 'quota.history'

/** Tests only — the answer is deliberately tab-wide otherwise. */
export function resetQuotaLedgerCache(): void {
  resetQuotaRefreshedAnswer(CACHE_KEY)
}

export interface QuotaLedgerFeed {
  /** Null only when this tab has never had an answer: the one cold state. */
  ledger: QuotaLedgerView | null
  waiting: boolean
  failed: boolean
  retry: () => void
}

export function useQuotaLedger(trpc: Trpc): QuotaLedgerFeed {
  const query = useQuotaRefreshedRequest<QuotaWindowHistoryWire[]>(CACHE_KEY, () =>
    trpc.quota.history.query({}),
  )
  const ledger = useMemo(() => (query.data ? quotaLedger(query.data) : null), [query.data])
  return {
    ledger,
    waiting: query.pending,
    failed: query.failed,
    retry: query.retry,
  }
}
