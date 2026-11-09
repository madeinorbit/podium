import type { SessionId } from '@podium/model'
import type { SessionView } from '../../session-values'
import {
  knownTabIds,
  knownTabIdsForWorkspace,
  NAVIGATION_LOADING,
  type PruningState,
  referencedTabIds,
  type ScreenState,
  visibleTabIds,
  workspacesPatch,
} from '../../ui/state'
import { allTabIds, pruneWorkspace, type TabId } from '../../values'
import { ServiceLifetime } from './lifetime'
import { observeNavigation } from './observe-navigation'

export const WORKSPACE_PRUNE_GRACE_MS = 20_000

export interface TabPruningPorts {
  state(): ScreenState
  publish(patch: Partial<ScreenState>): void
  pruneGraceMs?: number
  /** A rehome must open its destination before the origin can drop the tab. */
  ready?(): boolean
}

function pruningState(state: ScreenState): PruningState {
  const ids = referencedTabIds(state)
  for (const id of visibleTabIds(state)) ids.add(id)
  for (const tab of state.fileTabs) {
    if (tab.scope.kind === 'session') ids.add(tab.scope.sessionId)
  }
  const sessions: SessionView[] = []
  const pending = new Set<string>()
  const loading = new Set<string>()
  for (const id of ids) {
    if (id.startsWith('file:')) continue
    const session = state.navigation.sessionMembership
      ? state.navigation.sessionMembership(id)
      : state.navigation.session(id)
    if (session === NAVIGATION_LOADING) {
      pending.add(id as SessionId)
      loading.add(id)
    } else if (session) sessions.push(session as SessionView)
  }
  for (const tab of state.fileTabs) {
    if (tab.scope.kind === 'session' && loading.has(tab.scope.sessionId))
      pending.add(tab.id as SessionId)
  }
  // Define own properties rather than invoking the inherited lazy-list setter.
  return Object.create(
    state,
    Object.getOwnPropertyDescriptors({ sessions, pendingSpawnIds: pending }),
  )
}

export class TabPruningService {
  private readonly lifetime = new ServiceLifetime()
  private readonly unknownSince = new Map<TabId, number>()
  private pruneTimer: ReturnType<typeof setTimeout> | null = null
  private readonly pruneGraceMs: number
  constructor(private readonly ports: TabPruningPorts) {
    this.pruneGraceMs = ports.pruneGraceMs ?? WORKSPACE_PRUNE_GRACE_MS
  }
  start(): void {
    if (!this.lifetime.start()) return
    this.lifetime.add(
      observeNavigation(
        () => this.ports.state().navigation,
        () => {
          const state = pruningState(this.ports.state())
          return [
            this.ports.ready?.() ?? true,
            state.workspaces,
            state.fileTabs,
            state.sessions.map((s) => [s.sessionId, s.cwd, s.issueId]),
            [...state.pendingSpawnIds],
            Object.keys(state.workspaces).map((key) => [...knownTabIdsForWorkspace(state, key)]),
          ]
        },
        () => this.queuePrune(),
      ),
    )
    // A topology batch follows the session before pruning its origin.
  }
  private queuePrune(): void {
    const current = this.lifetime.guard()
    queueMicrotask(() =>
      queueMicrotask(() => {
        if (current()) this.pruneWorkspaces()
      }),
    )
  }
  stop(): void {
    this.lifetime.stop()
    if (this.pruneTimer !== null) clearTimeout(this.pruneTimer)
    this.pruneTimer = null
    this.unknownSince.clear()
  }
  dispose(): void {
    this.stop()
    this.lifetime.dispose()
  }
  pruneWorkspaces(): void {
    if (this.ports.ready?.() === false) return
    const st = pruningState(this.ports.state())
    const referenced = referencedTabIds(st)
    const globallyKnown = knownTabIds(st)
    // A session-scoped file RECORD with no workspace tab naming it is still a
    // candidate: its resolvability runs on the same grace clock as a ghost tab.
    // Without this the record outlived its session forever whenever no layout
    // referenced it (this issue). Resolvable records stay globally known and
    // are skipped below, so only dead scopes can run out of grace.
    const candidates = new Set<TabId>(referenced)
    for (const tab of st.fileTabs) candidates.add(tab.id)
    for (const id of [...this.unknownSince.keys()]) {
      if (!candidates.has(id) || globallyKnown.has(id)) this.unknownSince.delete(id)
    }
    if (this.pruneTimer !== null) {
      clearTimeout(this.pruneTimer)
      this.pruneTimer = null
    }
    const now = Date.now()
    const gone = new Set<TabId>()
    let soonest = Number.POSITIVE_INFINITY
    for (const id of candidates) {
      if (globallyKnown.has(id)) continue
      const since = this.unknownSince.get(id) ?? now
      this.unknownSince.set(id, since)
      const left = this.pruneGraceMs - (now - since)
      if (left <= 0) gone.add(id)
      else soonest = Math.min(soonest, left)
    }
    if (Number.isFinite(soonest)) {
      this.pruneTimer = setTimeout(() => {
        this.pruneTimer = null
        this.pruneWorkspaces()
      }, soonest)
    }
    // A record whose id ran out of grace goes WITH the tab (POD-1247). File tabs
    // are persisted now, so a record left behind would be re-hydrated on the
    // next reload, re-open its ghost, and be swept again — forever.
    const fileTabs = st.fileTabs.filter((tab) => !gone.has(tab.id))
    this.ports.publish({
      ...(fileTabs.length === st.fileTabs.length ? {} : { fileTabs }),
      ...workspacesPatch(st, (ws) => {
        const memberKnown = knownTabIdsForWorkspace(st, ws.key)
        const keep = new Set<TabId>()
        for (const id of allTabIds(ws)) {
          if (gone.has(id)) continue
          if (memberKnown.has(id)) {
            keep.add(id)
            continue
          }
          // Exists in the replica but not in this workspace — a rehome. Drop now.
          if (globallyKnown.has(id)) continue
          keep.add(id)
        }
        return pruneWorkspace(ws, keep)
      }),
    })
  }
}
