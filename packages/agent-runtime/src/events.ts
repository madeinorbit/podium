// Part of the Agent Runtime contract (POD-1761 W1). See ./index.ts for the
// surface's five governing rules and the core-vs-extended tier boundary.

import type { AgentStateEvent } from '@podium/harness'
import type { TranscriptItem } from '@podium/model'
import type { ObservationProvenance, ProviderCursor } from '@podium/protocol'
import type { ProcessEvent, TurnEvent } from './errors.js'
import type { InteractionAnswered, InteractionAsked, InteractionExpired } from './interactions.js'

// ---------------------------------------------------------------------------
// The causal envelope (spec §3 rule 4)
// ---------------------------------------------------------------------------

/**
 * Every read is causally enveloped, per `reattachment-design.md`'s already-
 * approved contract: bootstrap snapshot + cursor-fenced live deltas, provenance
 * tagged.
 *
 * THE FIELDS ARE REUSED, NOT REDECLARED. `ProviderCursor`, `ObservationProvenance`
 * and `ObservationInputOrigin` come from `@podium/protocol`'s `runtime-state`
 * family, which is where the causal observation protocol already lives. A second
 * cursor vocabulary in a new package is precisely the drift rule 4 exists to
 * prevent — the spec's own note is that the contract "was written for the PTY
 * stack but is driver-agnostic", and only the CURSOR MATERIAL differs per family
 * (file inode+offset for terminal; thread id + event seq for Codex; session id +
 * event offset for opencode). That difference is already inside `ProviderCursor`.
 */
export interface CausalEnvelope {
  /** EVENT-time (ISO 8601) — when the agent acted, never when we observed it.
   *  Observe-time stamping is what makes a reattach restamp every session to
   *  "now", which the reattachment design calls out by name. */
  at: string
  provenance: ObservationProvenance
  cursor: ProviderCursor
  /** Bumped when the observer rebinds; a stale generation is rejected, never
   *  merged. */
  observerGeneration: number
  /** The turn this event belongs to. Fences are absorbing: once a turn epoch is
   *  closed it does not reopen. */
  turnEpoch: number
}

// ---------------------------------------------------------------------------
// Observation (spec §3)
// ---------------------------------------------------------------------------

/**
 * ONE EVENT STREAM PER SESSION. Every arm is causally enveloped, so a consumer
 * can order, fence and deduplicate without knowing which family produced it.
 */
export type RuntimeEvent = CausalEnvelope & RuntimeEventBody

/**
 * The event's own payload, WITHOUT the envelope.
 *
 * Split out rather than derived with `Omit<RuntimeEvent, keyof CausalEnvelope>`
 * because `Omit` over a union is not distributive: it collapses to the keys the
 * arms share, which for a discriminated union is just the discriminant. A driver
 * building an event before stamping it needs this exact type, so it is named
 * here instead of re-derived (incorrectly) at each producer.
 */
export type RuntimeEventBody =
  | {
      /** The existing normalized state vocabulary, INCLUDING compaction — which
       *  is the re-prime boundary for `SessionSpec.instructions`. */
      t: 'state'
      change: AgentStateEvent
    }
  | { t: 'item'; item: TranscriptItemDelta }
  | { t: 'interaction'; ev: InteractionAsked | InteractionAnswered | InteractionExpired }
  | { t: 'turn'; ev: TurnEvent }
  | { t: 'process'; ev: ProcessEvent }
  /** `cd`/EnterWorktree moves, commits and touched files. */
  | { t: 'workspace'; ev: CwdChanged | GitActivity }
  /** Forwarded browser opens, classified by the harness manifest. */
  | { t: 'open-url'; ev: { url: string; intent: 'login' | 'link' } }

export interface CwdChanged {
  ev: 'cwd-changed'
  cwd: string
}

export interface GitActivity {
  ev: 'git-activity'
  /** Commits observed since the last such event. */
  commits: readonly string[]
  touchedFiles: readonly string[]
}

/**
 * A transcript item, or a fragment of one. COMPLETED items arrive at the coarse
 * watch level; token-level `delta` fragments only while a viewer holds a fine
 * watch — which is what keeps the durable path cheap.
 *
 * ---------------------------------------------------------------------------
 * THE JOIN, AND THE TWO RULES THAT MAKE FRAGMENTS SAFE TO DROP (POD-2293)
 * ---------------------------------------------------------------------------
 *
 * 1. `itemId` ON A FRAGMENT IS `streamItemIdOf(theCompleteItem)`, always. Not
 *    the item's `id` — opencode's ids are derived from their own text and change
 *    on every update — and not the raw provider part/message id either, which is
 *    a family-local name a consumer never sees on the complete item. See
 *    `./stream-identity.ts` for why one named function owns both sides, and the
 *    conformance corpus's `delta identity` group for the property that refuses a
 *    driver whose fragments join to nothing.
 *
 * 2. FRAGMENTS ARE LIVE-ONLY AND LOSSY BY DESIGN. They are never journalled as
 *    transcript content, never replayed on `'bootstrap'`, and a consumer must
 *    render correctly having missed any prefix of them. Correctness lives on the
 *    complete items: a fragment stream is a preview, the complete item is the
 *    record, and the complete item always replaces the preview rather than
 *    appending to it. A consumer that drops every fragment loses nothing but
 *    liveness — which is the property that lets the server treat the fine plane
 *    as unretained and unacknowledged.
 */
export type TranscriptItemDelta =
  | { kind: 'complete'; item: TranscriptItem }
  | { kind: 'delta'; itemId: string; textDelta: string }

/**
 * Two watch levels, refcounted (spec §5). `coarse` is durable-synced and always
 * on; `fine` is live-only token deltas while a viewer is actually watching. A
 * driver that cannot produce token deltas declares `fine` unsupported and the
 * chat degrades to complete items — it does not fabricate a stream.
 */
export type WatchLevel = 'coarse' | 'fine'

/** Where to resume an event stream. `'bootstrap'` asks for the snapshot plus
 *  everything after it. */
export type EventStreamStart = ProviderCursor | 'bootstrap'
