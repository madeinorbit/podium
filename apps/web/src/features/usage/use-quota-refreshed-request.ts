import type { MobxPool } from '@podium/client-graph'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'

/**
 * A REQUEST ANSWER THAT FOLLOWS THE QUOTA PUSH (POD-5798).
 *
 * The usage sheet's ledger (`quota.history`) and by-task costs (`cost.tasks`)
 * stay requests: they are history and a ranked table, not conditions. But
 * both change only when the server's quota pass runs, the same pass that
 * pushes `account.quota`: the sampler folds the ledger, and the usage harvest
 * folds the per-task cost rows. So each is asked for when the sheet opens and
 * again whenever a new `account.quota` value arrives. There is no timer: no
 * new value, nothing new to fetch.
 *
 * The last answer is kept for the browser tab, so reopening the sheet paints it
 * on the first frame; the request that follows is a refresh.
 */

const answers = new Map<string, unknown>()

/** Tests only — the answers are deliberately tab-wide otherwise. */
export function resetQuotaRefreshedAnswer(key: string): void {
  answers.delete(key)
}

export interface QuotaRefreshedRequest<T> {
  /** Null only while this tab has never had an answer. */
  data: T | null
  /** A request is in flight. */
  pending: boolean
  /** The last request failed; any `data` on screen is the one before it. */
  failed: boolean
  retry: () => void
}

/** When the newest quota value arrived; changes only with a new value. */
const quotaStamp = (pool: MobxPool): number | null => {
  const reading = pool.live?.quota
  return reading?.known ? reading.at : null
}

export function useQuotaRefreshedRequest<T>(
  key: string,
  read: () => Promise<T>,
): QuotaRefreshedRequest<T> {
  const stamp = useWorklistPoolProjection(quotaStamp, null)
  const [state, setState] = useState<{ data: T | null; pending: boolean; failed: boolean }>(() => ({
    data: (answers.get(key) as T | undefined) ?? null,
    pending: false,
    failed: false,
  }))
  const readRef = useRef(read)
  readRef.current = read
  const latest = useRef(0)
  const ask = useCallback(() => {
    const generation = ++latest.current
    setState((current) => ({ ...current, pending: true }))
    readRef.current().then(
      (data) => {
        if (generation !== latest.current) return
        answers.set(key, data)
        setState({ data, pending: false, failed: false })
      },
      () => {
        if (generation !== latest.current) return
        setState((current) => ({ ...current, pending: false, failed: true }))
      },
    )
  }, [key])
  // On open, then again each time a newer quota value replaces a known one.
  // The first value arriving after open is not a reason: the request the open
  // made is already as new as it.
  useEffect(() => {
    ask()
    return () => {
      latest.current += 1
    }
  }, [ask])
  const lastStamp = useRef(stamp)
  useEffect(() => {
    const previous = lastStamp.current
    lastStamp.current = stamp
    if (previous !== null && stamp !== null && stamp !== previous) ask()
  }, [ask, stamp])
  return { ...state, retry: ask }
}
