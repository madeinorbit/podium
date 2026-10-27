import { reaction } from 'mobx'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TipEngine } from './tip-engine'
import type { TipId, TipMoment } from './types'

export const TipContext = createContext<TipEngine | null>(null)
export function useTipMoment(id: TipId, moment: TipMoment): void {
  const engine = useContext(TipContext)
  const latest = useRef(moment)
  useLayoutEffect(() => {
    latest.current = moment
  })
  useEffect(() => engine?.register(id, () => latest.current), [engine, id])
  useEffect(() => {
    engine?.refresh()
  })
}

/**
 * True while `id` could still show on its own: the log is ready, tips are on
 * and the moment is unseen. Gate expensive watchers (visibility observers,
 * candidate scans) on it; keep the cheap registration for guide replay.
 */
export function useTipUnseen(id: TipId): boolean {
  const engine = useContext(TipContext)
  const read = (): boolean =>
    !!engine && engine.log.ready && engine.log.enabled && !engine.log.isSeen(id)
  const [unseen, setUnseen] = useState(read)
  // biome-ignore lint/correctness/useExhaustiveDependencies: read closes over engine and id
  useEffect(() => reaction(read, setUnseen, { fireImmediately: true }), [engine, id])
  return unseen
}
