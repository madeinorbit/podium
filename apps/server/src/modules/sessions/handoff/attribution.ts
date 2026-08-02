/**
 * ATTRIBUTION — who moved this session, and on whose behalf (ADR 3 D17, ADR 9
 * D5 A3).
 *
 * ONE DERIVATION, TWO CONSUMERS, and that is why this is a module rather than
 * two private methods on two different phases. The authenticated principal is
 * read once, here, and stamped in both places a handoff records who did it:
 *
 *   - the bundle manifest's `format: 2` attribution, carried in the export
 *     binding (the transfer phase);
 *   - the durable `session.handoff` event (the receipt, below).
 *
 * Keeping one source is the point: two derivations of "the human" from the same
 * capability are two chances for the manifest and the event to disagree about
 * who did what, and the disagreement would only ever be visible after the fact.
 * Both read the transport capability; NEITHER reads payload identity.
 *
 * OWNERSHIP DOES NOT MOVE WITH THE SESSION (ADR 9 D5 A4). `owner` here is the
 * bundle's owning human — the existing delegation, carried across unchanged —
 * not a transfer-specific identity. Nothing in this file mints one.
 */

import type { MachineId } from '@podium/model'
import { actorAgent, actorDisplayId, actorUser, asAgentIdentityId } from '@podium/model'
import type { Session } from '../session'
import type { HandoffCaller, HandoffPorts } from './ports'

/**
 * The actor / on-behalf-of pair, plus the bundle's owning human, resolved from
 * the authenticated transport principal.
 */
export function exportedIdentity(caller: HandoffCaller) {
  switch (caller.principal.kind) {
    case 'user':
      return {
        exportedBy: {
          actor: actorUser(caller.principal.user),
          onBehalfOf: caller.principal.user,
        },
        owner: caller.principal.user,
      }
    case 'agent':
      return {
        exportedBy: {
          actor: actorAgent(asAgentIdentityId(caller.principal.agentSessionId)),
          onBehalfOf: caller.principal.onBehalfOf,
        },
        owner: caller.principal.onBehalfOf,
      }
    case 'system':
      // A handoff bundle is personal and must have a real owning human. A
      // system job has none; inventing one would violate ADR 3 D7/D21.
      throw new Error('system principal cannot export a personal handoff bundle')
  }
}

/** What a resolved handoff attribution looks like — derived, never restated. */
export type ExportedIdentity = ReturnType<typeof exportedIdentity>

/**
 * THE DURABLE ATTRIBUTION RECORD — the receipt, written once the target has
 * resumed and the move is a fact.
 *
 * The same authenticated CommandPrincipal that stamps the v2 bundle stamps this
 * event. Keeping one source prevents capability compatibility fields and the
 * resolved transport principal from disagreeing about the human.
 *
 * DELIBERATELY STILL INSIDE THE TRANSFER'S `try`. The receipt is the last act of
 * the transfer, not a step after it: an append that throws must fall into the
 * same catch as everything before it, which is what decides whether the target
 * or the source owns the session afterwards. Calling it from the coordinator
 * once the transfer returned would move that failure outside the arbitration.
 */
export function recordHandoff(
  ports: Pick<HandoffPorts, 'recordEvent'>,
  session: Session,
  fromMachineId: MachineId,
  toMachineId: MachineId,
  caller: HandoffCaller,
): void {
  const attribution = exportedIdentity(caller).exportedBy
  ports.recordEvent({
    ts: new Date().toISOString(),
    kind: 'session.handoff',
    subject: session.sessionId,
    payload: {
      sessionId: session.sessionId,
      fromMachineId,
      toMachineId,
      actor: actorDisplayId(attribution.actor),
      actorKind: attribution.actor.kind,
      onBehalfOf: attribution.onBehalfOf,
      ...(session.issueId ? { issueId: session.issueId } : {}),
    },
  })
}
