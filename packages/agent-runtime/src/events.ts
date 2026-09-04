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
 *    `@podium/transcript`'s `stream-identity.ts` for why one named function owns both sides, and the
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
   * AN ITEM THAT EXISTS AND IS STILL RUNNING (POD-2293) — a tool call between
   * its start and its result, carrying whatever the provider knows so far.
   *
   * The third arm exists because "stream the reply" is not only about text.
   * Two of the three headless families already publish a running tool call as a
   * `complete` item and correct it later, so their in-progress work is visible
   * without this arm; codex publishes ONLY `item/completed`, deliberately — one
   * item updated in place would otherwise enter the durable transcript twice,
   * the first time with its result missing. That decision is right for the
   * durable path and is exactly what leaves a codex viewer staring at nothing
   * while a long tool runs. This arm is where that item goes instead: live-only,
   * never journalled, retired by the `complete` that shares its stream identity.
   */
  | { kind: 'partial'; item: TranscriptItem }

/**
 * Two watch levels, refcounted (spec §5). `coarse` is durable-synced and always
 * on; `fine` is live-only token deltas while a viewer is actually watching. A
 * driver that cannot produce token deltas declares `fine` unsupported and the
 * chat degrades to complete items — it does not fabricate a stream.
 */
export type WatchLevel = 'coarse' | 'fine'

/** One entry in a driver's bounded causal-event replay log. */
export interface RuntimeEventLogEntry {
  seq: number
  event: RuntimeEvent
}

/** The small mutable part of a driver's event stream used by the shared reader. */
export interface RuntimeEventStreamSource {
  readonly log: readonly RuntimeEventLogEntry[]
  readonly wakers: Set<() => void>
  currentSeq(): number
  isDisposed(): boolean
}

/**
 * Read a bounded event log without confusing its replay index with its cursor.
 *
 * The log is deliberately a ring-shaped array: trimming its oldest entries
 * shifts every array index while a live reader is asleep. An index-based reader
 * can therefore wake on the next event, observe `position === log.length` and
 * go back to sleep forever. The sequence is the stable identity, so a trim only
 * means that an unreplayed prefix is no longer available; it never hides the
 * events that arrived after the trim.
 */
export function createRuntimeEventStream(
  after: EventStreamStart,
  source: RuntimeEventStreamSource,
): AsyncIterable<RuntimeEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      let lastSeq = after === 'bootstrap' ? 0 : Number(after.components.seq ?? 0)
      const bootstrapUntil = after === 'bootstrap' ? source.currentSeq() : 0

      while (true) {
        let found = false
        for (const entry of source.log) {
          if (entry.seq <= lastSeq) continue
          found = true
          lastSeq = entry.seq
          const event =
            entry.seq <= bootstrapUntil
              ? ({ ...entry.event, provenance: 'bootstrap' } as RuntimeEvent)
              : entry.event
          yield event
        }
        if (found) continue
        if (source.isDisposed()) return

        await new Promise<void>((resolve) => {
          let awake = false
          const wake = (): void => {
            if (awake) return
            awake = true
            source.wakers.delete(wake)
            resolve()
          }
          source.wakers.add(wake)
          // Do not lose an event emitted between the scan above and registering
          // the waker. This check also makes disposal wake a reader cleanly.
          if (source.isDisposed() || source.log.some((entry) => entry.seq > lastSeq)) wake()
        })
      }
    },
  }
}

/** Where to resume an event stream. `'bootstrap'` asks for the snapshot plus
 *  everything after it. */
export type EventStreamStart = ProviderCursor | 'bootstrap'
