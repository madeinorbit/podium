import type { SessionView } from '@podium/client-core/session-values'
import { useStoreHandle } from '@podium/client-core/react'
import { lazy } from '@podium/mobx-helpers'
import { action, compareShallow, observableRef, reaction } from 'mobx'
import { useEffect, useState } from 'react'
import type { Trpc } from './trpc'
import type { WaterfallActivitySample } from './flight-deck-waterfall'

/** Explicit visible-session request input. Membership equality belongs to the
 * ID list, rather than a signature of record payloads or the retained crew. */
class ActivityWindow {
  @observableRef accessor sessions: readonly SessionView[] = []
  @lazy({ equals: compareShallow }) get ids(): string[] {
    return [...new Set(this.sessions.map(session => session.sessionId))]
  }
  @action show(sessions: readonly SessionView[]): void { this.sessions = sessions }
}

/** One-off activity demand for callers that already supply their visible
 * session window. The mission's bars use their per-session companions. */
export function useWaterfallActivity(sessions: readonly SessionView[]): ReadonlyMap<string, WaterfallActivitySample[]> {
  const query = useStoreHandle<Trpc>().access.trpc.sessions?.activityHistory?.query
  const [window] = useState(() => new ActivityWindow())
  const [samples, setSamples] = useState<ReadonlyMap<string, WaterfallActivitySample[]>>(() => new Map())
  useEffect(() => window.show(sessions), [window, sessions])
  useEffect(() => {
    let request = 0
    const stop = reaction(() => window.ids, ids => {
      const version = ++request
      if (!query || ids.length === 0) return
      void query({ sessionIds: ids }).then(result => {
        if (request !== version) return
        const next = new Map<string, WaterfallActivitySample[]>()
        for (const id of ids) next.set(id, (result.sessions?.[id] ?? [])
          .map(sample => ({ at: Date.parse(sample.at), phase: sample.phase }))
          .filter(sample => Number.isFinite(sample.at)))
        setSamples(next)
      }).catch(() => {})
    }, { fireImmediately: true })
    return () => { request++; stop() }
  }, [window, query])
  return samples
}
