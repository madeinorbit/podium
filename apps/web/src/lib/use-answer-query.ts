import { type AnswerSignal, focusRefresh } from '@podium/client-graph/answer-refresh'
import { LiveRequest } from '@podium/client-graph/live-request'
import { reaction } from 'mobx'
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useTabVisible } from './use-polled-query'

/** React binds the request owner to this opening and visibility. No cache or timer. */
export function useAnswerQuery<T>({
  key,
  read,
  signal = focusRefresh,
  enabled = true,
}: {
  key: string
  read: () => Promise<T>
  signal?: AnswerSignal
  enabled?: boolean
}) {
  const readRef = useRef(read)
  readRef.current = read
  const view = useMemo(() => new LiveRequest(key, () => readRef.current(), signal), [key, signal])
  const visible = useTabVisible()
  useEffect(() => {
    if (enabled && visible) view.open()
    return () => view.close()
  }, [view, enabled, visible])
  const subscribe = useCallback(
    (changed: () => void) => reaction(() => view.snapshot, changed),
    [view],
  )
  const get = useCallback(() => view.snapshot, [view])
  const snapshot = useSyncExternalStore(subscribe, get)
  return { ...snapshot, failed: snapshot.error !== null, refresh: view.refresh }
}
