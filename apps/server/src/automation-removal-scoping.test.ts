/**
 * THE BROADCAST SEAM FOR A DELETION (POD-1509).
 *
 * ---------------------------------------------------------------------------
 * WHAT BROKE, STATED AS A MECHANISM
 * ---------------------------------------------------------------------------
 *
 * The scoped feed decides whether a change may be delivered by asking the
 * visibility policy *"may this principal read this entity?"*, and the policy
 * resolves an automation's owner by LOOKING THE ROW UP. A commit writes before
 * it scopes (ADR 2 D10: the entity write and the change append are one span and
 * the broadcast follows it), so by the time a `remove` is evaluated the row is
 * gone, the owner reads as `undefined`, and the row is refused as
 * `personal-not-granted`.
 *
 * The refusal is then INVISIBLE, because the protocol works correctly: a
 * suppressed row still advances the connection's certified position, so the
 * client is sent `changes: []` over the range — a watermark. The removal is
 * certified as delivered and never sent, and every replica keeps a phantom
 * automation until it re-bootstraps. That is why the browser only saw it as
 * "the card stays until you reload".
 *
 * ---------------------------------------------------------------------------
 * WHY THE ASSERTION IS HERE AND NOT ONLY IN THE BROWSER
 * ---------------------------------------------------------------------------
 *
 * A browser test proving the card disappears is necessary and not sufficient: it
 * passes again for any reason the row happens to leave the DOM, and it says
 * nothing about WHICH seam carried it. This drives the REAL composition — the
 * real store, the real `Ledger`/`Authority`, and the real
 * `GrantEdgeVisibilityPolicy` built in `relay.ts` — and asserts the delivery the
 * owner's principal actually receives. Nothing here re-implements the policy; a
 * harness that computed its own expectation of the slice would be grading the
 * fix against a second implementation of the thing under test.
 *
 * THE UPSERT ARM IS THE CONTROL, and it is load-bearing rather than decorative:
 * the create was never broken, so an assertion that only checked the remove
 * could pass against a subscription that receives nothing at all.
 */

import { asCapabilityRef, asDeviceId, type Principal } from '@podium/protocol'
import { asAutomationRunId, asUserId, SOLE_USER_ID } from '@podium/model'
import type { Ledger, ScopedDelivery } from '@podium/sync'
import { describe, expect, it } from 'vitest'
import { userCommandPrincipal } from './command-principal'
import { SessionRegistry } from './relay'
import type { AutomationRunRow } from './store/automations'

/** The one store method this suite reaches for, named rather than `any`. */
interface AutomationRunWriter {
  addRun(run: AutomationRunRow): void
}

/** `SOLE_USER_ID` is declared as a plain string; the brand is applied here, at
 *  the one edge this suite has, rather than at four call sites. */
const OWNER = asUserId(SOLE_USER_ID)

/** The principal a real connection is served under — `relay.ts` builds this same
 *  shape from the authenticated transport, never from a payload. */
const feedPrincipalFor = (userId: string): Principal => ({
  kind: 'user',
  user: asUserId(userId),
  device: asDeviceId(`dev:${userId}`),
  capability: asCapabilityRef(`cap:${userId}`),
})

interface Row {
  entity: string
  entityId: string
  op: string
}

/** The registry's own `Ledger` — private, so this is the one place that names the
 *  reach-in, rather than a cast repeated at every call site. */
const ledgerOf = (reg: SessionRegistry): Ledger => (reg as unknown as { ledger: Ledger }).ledger

/** Every row this principal was actually DELIVERED, flattened across batches. A
 *  watermark (`changes: []`) contributes nothing, which is precisely the bug's
 *  signature — the range is certified and the row is absent. */
function deliveriesFor(reg: SessionRegistry, principal: Principal): Row[] {
  const seen: Row[] = []
  ledgerOf(reg).authority.subscribe(principal, (delivery: ScopedDelivery) => {
    if (delivery.kind !== 'batch') return
    for (const change of delivery.changes) {
      seen.push({ entity: change.entity, entityId: change.entityId, op: change.op })
    }
  })
  return seen
}

const automationInput = {
  name: 'Nightly sweep',
  repoPath: '/repos/podium',
  cron: '0 3 * * *',
  agentKind: 'claude-code',
  prompt: 'sweep',
  enabled: false,
}

describe('POD-1509 — a removal reaches the principal who owned the row', () => {
  it("delivers the automation's `remove` to its owner, not a bare watermark", () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    const principal = userCommandPrincipal(OWNER, 'admin')
    const delivered = deliveriesFor(reg, feedPrincipalFor(SOLE_USER_ID))

    const created = reg.modules.automations.create(automationInput, principal)

    // CONTROL: the arm that always worked. If this is empty the subscription is
    // wrong and the remove assertion below would pass for the wrong reason.
    expect(delivered).toContainEqual({
      entity: 'automation',
      entityId: created.id,
      op: 'upsert',
    })

    expect(reg.modules.automations.remove(created.id, principal)).toEqual({ removed: true })

    // THE ASSERTION THAT WAS FAILING. Before the fix this array held the upsert
    // and nothing else: the removal was evaluated, refused, and turned into a
    // watermark the client could not distinguish from an idle tick.
    expect(delivered).toContainEqual({
      entity: 'automation',
      entityId: created.id,
      op: 'remove',
    })

    // …and the row really is gone from the server's own truth, so this is a
    // deletion that was BROADCAST rather than a broadcast that was faked.
    expect(reg.modules.automations.list()).toEqual([])
  })

  it("delivers a run's `remove` too — the cascade no longer fires, so it is stamped", () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    const principal = userCommandPrincipal(OWNER, 'admin')
    const delivered = deliveriesFor(reg, feedPrincipalFor(SOLE_USER_ID))
    const store = (reg as unknown as { store: { automations: AutomationRunWriter } }).store

    const created = reg.modules.automations.create(automationInput, principal)
    // THROUGH THE LEDGER, exactly as `recordRun` does, and not straight into the
    // store. The Authority drops a `remove` for an id its log never recorded, so
    // a run inserted behind the ledger would make this assertion fail for a
    // reason that has nothing to do with scoping. Driving a real scheduler tick
    // instead would make the spawn a dependency of a scoping assertion.
    const run: AutomationRunRow = {
      id: asAutomationRunId('run_pod1509'),
      automationId: created.id,
      firedAt: new Date().toISOString(),
      sessionId: null,
      outcome: 'missed',
      detail: null,
      actor: OWNER,
      onBehalfOf: OWNER,
    }
    ledgerOf(reg).commit({
      write: () => store.automations.addRun(run),
      changes: () => [{ entity: 'automationRun', id: run.id, op: 'upsert', value: run }],
    })

    reg.modules.automations.remove(created.id, principal)

    // `automation_runs` used to leave through `ON DELETE CASCADE`. The parent row
    // now survives as a tombstone, so that cascade does not fire and the child
    // must be stamped explicitly — and its removal is scoped through
    // `runOwnerOf`, which is a SECOND lookup that reads past a tombstone. Without
    // this arm that line is never entered by any test.
    expect(delivered).toContainEqual({
      entity: 'automationRun',
      entityId: 'run_pod1509',
      op: 'remove',
    })
    expect(reg.modules.automations.runs(created.id)).toEqual([])
  })

  it('does not deliver another user’s removal — the fix widens delivery, not visibility', () => {
    const reg = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    const owner = userCommandPrincipal(OWNER, 'admin')
    const stranger = deliveriesFor(reg, feedPrincipalFor('user:someone-else'))

    const created = reg.modules.automations.create(automationInput, owner)
    reg.modules.automations.remove(created.id, owner)

    // Reading ownership THROUGH the tombstone must not become "everyone may see
    // deletions". A principal who could never see the automation is told
    // nothing about it — not its creation and not its removal. Without this the
    // fix would be an existence leak wearing a bug fix's clothes.
    expect(stranger.filter((row) => row.entityId === created.id)).toEqual([])
  })
})
