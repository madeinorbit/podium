/**
 * AN AGENT'S ACTION OFFER ON THE SYNC WRITE ENTRY POINT (POD-6419; [spec:SP-c7f1]).
 *
 * `podium offer` sets or clears the calling session's offer: one message and up
 * to six action buttons, shown to the user with the session. The offer is a field
 * of the synced session record, so its two writes are sync commands: they enter
 * through `submit`, deduplicate by the envelope's mutationId, and their session
 * row carries the command's provenance. Nothing outside the database runs: the
 * write is the row and its push.
 *
 * CLASSIFIED SYNCED, not plain (ADR 12 D1): the offer is lasting state on a record
 * every device lists ("needs you", the tray card), written by the agent.
 *
 * THE TARGET IS THE CALLING SESSION, taken from the capability, never from the
 * input: an agent can only offer on its own session, so no scope check applies (a
 * session is always within its own scope). Refused before the handler: a caller
 * with no session behind it, and (for `set`) a session that works under a
 * coordinator (POD-6108 D5: only a session with no coordinator above it may put a
 * decision in front of the user).
 *
 * THE INPUT KEEPS ITS SENTENCES. The schema below only shapes the input; the
 * limits are checked by the handler with the sentences the relay arm has always
 * answered, so an agent reading a refusal reads the same rule as before.
 *
 * TRANSPORTS: the relay only (an agent's `podium offer`). The new CLI sends
 * `sync.submit` through the relay; the old `offer.set`/`offer.clear` relay arm is
 * a LEGACY adapter onto `submit` for an older CLI (`relay-dispatch.ts`).
 */

import { type CommandDef, defineCommands } from '@podium/commands'
import type { SessionId } from '@podium/model'
import { bareSelfRefCount, selfRefNudge } from '@podium/protocol'
import { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { seatRefusal } from '../issues/service/seat'
import { SyncWriteRefused } from '../sync-write/entry'
import {
  NO_TARGET,
  refuseTarget,
  type SyncWriteRegistry,
  type SyncWriteTarget,
} from '../sync-write/registry'

/** The shape of `podium offer`'s input; its limits are the handler's (see the header). */
const OfferSetInput = z.object({
  message: z.unknown(),
  actions: z.unknown(),
  artifacts: z.unknown().optional(),
})

const OfferClearInput = z.object({}).passthrough()

const RELAY_ONLY = ['relay'] as const

export const offerCommands = defineCommands('offer', {
  set: {
    input: OfferSetInput,
    action: 'write',
    exposure: RELAY_ONLY,
    conflict: 'single-writer',
    visibility: 'owned-compute',
    cli: { summary: "Set the calling session's action offer." },
  },
  clear: {
    input: OfferClearInput,
    action: 'write',
    exposure: RELAY_ONLY,
    conflict: 'single-writer',
    visibility: 'owned-compute',
    cli: { summary: "Remove the calling session's action offer." },
  },
} satisfies Record<'set' | 'clear', CommandDef>)

export const OFFER_SYNC_COMMANDS = ['offer.set', 'offer.clear'] as const

const refused = (message: string): never => {
  throw new SyncWriteRefused({ kind: 'invalid', message })
}

interface OfferAction {
  label: string
  prompt: string
  input?: true
}

/** The offer as the relay arm validated it, with the same sentences. */
function validOffer(raw: z.infer<typeof OfferSetInput>): {
  message: string
  actions: OfferAction[]
  artifacts?: string[]
} {
  const message = typeof raw.message === 'string' ? raw.message.trim() : ''
  if (!message || message.length > 4_000) refused('message must contain 1..4000 characters')
  if (!Array.isArray(raw.actions)) refused('actions must be an array')
  const rawActions = raw.actions as unknown[]
  if (rawActions.length > 6) refused('at most 6 actions are allowed')
  const actions = rawActions.map((a, i): OfferAction => {
    const rec = (a ?? {}) as Record<string, unknown>
    const label = typeof rec.label === 'string' ? rec.label.trim() : ''
    const prompt = typeof rec.prompt === 'string' ? rec.prompt.trim() : ''
    if (!label || label.length > 80) {
      refused(`action ${i + 1}: label must contain 1..80 characters`)
    }
    if (!prompt || prompt.length > 4_000) {
      refused(`action ${i + 1}: prompt must contain 1..4000 characters`)
    }
    // Feedback-collecting action [spec:SP-c7f1]: the UI asks for freeform text
    // before sending, appended to the prompt.
    return rec.input === true ? { label, prompt, input: true } : { label, prompt }
  })
  // Issue-artifact references [POD-120]: bare paths, resolved by the client
  // against the issue panel's artifact list — validated here only for shape
  // (the artifact may legitimately not exist yet).
  if (raw.artifacts === undefined) return { message, actions }
  if (!Array.isArray(raw.artifacts)) refused('artifacts must be an array')
  const rawArtifacts = raw.artifacts as unknown[]
  if (rawArtifacts.length > 6) refused('at most 6 artifacts are allowed')
  const artifacts = rawArtifacts.map((p, i) => {
    const path = typeof p === 'string' ? p.trim() : ''
    if (!path || path.length > 512)
      refused(`artifact ${i + 1}: path must contain 1..512 characters`)
    return path
  })
  return artifacts.length > 0 ? { message, actions, artifacts } : { message, actions }
}

/** The session behind the call, from the capability; never from the input. */
const actorOf = (principal: CommandPrincipal): SessionId | undefined =>
  principal.kind === 'system' ? undefined : principal.capability.actorSessionId

const NO_ACTOR = refuseTarget({
  kind: 'unauthorized',
  message: 'offer is only callable by a session (no actor bound)',
})

export interface OfferSyncDeps {
  modules(): RegistryModules
}

export function registerOfferCommands(registry: SyncWriteRegistry, deps: OfferSyncDeps): void {
  registry.register({
    name: 'offer.set',
    def: offerCommands.defs.set,
    target: async (_input, { principal }): Promise<SyncWriteTarget> => {
      const actor = actorOf(principal)
      if (actor === undefined) return NO_ACTOR
      // D5 (POD-6108): only a session with no coordinator above it may put a
      // decision in front of the user; every other session asks its coordinator.
      const seat = await deps.modules().issues.reports.seatFor(actor)
      if (seat.kind === 'below') {
        return refuseTarget({ kind: 'unauthorized', message: seatRefusal(seat, '`podium offer`') })
      }
      return NO_TARGET
    },
    handle: async (ctx, raw) => {
      const actor = actorOf(ctx.principal)
      if (actor === undefined) throw new SyncWriteRefused(NO_ACTOR.syncWriteRefused)
      const offer = validOffer(raw)
      const { issues, sessions } = deps.modules()
      // The agent's OWN issue: explicit attachment first, else cwd containment
      // (see `capabilityForSession`). Both the retirement guard and the
      // self-reference nudge below are about that one issue.
      const scope = ctx.principal.kind === 'system' ? undefined : ctx.principal.capability.scope
      const ownIssueId = scope?.kind === 'subtree' ? scope.rootId : null
      const ownRow = ownIssueId ? await issues.reports.getMeta(ownIssueId) : null
      const ownRef = ownRow ? await issues.reports.niceRef(ownRow) : null
      // RETIRE ON CLOSE, IN EITHER ORDER (POD-1072). A closed issue never asks
      // for a decision. ADVISORY, NOT AN ERROR: this lands at the very end of a
      // long turn and a closing report must not fail over it, so the reason
      // rides back on the result and nothing is written.
      if (ownRow && (ownRow.stage === 'done' || ownRow.closedReason)) {
        return {
          ok: true,
          retired: true,
          notice:
            `Offer not set: ${ownRef} is already closed, and a closed issue never asks for ` +
            `a decision. Post the offer BEFORE closing — or, if this is a decision about ` +
            `NEW work, file that work as its own issue and offer from there.`,
        }
      }
      await sessions.setOffer({ sessionId: actor, ...offer })
      // Self-reference nudge (POD-389): advisory only, the offer is already set.
      const notice =
        ownRef && bareSelfRefCount(offer.message, ownRef) > 0
          ? selfRefNudge(ownRef, 'offer message')
          : undefined
      return { ok: true, ...(notice ? { notice } : {}) }
    },
  })

  registry.register({
    name: 'offer.clear',
    def: offerCommands.defs.clear,
    target: (_input, { principal }) => (actorOf(principal) === undefined ? NO_ACTOR : NO_TARGET),
    handle: async (ctx) => {
      const actor = actorOf(ctx.principal)
      if (actor === undefined) throw new SyncWriteRefused(NO_ACTOR.syncWriteRefused)
      await deps.modules().sessions.clearOffer(actor)
      return { ok: true, cleared: true }
    },
  })
}
