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
