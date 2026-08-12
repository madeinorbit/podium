/**
 * Scheduled automations — relocated verbatim from `@podium/protocol`'s
 * `messages/automations.ts` at POD-300. Byte-identical on the wire, pinned by
 * `packages/protocol/src/messages/wire-golden.json`; the two carrier frames
 * (`automationsChanged` / `automationRunsChanged`) stay in protocol.
 *
 * These two are here because the codebase's OWN replicated-entity taxonomy
 * names them: `MetadataEntityKind` in protocol's `messages/sync.ts` is
 * `['session', 'issue', 'conversation', 'automation', 'automationRun']`, and
 * codec.ts quarantines their carrier frames element-wise exactly as it does
 * `sessionsChanged`. Anything that rides a `metadataDelta` is an entity.
 *
 * ---------------------------------------------------------------------------
 * NOTES FOR THE ISSUES BEHIND THIS ONE (docs/multi-user-readiness.md, human
 * decisions 2026-07-29). Recorded here, not implemented here.
 * ---------------------------------------------------------------------------
 *
 * OWNERSHIP. §3.1.6 S6 settles the policy in principle: scheduled automations
 * are DELEGATED like the superagent — "they have a creator, so they run as that
 * person with that person's current rights", inheriting §3.1.3 A1's live
 * evaluation so revoking someone stops their cron agents with no reaper to
 * write. `AutomationWire` carries no creator field today, so that is a field
 * POD-1075 adds; this move leaves the flat aggregate it can be added to
 * additively, and adds nothing itself.
 *
 * ATTRIBUTION. `AutomationRunWire.sessionId` names the session a fire spawned —
 * an actor reference, half of §3.1.3 A3's (actor, on-behalf-of) pair, and
 * flagged forward with the rest of that cohort (see `entities/issue.ts`).
 *
 * MACHINE REFERENCE. `repoPath` points at a checkout on some machine but is not
 * a fact ABOUT a machine, so it stays here rather than joining
 * `entities/machine.ts`'s group — same reasoning as `SessionMeta.machineId`.
 *
 * EMBEDS. None. `AutomationRunWire` references its automation by id rather than
 * embedding it, which is already the shape ADR 4 D7's normalization law wants.
 *
 * No owner, visibility, grant or instance_id field was added.
 */

import { z } from 'zod'
import { AutomationIdField, AutomationRunIdField, SessionIdField } from '../ids'

/** How a scheduled fire chooses the agent conversation [spec:SP-17db]. */
export const AutomationSessionMode = z.enum(['fresh', 'resume'])
export type AutomationSessionMode = z.infer<typeof AutomationSessionMode>

/** Recurring cron or a single timestamped fire [spec:SP-17db]. */
export const AutomationScheduleKind = z.enum(['cron', 'once'])
export type AutomationScheduleKind = z.infer<typeof AutomationScheduleKind>

export const AutomationRunOutcome = z.enum(['spawned', 'missed', 'skipped_overlap', 'error'])
export type AutomationRunOutcome = z.infer<typeof AutomationRunOutcome>

/** Durable scheduled-automation definition [spec:SP-17db]. */
export const AutomationWire = z.object({
  id: AutomationIdField,
  name: z.string(),
  enabled: z.boolean(),
  repoPath: z.string().nullable(),
  scheduleKind: AutomationScheduleKind,
  cron: z.string().nullable(),
  runAt: z.string().nullable(),
  /** Explicit existing-session target. null keeps the fresh/previous-run behavior. */
  targetSessionId: SessionIdField.nullable(),
  /** OPEN ON THE WIRE BY DECISION, not by omission (POD-1107): a newer peer may
   *  name a harness this build has never heard of, and the frame must still
   *  decode — the same reason `HarnessId` (./agent.ts) is open. Closing it to
   *  `AgentKind` here would make an older server reject the whole automation
   *  rather than degrade. The narrowing happens where it matters, at the seam
   *  where the value becomes a process: the automations service passes it through
   *  `isAgentKind` and records an error run if this build cannot run it. If you
   *  find a bare `as AgentKind` on this field again, that is the bug. */
  agentKind: z.string(),
  model: z.string(),
  effort: z.string(),
  prompt: z.string(),
  sessionMode: AutomationSessionMode,
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  createdAt: z.string(),
})
export type AutomationWire = z.infer<typeof AutomationWire>

/** Durable record of one scheduled occurrence, including non-spawning outcomes. */
export const AutomationRunWire = z.object({
  /** A RUN's own id — a distinct id space from `automationId` below, which is
   *  precisely the swap a brand exists to catch. */
  id: AutomationRunIdField,
  automationId: AutomationIdField,
  firedAt: z.string(),
  /** ATTRIBUTION, ACTOR HALF: the session this fire spawned. Flipped to its
   *  current brand at POD-361; POD-1075 adds the on-behalf-of value (§3.1.6 S6
   *  makes a scheduled automation run as its creator). */
  sessionId: SessionIdField.nullable(),
  outcome: AutomationRunOutcome,
  detail: z.string().nullable(),
})
export type AutomationRunWire = z.infer<typeof AutomationRunWire>
