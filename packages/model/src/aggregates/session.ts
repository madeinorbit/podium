/**
 * `SessionAggregate` — the canonical R1 session (POD-365).
 *
 * **There is no R1 today.** POD-364 verified it: session truth is split across
 * the `sessions` table (48 columns), `SessionDurableState` (44 live fields, five
 * of which have no column in any migration) and `SessionMeta` (55 keys) — three
 * shapes, none of which is the authority, disagreeing in sixteen catalogued ways.
 * This file is the one that says what a session IS.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS, AND THE FOUR THINGS IT DELIBERATELY IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is the **durable** aggregate: composed from the field groups in
 * `../fields/session.ts`, plus `Ownership` and `Attribution`. ADR 4 D1 is
 * explicit that this is *not* one universal record — the storage row (R3), the
 * live class (R2), the wire projections (R4) and the narrow ports (R5) stay
 * DISTINCT types that `Pick` from the same vocabulary. If a change ever made the
 * storage row and a wire projection the same type, that would be too far.
 *
 * NOT LIVE STATE. `SessionLiveOverlay` is absent, and that is the point of
 * having named it: it holds D-9's five fields that `SessionMeta` publishes with
 * **no storage column in any migration** (`titleLocked`, `agentColor`,
 * `observedModel`, `observedEffort`, `transcriptAvailable`), plus `controllerId`,
 * `clientCount`, `epoch`, `busy` and live `geometry`. A durable member that
 * nothing persists is a lie about the entity (ADR 4 D3.7).
 *
 * NOT DERIVED STATE. `SessionDerived` is absent for the same reason from the
 * other direction: `displayRef`, `resumable`, `unread`, `machineName` are pure
 * functions over R1, and a stored copy beside the thing it is computed from is a
 * second write path (D3.6, inventory D-5).
 *
 * NOT PER-USER STATE. `readAt`, `snoozedUntil`, `pinned`, tab order, layout and
 * personal preference keys are absent BY CONSTRUCTION, and `registry.test.ts`
 * fails if one appears. They are POD-1076's `(userId, entityId)` family over the
 * one `PerUserKey` fragment. Leaving a singleton behind "for now" is later a
 * table migration PLUS a wire change PLUS a replica migration — on the one part
 * of the system this rewrite promises never to redo (readiness §3.3).
 *
 * NOT PROVENANCE. `viaHub` / `upstreamStale` / `pendingSync` describe how a row
 * reached a replica and ride the envelope (ADR 4 D3.8). Ownership and
 * attribution are the opposite kind of fact — durable truth that must survive
 * bootstrap, export and re-replication (D9.4) — which is why they are here and
 * not there.
 */

import { z } from 'zod'
import { Attribution } from '../fields/attribution'
import { Ownership } from '../fields/ownership'
import {
  AgentRuntimeState,
  SessionActivity,
  SessionIdentity,
  SessionLaunchConfig,
  SessionLifecycle,
  SessionNaming,
  SessionPlacement,
  SessionProvenance,
  SessionRef,
  SessionResume,
  SessionTombstone,
  SessionWorkflowLink,
  SessionWorkState,
} from '../fields/session'

/**
 * The canonical durable session — inventory §6.4 row 1.
 *
 * Built with `.extend()` over the named groups rather than by listing keys, so
 * that adding a field to a group propagates here and cannot be forgotten (ADR 4
 * D3.3's propagate-or-fail-compilation rule). A key list retyped here would be
 * the 25th session representation, not the collapse of the other 24.
 */
export const SessionAggregate = SessionIdentity.extend(SessionPlacement.shape)
  .extend(SessionLaunchConfig.shape)
  .extend(SessionNaming.shape)
  .extend(SessionProvenance.shape)
  .extend(SessionRef.shape)
  .extend(SessionResume.shape)
  .extend(SessionLifecycle.shape)
  .extend(SessionActivity.shape)
  .extend(SessionWorkState.shape)
  .extend(SessionWorkflowLink.shape)
  .extend(SessionTombstone.shape)
  .extend(Ownership.shape)
  .extend({
    /** Harness-observed agent phase. A shared session fact, distinct from
     *  `status`: `status` says whether the PROCESS is alive, this says what the
     *  agent inside it is doing. Optional because an uninstrumented harness
     *  never reports one. */
    agentState: AgentRuntimeState.optional(),
    /** WHICH PRINCIPAL created this session (ADR 9 D5 A3). Under D5 A4 the
     *  `owner` above is this pair's `onBehalfOf` and never the agent — otherwise
     *  the personal sidebar would not show work your own agent did for you, and
     *  retiring an agent session would orphan its issues. */
    createdBy: Attribution,
  })
export type SessionAggregate = z.infer<typeof SessionAggregate>

/** The mutable subset — what a command may change after create. Identity,
 *  placement-at-birth, provenance and `createdAt` are not in it. Exported so
 *  POD-366's `SessionDurableState` (inventory D-8) is a `Pick` from the
 *  aggregate rather than a fourth hand-maintained list of 44 fields. */
export const SESSION_IMMUTABLE_AFTER_CREATE = [
  'sessionId',
  'agentKind',
  'createdAt',
  'origin',
  'spawnedBy',
  'createdBy',
  'refIssueId',
  'refLetter',
  'refDraft',
] as const satisfies readonly (keyof SessionAggregate)[]
