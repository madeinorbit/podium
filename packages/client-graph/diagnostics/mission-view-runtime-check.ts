import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
import type { ClientRuntime } from '@podium/client-core/engine'
import { runInAction } from 'mobx'
import type { MobxPool } from '../src/pool'
import { checkMissionViewFromStore } from './mission-view-check'

/** Explicit checks run outside input handling. No hot-path legacy oracle. */
export function installMissionViewCheck(runtime: ClientRuntime, pool: MobxPool): () => void {
  if (typeof window === 'undefined') return () => {}
  let disposed = false
  let result: ReturnType<typeof checkMissionViewFromStore> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let quietUntil = performance.now()
  const input = () => { quietUntil = performance.now() + 250 }
  const events = ['pointerdown', 'pointerup', 'keydown', 'keyup', 'click', 'wheel', 'input'] as const
  for (const event of events) window.addEventListener(event, input, { capture: true, passive: true })
  const check = () => {
    timer = undefined
    if (disposed) return
    const delay = quietUntil - performance.now()
    if (delay > 0) { timer = setTimeout(check, delay); return }
    result = runInAction(() => checkMissionViewFromStore(pool, referenceState(runtime)))
  }
  const api = { request: () => { if (!timer && !disposed) timer = setTimeout(check, 250) }, read: () => result }
  Object.assign(window, { __missionViewCheck: api })
  if (new URLSearchParams(location.search).get('mobxPaneCheck') === '1') api.request()
  return () => {
    disposed = true
    if (timer) clearTimeout(timer)
    for (const event of events) window.removeEventListener(event, input, true)
    if (Reflect.get(window, '__missionViewCheck') === api) Reflect.deleteProperty(window, '__missionViewCheck')
  }
}
