import { type QuotaLedgerView, quotaLedger } from '@podium/client-core/viewmodels'
import type { QuotaWindowHistoryWire } from '@podium/model/browser'
import { useMemo } from 'react'
import type { Trpc } from '@/app/trpc'
import { resetPolledQueryCache, usePolledQuery } from '@/lib/use-polled-query'

/**
 * The reset ledger's feed.
 *
 * Polls far more slowly than the token trace beside it, and should: a window
 * instance changes when a pool resets, which for a weekly pool is once a week.
 * The server samples every 15 minutes; refreshing the client faster than that
 * only redraws identical columns.
 *
 * Same RPC-poll reasoning as `useUsageFeed`: there is no server-side entity to
 * replicate and nothing an optimistic overlay could apply to. Unlike the token
 * figures, though, this read is genuinely durable on the server — it is the one
 * quota number Podium keeps — so the client cache here is a convenience, not the
 * only copy.
 */

const REFRESH_MS = 5 * 60_000
const CACHE_KEY = 'quota.history'

/** Tests only — the module cache is deliberately process-wide otherwise. */
export function resetQuotaLedgerCache(): void {
  resetPolledQueryCache(CACHE_KEY)
}

export interface QuotaLedgerFeed {
  /** Null only when this tab has never had an answer: the one cold state. */
  ledger: QuotaLedgerView | null
  waiting: boolean
  failed: boolean
  retry: () => void
}

export function useQuotaLedger(trpc: Trpc): QuotaLedgerFeed {
  const query = usePolledQuery<QuotaWindowHistoryWire[]>({
    key: CACHE_KEY,
    intervalMs: REFRESH_MS,
    read: () => trpc.quota.history.query({}),
  })
  const ledger = useMemo(() => (query.data ? quotaLedger(query.data) : null), [query.data])
  return {
    ledger,
    waiting: query.pending,
    failed: query.failed,
    retry: query.refresh,
  }
}
