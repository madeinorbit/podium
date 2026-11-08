import { AnswerRefresh, type AnswerSignal, focusRefresh } from '@podium/client-graph/answer-refresh'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTabVisible } from './use-polled-query'

/** A request answer owned by this opening. Its refresh source is explicit;
 * focus/visibility covers reads whose originator cannot signal yet. No cache or timer. */
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
}): {
  data: T | null
  error: string | null
  pending: boolean
  failed: boolean
  fetchedAt: number | null
  refresh: () => void
} {
  const readRef = useRef(read)
  readRef.current = read
  const [answer, setAnswer] = useState<{
    key: string
    data: T | null
    error: string | null
    pending: boolean
    fetchedAt: number | null
  }>({ key, data: null, error: null, pending: true, fetchedAt: null })
  if (answer.key !== key)
    setAnswer({ key, data: null, error: null, pending: true, fetchedAt: null })
  const visible = useTabVisible()
  const owner = useMemo(
    () => ({
      key,
      signal,
      live: false,
      generation: 0,
      refreshes: undefined as AnswerRefresh | undefined,
    }),
    [key, signal],
  )
  useEffect(() => {
    if (!enabled || !visible) return
    owner.live = true
    const generation = ++owner.generation
    const refreshes = new AnswerRefresh(async () => {
      if (!owner.live || owner.generation !== generation) return
      setAnswer((a) => ({ ...a, pending: true }))
      try {
        const data = await readRef.current()
        if (owner.live && owner.generation === generation)
          setAnswer({ key, data, error: null, pending: false, fetchedAt: Date.now() })
      } catch (cause) {
        if (owner.live && owner.generation === generation)
          setAnswer((a) => ({
            ...a,
            pending: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }))
      }
    }, signal)
    owner.refreshes = refreshes
    refreshes.open()
    return () => {
      owner.live = false
      ++owner.generation
      refreshes.close()
    }
  }, [owner, key, signal, enabled, visible])
  const refresh = useCallback(() => owner.refreshes?.refresh(), [owner])
  return {
    data: answer.data,
    error: answer.error,
    pending: answer.pending,
    failed: answer.error !== null,
    fetchedAt: answer.fetchedAt,
    refresh,
  }
}
