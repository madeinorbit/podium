import { z } from 'zod'
import { AccountIdField } from './ids'

/** The bounded escalation ladder used only after deterministic shipping has
 * classified a conflict or named-gate failure. */
export const ShipwrightLevel = z.enum(['mechanic', 'solver', 'inspector'])
export type ShipwrightLevel = z.infer<typeof ShipwrightLevel>

export const ShipwrightFailureKind = z.enum(['merge-conflict', 'validation-failed'])
export type ShipwrightFailureKind = z.infer<typeof ShipwrightFailureKind>

/** Human-visible repair evidence uses the repository's opaque artifact URI.
 * Raw executor paths/log text must be materialized before entering this type. */
export const ShipwrightEvidenceRef = z
  .string()
  .regex(/^artifact:\/\/[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/)
  .refine(
    (value) =>
      !value.split('/').includes('..') && !/(?:secret|token|password|api[-_]?key|sk-)/i.test(value),
  )
  .brand<'ShipwrightEvidenceRef'>()
export type ShipwrightEvidenceRef = z.infer<typeof ShipwrightEvidenceRef>

/** Policy-owned limits. These are snapshotted at the beginning of a repair;
 * models cannot enlarge them in their response. */
export const ShipwrightBudget = z
  .object({
    maxTurns: z.number().int().min(1).max(6).default(3),
    maxMechanicTurns: z.number().int().min(0).max(2).default(1),
    maxSolverTurns: z.number().int().min(0).max(2).default(1),
    maxInspectorTurns: z.number().int().min(0).max(2).default(1),
    maxContextBytes: z
      .number()
      .int()
      .min(4_096)
      .max(256 * 1_024)
      .default(64 * 1_024),
    maxFailureBytes: z
      .number()
      .int()
      .min(1_024)
      .max(64 * 1_024)
      .default(16 * 1_024),
    maxPatchBytes: z
      .number()
      .int()
      .min(1_024)
      .max(512 * 1_024)
      .default(256 * 1_024),
    timeoutMs: z
      .number()
      .int()
      .min(10_000)
      .max(20 * 60 * 1_000)
      .default(5 * 60 * 1_000),
  })
  .strict()
export type ShipwrightBudget = z.infer<typeof ShipwrightBudget>

export const DEFAULT_SHIPWRIGHT_BUDGET: ShipwrightBudget = ShipwrightBudget.parse({})

export const ShipwrightBehaviorImpact = z.enum(['none', 'observable-change', 'ambiguous'])
export type ShipwrightBehaviorImpact = z.infer<typeof ShipwrightBehaviorImpact>

/** A model may propose bytes and explain them. It may not name a branch, run a
 * command, request a merge, or choose a destination. */
export const ShipwrightPatchContract = z
  .object({
    kind: z.literal('patch'),
    summary: z.string().min(1).max(2_000),
    behaviorImpact: ShipwrightBehaviorImpact,
    touchedPaths: z.array(z.string().min(1).max(1_024)).max(128),
    patch: z.string().min(1),
    concerns: z.array(z.string().min(1).max(2_000)).max(16).default([]),
  })
  .strict()
export type ShipwrightPatchContract = z.infer<typeof ShipwrightPatchContract>

/** Inspector is deliberately review-only: it can approve the already proposed
 * patch or force a hold, but cannot return replacement bytes. */
export const ShipwrightInspectionContract = z
  .object({
    kind: z.literal('inspection'),
    verdict: z.enum(['safe', 'ambiguous', 'reject']),
    summary: z.string().min(1).max(2_000),
    concerns: z.array(z.string().min(1).max(2_000)).max(16).default([]),
  })
  .strict()
export type ShipwrightInspectionContract = z.infer<typeof ShipwrightInspectionContract>

export const ShipwrightModelContract = z.union([
  ShipwrightPatchContract,
  ShipwrightInspectionContract,
])
export type ShipwrightModelContract = z.infer<typeof ShipwrightModelContract>

export const ShipwrightRoute = z
  .object({
    level: ShipwrightLevel,
    agent: z.enum(['claude-code', 'codex', 'grok', 'opencode', 'cursor', 'pi']),
    model: z.string().min(1),
    effort: z.string().min(1),
    family: z.string().min(1),
    accountId: AccountIdField,
  })
  .strict()
export type ShipwrightRoute = z.infer<typeof ShipwrightRoute>

export const ShipwrightAttemptResult = z
  .object({
    level: ShipwrightLevel,
    route: ShipwrightRoute,
    repairRef: z.string().regex(/^refs\/podium\/ship-repair\//),
    contract: ShipwrightModelContract,
  })
  .strict()
export type ShipwrightAttemptResult = z.infer<typeof ShipwrightAttemptResult>

/** Stable repair-ref spelling. It contains only server-minted identifiers and a
 * generation fence; no model text ever enters a ref name. */
export function shipRepairRef(
  orderId: string,
  attemptId: string,
  generation: number,
  contextDigest: string,
): string {
  const safeOrder = orderId.replace(/[^a-zA-Z0-9._-]+/g, '-')
  const safeAttempt = attemptId.replace(/[^a-zA-Z0-9._-]+/g, '-')
  if (!/^[a-f0-9]{64}$/.test(contextDigest)) throw new Error('invalid ship repair context digest')
  return `refs/podium/ship-repair/${safeOrder}/${safeAttempt}/${generation}/${contextDigest}`
}
