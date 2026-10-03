import { groupSessions, withoutShells } from '@podium/client-core/focus'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { IssueReferenceModel } from '@podium/client-core/viewmodels'
import type { HostMetricsWire, IssueId, MachineWire } from '@podium/model'
import type { PodiumTarget } from '@podium/protocol'
import { mobileInboxViews } from '@podium/client-graph/mobile-inbox'
import type { MobileInboxViews } from '@podium/client-graph/mobile-inbox-views'
import { useCallback, useMemo } from 'react'
import { buildScreeningQueue } from '../lib/screening'
import { demoEnabled } from './demoData'
import { useBooting, useHostMetrics, useIssues, useMachines, useOutboxSize, useSessions } from './hooks'
import { mobileDataLayer, useMobilePool, useMobilePoolProjection } from './mobile-pool'

type InboxData = ReturnType<MobileInboxViews['inbox']>
const EMPTY_INBOX: InboxData = { groups: { needsYou: [], idle: [], working: [] }, issues: {}, booting: true, outboxSize: 0 }
const EMPTY_QUEUE: { queue: IssueId[]; booting: boolean; legacyIssues?: IssueViewModel[] } = { queue: [], booting: true }
const EMPTY_ROWS: ReturnType<MobileInboxViews['screeningRows']> = { issues: {}, loading: true }
const EMPTY_CHIP: { known: boolean; model: IssueReferenceModel | null } = { known: false, model: null }
const EMPTY_LIVE: { machines: readonly MachineWire[]; hosts: readonly HostMetricsWire[] } = { machines: [], hosts: [] }
const EMPTY_LINK = { booting: true, route: null as string | null, sessions: [] as import('@podium/client-core/session-values').SessionView[] }
type Pool = Parameters<typeof mobileInboxViews>[0]
const readInbox = (pool: Pool) => mobileInboxViews(pool)?.inbox() ?? EMPTY_INBOX
const readQueue = (pool: Pool) => mobileInboxViews(pool)?.screening() ?? EMPTY_QUEUE
const readLive = (pool: Pool) => ({ machines: pool.headerViews.machines(), hosts: pool.headerViews.metrics() })

function useLegacyInbox(): InboxData {
  const sessions = useSessions(), issues = useIssues(), booting = useBooting(), outboxSize = useOutboxSize()
  const groups = useMemo(() => groupSessions(withoutShells(sessions)), [sessions])
  const byId = useMemo(() => Object.fromEntries(issues.map(issue => [issue.id, issue])), [issues])
  return { groups, issues: byId, booting, outboxSize }
}

/** This branch is the app-load latch, never the asynchronous pool attachment.
 * The enabled hook stays mounted while null becomes an attached pool. */
export function useInboxData(): InboxData {
  const data = mobileDataLayer() === 'pool' ? useMobilePoolProjection(readInbox, EMPTY_INBOX) : useLegacyInbox()
  return demoEnabled() && data.booting ? { ...data, booting: false } : data
}

function useLegacyQueue() {
  const issues = useIssues(), booting = useBooting()
  const queue = useMemo(() => buildScreeningQueue(issues).map(issue => issue.id), [issues])
  return { queue, booting, legacyIssues: issues }
}
export function useScreeningQueue(): typeof EMPTY_QUEUE {
  const data = mobileDataLayer() === 'pool' ? useMobilePoolProjection(readQueue, EMPTY_QUEUE) : useLegacyQueue()
  return demoEnabled() && data.booting ? { ...data, booting: false } : data
}

export function useScreeningRows(ids: readonly string[], legacyIssues?: IssueViewModel[]) {
  const read = useCallback((pool: Pool) => mobileInboxViews(pool)?.screeningRows(ids) ?? EMPTY_ROWS, [ids])
  const legacy = useMemo(() => ({ issues: Object.fromEntries((legacyIssues ?? []).map(issue => [issue.id, issue])), loading: false }), [legacyIssues])
  return mobileDataLayer() === 'pool' ? useMobilePoolProjection(read, EMPTY_ROWS) : legacy
}

export function usePoolRefChip(token: string, refKind: 'issue' | 'session', prefix: string) {
  const read = useCallback((pool: Pool) => mobileInboxViews(pool)?.chip(token, refKind, prefix) ?? EMPTY_CHIP, [token, refKind, prefix])
  return useMobilePoolProjection(read, EMPTY_CHIP)
}

function useLegacyPulseLive() { return { machines: useMachines(), hosts: useHostMetrics() } }
export function usePulseLive() {
  return mobileDataLayer() === 'pool' ? useMobilePoolProjection(readLive, EMPTY_LIVE) : useLegacyPulseLive()
}

/** Pending handoffs observe their addressed target. Ordinary taps read the
 * same current pool at dispatch and asynchronously wait only for LOADING. */
export function usePoolLinkData(target: PodiumTarget | null) {
  const pool = useMobilePool()
  const read = useCallback((current: Pool) => {
    const views = mobileInboxViews(current)
    const route = target && views ? views.route(target) : null
    const session = target?.kind === 'session' && views ? views.session(target.session) : undefined
    return { booting: !views || views.booting() || typeof route === 'symbol' || typeof session === 'symbol',
      route: typeof route === 'string' ? route : null,
      sessions: session && typeof session !== 'symbol' ? [session] : [] }
  }, [target])
  const data = useMobilePoolProjection(read, EMPTY_LINK)
  const resolveRoute = useCallback((next: PodiumTarget) => pool ? mobileInboxViews(pool)?.resolveRoute(next) ?? null : null, [pool])
  return { ...data, resolveRoute }
}

/** The deck's already-decided prefix stays fixed while the live queue changes. */
export function reconcileScreeningIds(order: IssueId[], index: number, queue: readonly IssueId[]) {
  const screenable = new Set(queue), seen = new Set(order), decided = order.slice(0, index)
  return { order: [...decided, ...order.slice(index).filter(id => screenable.has(id)), ...queue.filter(id => !seen.has(id))], index: decided.length }
}
