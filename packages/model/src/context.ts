/** Current context occupancy, never lifetime billing (POD-6575).
 * Native fields, tokenizer math and model-limit lookup belong to adapters.
 * Optional means unknown; an explicitly measured zero remains a value.
 */
import { z } from 'zod'

const Text = z.string().trim().min(1).max(256)
export const ContextReason = z.object({ code: Text, message: z.string().trim().min(1).max(1024) })
export type ContextReason = z.infer<typeof ContextReason>

/** No maximum: over-capacity observations and unrounded percentages survive. */
export const ContextQuantity = z.object({
  value: z.number().finite().nonnegative(),
  accuracy: z.enum(['reported', 'estimated']),
  source: Text,
})
export type ContextQuantity = z.infer<typeof ContextQuantity>

export const ContextCapacity = ContextQuantity.extend({
  value: z.number().finite().positive(),
  basis: z.enum(['native', 'configured', 'model-metadata', 'fallback']),
})
export type ContextCapacity = z.infer<typeof ContextCapacity>

/** Observed identity, not a requested model setting or a billing-ledger key. */
export const ContextModelIdentity = z
  .object({
    modelId: Text.optional(),
    providerId: Text.optional(),
  })
  .refine((value) => value.modelId !== undefined || value.providerId !== undefined, {
    message: 'Identity must name an observed model or provider',
  })
export type ContextModelIdentity = z.infer<typeof ContextModelIdentity>

/** Reused by the causal envelope. Rebinding and context boundaries fence reads. */
export const ContextCausalIdentity = z.object({
  observerGeneration: z.number().int().positive(),
  turnEpoch: z.number().int().nonnegative(),
})
export const ContextRevision = ContextCausalIdentity.extend({
  bindingVersion: z.number().int().nonnegative(),
  contextRevision: z.number().int().nonnegative(),
})
export type ContextRevision = z.infer<typeof ContextRevision>

/** Immutable for a measurement. Timer repeats/replay do not mint an identity.
 * `id` and optional native anchors are opaque and scoped to this binding.
 * `at` is the sample's event time, not the time a detail read finished.
 */
export const ContextSampleIdentity = ContextRevision.extend({
  id: Text,
  at: z.string().datetime(),
  turnRevision: Text.optional(),
  nativeSessionId: Text.optional(),
  nativeSampleId: Text.optional(),
}).readonly()
export type ContextSampleIdentity = z.infer<typeof ContextSampleIdentity>

export const ContextInvalidationCause = z.enum([
  'model-changed',
  'compaction',
  'reset',
  'rewind',
  'fork',
  'resume',
  'binding-changed',
])
export type ContextInvalidationCause = z.infer<typeof ContextInvalidationCause>
export const ContextInvalidation = z.object({
  cause: ContextInvalidationCause,
  previousSample: ContextSampleIdentity.optional(),
})
export type ContextInvalidation = z.infer<typeof ContextInvalidation>

/** Compaction policy is not the context denominator or occupied content. */
export const ContextCompactionPolicy = z.object({
  source: Text,
  enabled: z.boolean().optional(),
  thresholdTokens: ContextQuantity.optional(),
  thresholdPercent: ContextQuantity.optional(),
  reserveTokens: ContextQuantity.optional(),
})
export type ContextCompactionPolicy = z.infer<typeof ContextCompactionPolicy>

export const ContextOccupancy = z
  .object({
    basis: z.enum(['current-context', 'last-request', 'native-estimate']),
    usedTokens: ContextQuantity.optional(),
    /** Adapter-computed remaining space from this sample's effective capacity.
     * Consumers never subtract counts or borrow another model's denominator. */
    remainingTokens: ContextQuantity.optional(),
    /** Adapter-normalized ratio or native rounded percentage; never inverted. */
    percent: ContextQuantity.optional(),
  })
  .refine(
    (value) =>
      value.usedTokens !== undefined ||
      value.percent !== undefined ||
      value.remainingTokens !== undefined,
    {
      message: 'An occupancy observation needs a count or a percentage',
    },
  )
export type ContextOccupancy = z.infer<typeof ContextOccupancy>

const Measurement = z.object({
  sample: ContextSampleIdentity,
  model: ContextModelIdentity.optional(),
  occupancy: ContextOccupancy,
  effectiveCapacity: ContextCapacity.optional(),
  modelCapacity: ContextCapacity.optional(),
  compaction: ContextCompactionPolicy.optional(),
})
const KnownContext = Measurement.pick({
  model: true,
  effectiveCapacity: true,
  modelCapacity: true,
  compaction: true,
})

/** Whole replacement of the live session reading. Absence means an older peer;
 * pending/unavailable/unsupported explicitly clear a previous measurement.
 * A stale value keeps the ORIGINAL sample and denominator, with a reason.
 */
export const ContextSummary = z.discriminatedUnion('status', [
  Measurement.extend({ version: z.literal(1), status: z.literal('available') }),
  Measurement.extend({ version: z.literal(1), status: z.literal('stale'), reason: ContextReason }),
  KnownContext.extend({
    version: z.literal(1),
    status: z.literal('pending'),
    revision: ContextRevision,
    reason: ContextReason,
    invalidation: ContextInvalidation.optional(),
  }),
  KnownContext.extend({
    version: z.literal(1),
    status: z.literal('unavailable'),
    revision: ContextRevision,
    reason: ContextReason,
    invalidation: ContextInvalidation.optional(),
  }),
  z.object({ version: z.literal(1), status: z.literal('unsupported'), reason: ContextReason }),
])
export type ContextSummary = z.infer<typeof ContextSummary>

/** An explicit clear, distinct from an absent field from an old peer. Caller
 * supplies the admitted binding/generation/turn and advances contextRevision.
 */
export function invalidateContextSummary(
  previous: ContextSummary | undefined,
  cause: ContextInvalidationCause,
  revision: ContextRevision,
): ContextSummary {
  const previousSample =
    previous?.status === 'available' || previous?.status === 'stale' ? previous.sample : undefined
  const previousRevision =
    previousSample ??
    (previous?.status === 'pending' || previous?.status === 'unavailable'
      ? previous.revision
      : undefined)
  if (previousRevision && revision.contextRevision <= previousRevision.contextRevision) {
    throw new Error('Context invalidation must advance contextRevision')
  }
  return ContextSummary.parse({
    version: 1,
    status: 'pending',
    revision,
    reason: { code: cause, message: 'Waiting for a context measurement after a context boundary' },
    invalidation: { cause, previousSample },
  })
}

/** Inclusive input/output. Cache read/write are disjoint INPUT subsets;
 * reasoning is an OUTPUT subset. Never add these rows to their parents.
 * Partial accounting is valid even when the enclosing total is unknown.
 * This is one main request, not a turn/session/subagent aggregate.
 */
export const ContextLastRequest = z
  .object({
    requestId: Text.optional(),
    model: ContextModelIdentity.optional(),
    input: ContextQuantity.optional(),
    output: ContextQuantity.optional(),
    cacheRead: ContextQuantity.optional(),
    cacheWrite: ContextQuantity.optional(),
    reasoning: ContextQuantity.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.input &&
      (value.cacheRead?.value ?? 0) + (value.cacheWrite?.value ?? 0) > value.input.value
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['cacheRead'],
        message: 'Cache subsets exceed inclusive input',
      })
    }
    if (value.output && value.reasoning && value.reasoning.value > value.output.value) {
      ctx.addIssue({
        code: 'custom',
        path: ['reasoning'],
        message: 'Reasoning exceeds inclusive output',
      })
    }
    if (
      ![value.input, value.output, value.cacheRead, value.cacheWrite, value.reasoning].some(Boolean)
    ) {
      ctx.addIssue({ code: 'custom', message: 'No request accounting was measured' })
    }
  })
export type ContextLastRequest = z.infer<typeof ContextLastRequest>

export const CONTEXT_MAX_ROWS = 128
export const CONTEXT_MAX_DEPTH = 4
/** A flat bounded attribution tree. Root siblings are disjoint; children are
 * attribution WITHIN their parent, never extra occupied tokens. No prompt text.
 */
export const ContextCompositionRow = z.object({
  id: Text,
  parentId: Text.optional(),
  label: Text,
  category: Text,
  kind: z.enum(['used', 'reserve', 'free', 'excluded', 'deferred']),
  attribution: z.enum(['category', 'item', 'unattributed']),
  tokens: ContextQuantity.optional(),
  childrenCoverage: z.enum(['complete', 'partial', 'unknown']).optional(),
})
export type ContextCompositionRow = z.infer<typeof ContextCompositionRow>

export const ContextComposition = z
  .object({
    /** Complete claims every occupied token is attributed, including child rows. */
    coverage: z.enum(['complete', 'partial', 'unknown']),
    usedTokens: ContextQuantity.optional(),
    rows: z.array(ContextCompositionRow).max(CONTEXT_MAX_ROWS).readonly(),
    truncated: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const fail = (message: string): void => ctx.addIssue({ code: 'custom', message })
    const rows = new Map(value.rows.map((row) => [row.id, row]))
    if (rows.size !== value.rows.length) fail('Row identities must be unique')
    for (const row of value.rows) {
      const ancestors = new Set([row.id])
      let current = row
      while (current.parentId !== undefined) {
        const parent = rows.get(current.parentId)
        if (!parent || ancestors.has(parent.id)) {
          fail('Missing or cyclic attribution parent')
          break
        }
        if (parent.kind !== current.kind) fail('Attribution must retain its parent accounting kind')
        ancestors.add(parent.id)
        if (ancestors.size > CONTEXT_MAX_DEPTH) {
          fail('Attribution tree exceeds depth bound')
          break
        }
        current = parent
      }
      const children = value.rows.filter((child) => child.parentId === row.id)
      if (children.length > 0) {
        if (row.childrenCoverage === undefined) fail('Parent must declare child coverage')
        const known = children.every((child) => child.tokens !== undefined)
        const sum = children.reduce((total, child) => total + (child.tokens?.value ?? 0), 0)
        if (row.tokens && sum > row.tokens.value) fail('Child attribution exceeds its parent')
        if (
          row.childrenCoverage === 'complete' &&
          (!known ||
            !row.tokens ||
            sum !== row.tokens.value ||
            children.some((child) => child.attribution === 'unattributed'))
        ) {
          fail('Complete children must account for their parent without unknown attribution')
        }
      }
    }
    if (value.coverage === 'complete') {
      if (value.truncated || !value.usedTokens)
        fail('Complete composition needs an untruncated occupied total')
      const occupied = value.rows.filter((row) => row.kind === 'used')
      if (
        occupied.some(
          (row) =>
            !row.tokens ||
            row.attribution === 'unattributed' ||
            (row.childrenCoverage !== undefined && row.childrenCoverage !== 'complete'),
        )
      ) {
        fail('Unknown or partial attribution cannot be complete')
      }
      const sum = occupied
        .filter((row) => !row.parentId)
        .reduce((total, row) => total + (row.tokens?.value ?? 0), 0)
      if (value.usedTokens && sum !== value.usedTokens.value)
        fail('Used roots must equal occupied total; non-used rows are separate')
    }
    if (value.usedTokens) {
      const knownUsed = value.rows
        .filter((row) => row.kind === 'used' && !row.parentId)
        .reduce((total, row) => total + (row.tokens?.value ?? 0), 0)
      if (knownUsed > value.usedTokens.value) fail('Used roots exceed occupied total')
    }
  })
export type ContextComposition = z.infer<typeof ContextComposition>

/** Detail names the immutable summary sample it describes, even on refusal. */
export const ContextDetail = z
  .object({
    version: z.literal(1),
    sample: ContextSampleIdentity,
    status: z.literal('available'),
    lastRequest: ContextLastRequest.optional(),
    composition: ContextComposition.optional(),
  })
  .refine((value) => value.lastRequest !== undefined || value.composition !== undefined, {
    message: 'Detail must contain accounting or composition',
  })
export type ContextDetail = z.infer<typeof ContextDetail>
export const ContextDetailResult = z.union([
  ContextDetail,
  z.object({
    version: z.literal(1),
    sample: ContextSampleIdentity,
    status: z.enum(['cancelled', 'refused', 'superseded', 'unavailable', 'unsupported']),
    reason: ContextReason,
  }),
])
export type ContextDetailResult = z.infer<typeof ContextDetailResult>

export function sameContextSample(a: ContextSampleIdentity, b: ContextSampleIdentity): boolean {
  return (
    a.id === b.id &&
    a.at === b.at &&
    a.bindingVersion === b.bindingVersion &&
    a.observerGeneration === b.observerGeneration &&
    a.contextRevision === b.contextRevision &&
    a.turnEpoch === b.turnEpoch &&
    a.turnRevision === b.turnRevision &&
    a.nativeSessionId === b.nativeSessionId &&
    a.nativeSampleId === b.nativeSampleId
  )
}

/** Legacy percentage is solely a projection into the old 0..100 wire range.
 * Omit an incompatible value; never clamp/mutate the normalized measurement.
 * Derivation/division stays in the adapter, and drawing reads the full sample.
 */
export function contextUsagePercentOf(summary: ContextSummary | undefined): number | undefined {
  const percent =
    summary?.status === 'available' || summary?.status === 'stale'
      ? summary.occupancy.percent?.value
      : undefined
  return percent !== undefined && percent >= 0 && percent <= 100 ? percent : undefined
}

/** Machine/version support is not a session measurement or a zero occupancy. */
export const ContextAvailability = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available') }),
  z.object({ status: z.literal('unavailable'), reason: ContextReason }),
  z.object({ status: z.literal('unsupported'), reason: ContextReason }),
])
export type ContextAvailability = z.infer<typeof ContextAvailability>
export const ContextCapability = z.object({
  summary: z.enum(['passive', 'explicit', 'passive-and-explicit']),
  detail: z.enum(['on-demand', 'none']),
})
export type ContextCapability = z.infer<typeof ContextCapability>
