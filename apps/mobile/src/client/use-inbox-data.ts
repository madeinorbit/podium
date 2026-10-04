import type { IssueReferenceModel } from '@podium/client-core/values'
import { mobileInboxViews } from '@podium/client-graph/mobile-inbox'
import type { MobileInboxViews } from '@podium/client-graph/mobile-inbox-views'
import type { HostMetricsWire, IssueId, MachineWire } from '@podium/model'
import type { PodiumTarget } from '@podium/protocol'
import { useCallback, useEffect, useRef } from 'react'
import { demoEnabled } from './demoData'
import { useMobilePool, useMobilePoolProjection } from './mobile-pool'

type InboxData = ReturnType<MobileInboxViews['inbox']>
const EMPTY_INBOX: InboxData = {
  groups: { needsYou: [], idle: [], working: [] },
  issues: {},
  booting: true,
  outboxSize: 0,
}
const EMPTY_QUEUE: { queue: IssueId[]; booting: boolean } = {
  queue: [],
  booting: true,
}
const EMPTY_ROWS: ReturnType<MobileInboxViews['screeningRows']> = { issues: {}, loading: true }
const EMPTY_CHIP: { known: boolean; model: IssueReferenceModel | null } = {
  known: false,
  model: null,
}
const EMPTY_LIVE: { machines: readonly MachineWire[]; hosts: readonly HostMetricsWire[] } = {
  machines: [],
  hosts: [],
}
const EMPTY_LINK = {
  booting: true,
  route: null as string | null,
  sessions: [] as import('@podium/client-core/session-values').SessionView[],
}
type Pool = Parameters<typeof mobileInboxViews>[0]
const readInbox = (pool: Pool) => mobileInboxViews(pool)?.inbox() ?? EMPTY_INBOX
const readQueue = (pool: Pool) => mobileInboxViews(pool)?.screening() ?? EMPTY_QUEUE
const readMachines = (pool: Pool) => pool.headerViews.machines()
const readHosts = (pool: Pool) => pool.headerViews.metrics()

/** Readers stay mounted while the existing pool attaches. */
export function useInboxData(): InboxData {
  const data = useMobilePoolProjection(readInbox, EMPTY_INBOX)
  return demoEnabled() && data.booting ? { ...data, booting: false } : data
}

export function useScreeningQueue(): typeof EMPTY_QUEUE {
  const data = useMobilePoolProjection(readQueue, EMPTY_QUEUE)
  return demoEnabled() && data.booting ? { ...data, booting: false } : data
}

export function useScreeningRows(ids: readonly string[]) {
  const read = useCallback(
    (pool: Pool) => mobileInboxViews(pool)?.screeningRows(ids) ?? EMPTY_ROWS,
    [ids],
  )
  return useMobilePoolProjection(read, EMPTY_ROWS)
}

export function usePoolRefChip(token: string, refKind: 'issue' | 'session', prefix: string) {
  const read = useCallback(
    (pool: Pool) => mobileInboxViews(pool)?.chip(token, refKind, prefix) ?? EMPTY_CHIP,
    [token, refKind, prefix],
  )
  return useMobilePoolProjection(read, EMPTY_CHIP)
}

export function usePulseLive() {
  // Independent projections preserve the machine array identity when only a
  // health sample moves; Pulse's polling effect depends on that identity.
  const machines = useMobilePoolProjection(readMachines, EMPTY_LIVE.machines)
  const hosts = useMobilePoolProjection(readHosts, EMPTY_LIVE.hosts)
  return { machines, hosts }
}

/** Pending handoffs observe their addressed target. Ordinary taps read the
 * same current pool at dispatch and asynchronously wait only for LOADING. */
export function usePoolLinkData(target: PodiumTarget | null) {
  const pool = useMobilePool()
  const current = useRef(pool)
  current.current = pool
  const waiting = useRef(
    new Set<{ target: PodiumTarget; resolve: (route: string | null) => void }>(),
  )
  const read = useCallback(
    (current: Pool) => {
      const views = mobileInboxViews(current)
      const route = target && views ? views.route(target) : null
      const session =
        target?.kind === 'session' && views ? views.session(target.session) : undefined
      return {
        booting:
          !views || views.booting() || typeof route === 'symbol' || typeof session === 'symbol',
        route: typeof route === 'string' ? route : null,
        sessions: session && typeof session !== 'symbol' ? [session] : [],
      }
    },
    [target],
  )
  const data = useMobilePoolProjection(read, EMPTY_LINK)
  // biome-ignore lint/correctness/useExhaustiveDependencies: readiness retriggers early taps after the source is registered on the same pool
  useEffect(() => {
    const views = pool && mobileInboxViews(pool)
    if (!views) return
    for (const request of waiting.current) {
      waiting.current.delete(request)
      void Promise.resolve(views.resolveRoute(request.target)).then(request.resolve)
    }
  }, [pool, data.booting])
  useEffect(
    () => () => {
      for (const request of waiting.current) request.resolve(null)
      waiting.current.clear()
    },
    [],
  )
  // Keep the activator stable while null becomes a pool: an early tap waits
  // for this owner, and teardown cancels it through the host's active guard.
  const resolveRoute = useCallback((next: PodiumTarget) => {
    const views = current.current && mobileInboxViews(current.current)
    if (views) return views.resolveRoute(next)
    return new Promise<string | null>((resolve) => {
      waiting.current.add({ target: next, resolve })
    })
  }, [])
  return { ...data, resolveRoute }
}

/** The deck's already-decided prefix stays fixed while the live queue changes. */
export function reconcileScreeningIds(order: IssueId[], index: number, queue: readonly IssueId[]) {
  const screenable = new Set(queue),
    seen = new Set(order),
    decided = order.slice(0, index)
  return {
    order: [
      ...decided,
      ...order.slice(index).filter((id) => screenable.has(id)),
      ...queue.filter((id) => !seen.has(id)),
    ],
    index: decided.length,
  }
}
