// Part of the Agent Runtime contract (POD-1761 W1). See ./index.ts for the
// surface's five governing rules and the core-vs-extended tier boundary.

import type { Declared } from '@podium/harness'
import type { AttachEndpoint } from './attach.js'
import type { WatchLevel } from './events.js'
import type {
  InteractionAnswerability,
  InteractionKind,
  InteractionSource,
} from './interactions.js'
import type { SendProof, TurnDelivery } from './turns.js'

// ---------------------------------------------------------------------------
// Config, accounting, health (spec §3 — mostly EXTENDED tier)
// ---------------------------------------------------------------------------

/** STICKY for the session. Per-turn overrides ride {@link TurnInput} instead —
 *  the split is a spec rule because conflating them is how a "just this once"
 *  model change silently becomes permanent. */
export interface ConfigureRequest {
  model?: string
  permissionMode?: string
  effort?: string
}

export interface UsageSnapshot {
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  /** Percentage of the context window consumed, where the harness reports it. */
  contextUsedPercent?: number
}

export interface SessionHealth {
  alive: boolean
  memoryBytes?: number
  scopeUnit?: string
  oomEvents: number
}

// ---------------------------------------------------------------------------
// Capabilities (spec §3 — `Declared<T>` per axis)
// ---------------------------------------------------------------------------

/** What a driver's `send` can actually do. `mayReturnUnverified` is the field
 *  the conformance suite reads to decide whether an unverified receipt is a
 *  permitted outcome or a bug. */
export interface SendCapability {
  /** Deliveries implemented NATIVELY. One not listed here is degraded, and the
   *  receipt's `deliveredAs` must report the degradation. */
  native: readonly TurnDelivery[]
  /** How acceptance is proven, in preference order. */
  proof: readonly SendProof[]
  /** TERMINAL FAMILY ONLY. A server or embedded driver declaring `true` here is
   *  claiming a weakness it does not have — the suite refuses it. */
  mayReturnUnverified: boolean
  verificationWindowMs?: number
}

export interface InterruptCapability {
  /** `interrupt()` REQUESTS a fence. A driver that cannot obtain provider
   *  confirmation must declare this false rather than manufacture one — fences
   *  are absorbing and state is never fabricated. */
  fenceOnProviderConfirmation: boolean
}

export interface InteractionCapability {
  kinds: readonly InteractionKind[]
  source: InteractionSource
  answerable: InteractionAnswerability
  /** `true` for classifier-sourced interactions: asked→answered may duplicate,
   *  and identity is best-effort. Consumers MUST branch on this. */
  atLeastOnce: boolean
}

export interface ObservationCapability {
  watchLevels: readonly WatchLevel[]
  /** What the cursor is made of, for diagnostics: 'file-offset' (terminal),
   *  'event-seq' (Codex thread), 'event-offset' (opencode session). */
  cursorMaterial: string
}

export interface AttachCapability {
  /** Which endpoint variants this driver can produce. Embedded declares attach
   *  UNSUPPORTED outright — there is no terminal, and chat is the answer. */
  kinds: readonly AttachEndpoint['kind'][]
}

/**
 * WHEN the resume ref becomes available. The spec requires it be captured as
 * early as the harness allows AND that the capability declare when that is —
 * Codex's rollout files are written lazily, so `first-turn` is the honest answer
 * there and `hibernate()` legitimately refuses before it.
 */
export type ResumeRefTiming = 'spawn' | 'first-turn' | 'never'

/**
 * ONE `Declared<T>` PER AXIS, same philosophy as `AgentManifest`. A driver
 * shipping only the CORE axes is complete; the extended ones never block it.
 * Totality is what makes this useful: a new axis must be declared by every
 * driver, so a gap is a compile error rather than an undefined field.
 */
export interface DriverCapabilities {
  // ---- CORE ----
  send: SendCapability
  interrupt: InterruptCapability
  interactions: Declared<InteractionCapability>
  observation: ObservationCapability
  transcript: Declared<{ history: boolean }>
  attach: Declared<AttachCapability>
  lease: Declared<{ humanTakeover: boolean }>
  snapshot: Declared<{ includesDraft: boolean }>
  archive: Declared<{ formatVersion: number; byteFaithful: boolean }>
  resumeRefTiming: ResumeRefTiming
  /** Dedicated process per session is v1's guarantee. A POOLED driver visibly
   *  lacks per-session OOM/crash isolation, so it declares it here rather than
   *  becoming a new mode in the taxonomy (spec §6). */
  placement: 'dedicated' | 'pooled'

  // ---- EXTENDED ----
  draft: Declared<{ read: boolean; write: boolean }>
  configure: Declared<{ fields: readonly (keyof ConfigureRequest)[] }>
  usage: Declared<{ perTurn: boolean }>
  openUrl: Declared<{ intents: readonly ('login' | 'link')[] }>
  title: Declared<{ source: 'osc' | 'transcript' | 'synthetic' }>
  accentColor: Declared<true>
}
