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
import type { AttachmentKind, SendProof, TurnDelivery } from './turns.js'

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

/**
 * RESOURCE TRUTH for one session's process tree, as the supervisor observed it
 * (spec §6). Produced by whoever owns processes — the daemon reads the session's
 * cgroup — and consumed by drivers, which never touch the OS themselves.
 *
 * `oomKills` is the ONE required field, and it is a CUMULATIVE COUNTER rather
 * than a boolean: with `OOMPolicy=continue` a session outlives the kernel
 * killing a child inside it, so "was there ever an OOM here" and "how many"
 * are different questions, and only the counter can answer the second. Every
 * other field is optional because a platform without cgroups (macOS) can
 * honestly answer some and not others, and a fabricated zero is what this
 * whole surface exists to stop reporting.
 */
export interface ScopeResources {
  /** Whole-tree memory: the cgroup's `memory.current`, or a `/proc` attribution
   *  where there is no cgroup. */
  memoryBytes?: number
  peakMemoryBytes?: number
  /** Swap this tree is using, and the ceiling on it. Reported beside the memory
   *  pair because a budget whose swap half is invisible reads as half the real
   *  bound — a session capped at 6 GiB of memory and 6 GiB of swap can hold
   *  twice what `memoryMaxBytes` alone suggests. */
  swapBytes?: number
  swapMaxBytes?: number
  /** Processes/threads in the tree, against the scope's `TasksMax`. */
  tasks?: number
  tasksMax?: number
  /** The budget actually in force, so a consumer can say "3.9 of 6 GiB" rather
   *  than a number with no scale. */
  memoryHighBytes?: number
  memoryMaxBytes?: number
  /** Kernel OOM kills inside this scope, cumulative over its lifetime. */
  oomKills: number
  /** Reclaim-throttle hits (`memory.events` `high`). A large, growing count is a
   *  session crawling under its budget instead of progressing — the failure mode
   *  `MemoryHigh` produces when it is set too low. */
  throttleEvents?: number
  scopeUnit?: string
}

export interface SessionHealth {
  alive: boolean
  memoryBytes?: number
  peakMemoryBytes?: number
  /** Swap in use, and its ceiling — the other half of the memory budget. */
  swapBytes?: number
  swapMaxBytes?: number
  tasks?: number
  /** The task cap this session is counted against. A count without its scale is
   *  the same "number with no scale" this surface exists to stop reporting. */
  tasksMax?: number
  /** The memory budget in force for this session, where one is. */
  memoryMaxBytes?: number
  scopeUnit?: string
  /** Kernel OOM kills observed in this session's scope. Cumulative, and NOT a
   *  liveness statement: `OOMPolicy=continue` means a session can report kills
   *  and still be `alive`, which is precisely the case worth reporting. */
  oomEvents: number
  throttleEvents?: number
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

/** How one staged ref is presented to the harness by `send()`. */
export type AttachmentPromptForm = 'path-text' | 'local-image' | 'file-part'

/** What `stageAttachment()` can land and how `send()` presents the resulting
 * ref to the harness. A driver that cannot map BOTH halves declares staging
 * unsupported: writing bytes that no prompt can consume is not support. */
export interface AttachmentStagingCapability {
  kinds: readonly AttachmentKind[]
  /**
   * ONE FORM, OR ONE PER KIND — because a driver can carry the two kinds
   * differently, and then a single label is untrue of one of them.
   *
   * The single-form spelling is the common case and is unchanged: terminal
   * carries both kinds as `path-text`, opencode carries both as `file-part`.
   * Codex cannot (POD-2819): its protocol has a typed `localImage` part that
   * puts pixels in front of the model, and NOTHING typed for a file — the
   * `mention` variant its schema advertises is accepted by the server and then
   * never reaches the model's prompt, measured on the rollout the thread
   * writes. So codex delivers an image as `local-image` and a file as
   * `path-text`, and says exactly that here rather than picking whichever label
   * is wrong about fewer kinds.
   *
   * The corpus reads it per kind either way, and holds the one pairing that is
   * always a lie: `local-image` may only ever be the form for an IMAGE.
   */
  promptForm:
    | AttachmentPromptForm
    | { readonly [K in AttachmentKind]?: AttachmentPromptForm }
}

/** The declared form for one kind, whichever spelling the driver used. */
export function attachmentPromptFormFor(
  staging: AttachmentStagingCapability,
  kind: AttachmentKind,
): AttachmentPromptForm | undefined {
  return typeof staging.promptForm === 'string' ? staging.promptForm : staging.promptForm[kind]
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
  staging: Declared<AttachmentStagingCapability>
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
