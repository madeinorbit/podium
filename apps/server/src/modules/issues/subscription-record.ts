/**
 * AUTOMATION TRIGGER SUBSCRIPTIONS AS A SYNCED RECORD (POD-6676, ADR 12 D1/D3;
 * design POD-5620 §1.11).
 *
 * A subscription reaches the feed as `subscription`, keyed
 * `subscriptionRowId(subscriberKind, subscriberId, id)` so the feed decides who
 * may read it, and who may read its removal, from the id alone.
 *
 * `records.subscription.edit` (`enabled`) and `.remove` replaced
 * `issues.subscriptionSetEnabled` and `issues.subscriptionRemove`, under the same
 * rule: a subscription is its SUBSCRIBER's (POD-6288). A person changes one whose
 * subscriber is a session they own or a task assigned to them; an agent (a
 * constrained caller) only its own derived subscriber's: its session, or the
 * root of its subtree. Admins get the same as anyone. The rule is read from the
 * row id and, for a person, one read of the subscriber's owner. A subscription
 * that is not the caller's fails as an unknown one.
 *
 * A subscription is created by `issues.subscriptionAdd`, which resolves the
 * watched source and checks it is in reach; its change entry commits with it.
 */

import { SUBSCRIPTION_RECORD } from '@podium/commands'
import {
  isPersonCapability,
  parseSubscriptionRowId,
  type SubscriberKind,
  type SubscriptionWire,
  subscriptionRowId,
  subscriptionRowIdOf,
  type UserId,
} from '@podium/model'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { SessionStore } from '../../store'
import { registerRecordKind } from '../records/generic'
import { SyncWriteRefused } from '../sync-write/entry'
import { NO_TARGET, type SyncWriteRegistry } from '../sync-write/registry'

/** What the boot reconcile appends through: the boot's `server` writer. */
export interface SubscriptionReconcileWriter {
  reconcile(entity: 'subscription', rows: { id: string; value: unknown }[]): Promise<unknown>
}

/**
 * THE BOOT BACK-FILL: subscriptions were stored long before they were synced,
 * so every stored row becomes an upsert on the log, and a logged row whose
 * storage is gone a removal. One read of the table. Rolling back needs no data
 * step: the table is unchanged, and an older build ignores the kind's rows.
 */
export async function reconcileSubscriptionRecords(
  writer: SubscriptionReconcileWriter,
  store: Pick<SessionStore['events'], 'allSubscriptionsForBootReconcile'>,
): Promise<void> {
  const rows = await store.allSubscriptionsForBootReconcile()
  await writer.reconcile(
    'subscription',
    rows.map((value) => ({ id: subscriptionRowIdOf(value), value })),
  )
}

export interface SubscriptionRecordDeps {
  modules(): RegistryModules
  /** The owner of each asked session, for a person's own-subscriber check. */
  sessionOwner(sessionId: string): Promise<UserId | null | undefined>
  /** The assignee of a task, for a person's own-subscriber check. */
  issueOwner(issueId: string): Promise<UserId | null | undefined>
}

/**
 * Is this subscriber the caller's own? A person's: a session they own or a task
 * assigned to them. An agent's: the subscriber `issues.subscriptionAdd` derives
 * for it, its session or its subtree's root.
 */
async function ownsSubscriber(
  principal: CommandPrincipal,
  subscriber: { kind: SubscriberKind; id: string },
  deps: SubscriptionRecordDeps,
): Promise<boolean> {
  if (principal.kind === 'system') return false
  const { capability } = principal
  if (isPersonCapability(capability)) {
    const human = onBehalfOfUser(principal)
    if (human === null) return false
    const owner =
      subscriber.kind === 'session'
        ? await deps.sessionOwner(subscriber.id)
        : await deps.issueOwner(subscriber.id)
    return owner === human
  }
  if (capability.actorSessionId) {
    return subscriber.kind === 'session' && subscriber.id === capability.actorSessionId
  }
  return (
    capability.scope.kind === 'subtree' &&
    subscriber.kind === 'issue' &&
    subscriber.id === capability.scope.rootId
  )
}

export function registerSubscriptionRecord(
  registry: SyncWriteRegistry,
  deps: SubscriptionRecordDeps,
): void {
  const attention = () => deps.modules().issues.attention
  /** The stored subscription this row id names, when it still names it. */
  const stored = async (rowId: string): Promise<SubscriptionWire | undefined> => {
    let key: ReturnType<typeof parseSubscriptionRowId>
    try {
      key = parseSubscriptionRowId(rowId)
    } catch {
      return undefined
    }
    const sub = await attention().subscriptionGet(key.id)
    return sub !== undefined &&
      subscriptionRowId(sub.subscriberKind, sub.subscriberId, sub.id) === rowId
      ? sub
      : undefined
  }

  registerRecordKind(registry, SUBSCRIPTION_RECORD, {
    target: async (_op, id, { principal }) => {
      const sub = await stored(id)
      if (sub === undefined) return undefined
      const mine = await ownsSubscriber(
        principal,
        { kind: sub.subscriberKind, id: sub.subscriberId },
        deps,
      )
      return mine ? NO_TARGET : undefined
    },
    edit: async (ctx, id, patch) => {
      const sub = await stored(id)
      if (sub === undefined) throw new SyncWriteRefused({ kind: 'target-not-found' })
      const enabled = patch.enabled
      if (typeof enabled !== 'boolean') return { ok: true }
      await attention().subscriptionSetEnabled(ctx.ledger, sub.id, enabled)
      return { ok: true }
    },
    remove: async (ctx, id) => {
      const sub = await stored(id)
      if (sub === undefined) throw new SyncWriteRefused({ kind: 'target-not-found' })
      await attention().subscriptionRemove(ctx.ledger, sub.id)
      return { ok: true }
    },
  })
}
