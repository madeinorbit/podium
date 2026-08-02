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

  constructor(ports: BootFetchPorts<TApi>) {
    this.ports = ports
  }

  /** Enrich the registered repos with branch/worktree metadata (fast — no
   *  filesystem walk). Discovery scanning happens explicitly via the scan flow. */
  async refreshRepos(): Promise<void> {
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

  async refreshPersonalSettings(): Promise<void> {
    const settings = await this.ports.api.settings.get.query()
    this.ports.publish({ sidebarSettings: settings.sidebar })
  }

  async refreshReplicatedLayout(mutationIds: readonly string[]): Promise<void> {
    const snapshot = await this.ports.api.layout.get.query()
    this.ports.replicatedLayout.reconcile(snapshot, mutationIds)
  }
}
