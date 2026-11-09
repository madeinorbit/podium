/**
 * Engine-facing shared types (#262 [spec:SP-3fe2]): the server-config, notice,
 * user-focus, and runtime access seams the non-React engine and the thin React
 * binding both speak. Plain TypeScript — no React imports (that's the point of
 * the engine split: everything here must be consumable by a native/headless
 * client).
 */

import type { PodiumClientApi } from '../api'

export interface AutomationsCommands<_TApi extends PodiumClientApi = PodiumClientApi> {
  /**
   * Approve or deny an agent's request (POD-6674): `decision` on its `approval`
   * effect record, against the record `revision` the person saw. Resolves once
   * the edit is durable in the outbox; a refusal (decided elsewhere first)
   * shows on the record and in the outbox's notices.
   */
  decideApproval: (id: string, decision: 'approve' | 'deny', revision: number) => Promise<void>
  /**
   * Turn one of my trigger subscriptions on or off (POD-6676): `enabled` on its
   * `subscription` record, by its feed id. Resolves once the edit is durable in
   * the outbox; a refusal shows in the outbox's notices.
   */
  setSubscriptionEnabled: (id: string, enabled: boolean) => Promise<void>
  /** Remove one of my trigger subscriptions: its record, by its feed id. */
  removeSubscription: (id: string) => Promise<void>
}
