/**
 * THE NETWORK ENRICHMENTS (POD-404, split out of the old `engine.ts`).
 *
 * Repos, pins, tab orders, personal settings and the replicated layout are
 * fetched over tRPC rather than replicated. They are ENRICHMENTS, not the source
 * of truth for the principal's slice: a cold offline boot must keep serving the
 * persisted replica rather than replacing it with a connection error, so every
 * caller runs these detached and swallows the failure.
 *
 * They are principal-scoped by the transport that carries them — the tRPC client
 * is authenticated, so `pins.list` answers for whoever the cookie says you are
 * (ADR 3 D7). Nothing here passes an identity; nothing here may start one.
 */

import type { PodiumClientApi } from '../api'
import type { ReplicatedLayoutController } from './replicated-layout'
import type { EngineState } from './state'

export interface BootFetchPorts<TApi extends PodiumClientApi> {
  readonly api: TApi
  readonly publish: (patch: Partial<EngineState>) => void
  readonly replicatedLayout: ReplicatedLayoutController
}

export class BootFetches<TApi extends PodiumClientApi> {
  private readonly ports: BootFetchPorts<TApi>
  /** The repo refresh currently on the wire, if any — see {@link refreshRepos}. */
  private reposInflight?: Promise<void>
  /** The single follow-up run promised to triggers that landed mid-flight. */
  private reposTrailing?: Promise<void>

  constructor(ports: BootFetchPorts<TApi>) {
    this.ports = ports
  }

  /**
   * Enrich the registered repos with branch/worktree metadata (fast — no
   * filesystem walk). Discovery scanning happens explicitly via the scan flow.
   *
   * COALESCED. Three triggers overlap on a cold boot — the boot fan-out, the
   * machines listener seeing the online count climb 0→N, and any
   * worktreesChanged event — and each used to put its own server-side repo
   * enrichment mutation on the wire concurrently. A call while one is in
   * flight now joins ONE trailing follow-up instead: it runs after the current
   * mutation settles, so the answer a mid-flight trigger gets is never staler
   * than its cause (a worktreesChanged arriving mid-refresh still produces a
   * post-change read), and N overlapping triggers cost at most two mutations.
   */
  refreshRepos(): Promise<void> {
    if (this.reposInflight) {
      this.reposTrailing ??= this.reposInflight
        // The trailing run is owed regardless of how the current one ends; its
        // own outcome is what this promise reports.
        .catch(() => {})
        .then(() => {
          this.reposTrailing = undefined
          return this.startRefreshRepos()
        })
      return this.reposTrailing
    }
    return this.startRefreshRepos()
  }

  private startRefreshRepos(): Promise<void> {
    const run = this.doRefreshRepos().finally(() => {
      if (this.reposInflight === run) this.reposInflight = undefined
    })
    this.reposInflight = run
    return run
  }

  private async doRefreshRepos(): Promise<void> {
    this.ports.publish({ reposLoading: true })
    try {
      const r = await this.ports.api.discovery.refreshRepos.mutate()
      this.ports.publish({ repos: r.repositories, repoDiagnostics: r.diagnostics })
    } finally {
      this.ports.publish({ reposLoading: false, reposLoaded: true })
    }
  }

  async refreshPins(): Promise<void> {
    this.ports.publish({ pins: await this.ports.api.pins.list.query() })
  }

  async refreshTabOrders(): Promise<void> {
    this.ports.publish({ tabOrders: await this.ports.api.tabs.listOrders.query() })
  }

  /** The signed-in user's superagent threads (POD-330, audit item zero). The
   *  authority scopes the query to the caller, so this is the ONLY thread list
   *  the client can obtain — there is no by-user variant to reach for. */
  async refreshSuperThreads(): Promise<void> {
    this.ports.publish({ superThreads: await this.ports.api.superagent.listThreads.query() })
  }

  async refreshPersonalSettings(): Promise<void> {
    const settings = await this.ports.api.settings.get.query()
    this.ports.publish({ sidebarSettings: settings.sidebar })
  }

  async refreshReplicatedLayout(mutationIds: readonly string[]): Promise<void> {
    const snapshot = await this.ports.api.layout.get.query()
    this.ports.replicatedLayout.reconcile(snapshot, mutationIds)
  }
}
