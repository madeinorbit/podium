import { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react'
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
