/**
 * Per-schema sample overrides for the golden wire fixtures (POD-360).
 *
 * The walker in `sampler.ts` produces path-derived strings for free-form
 * `z.string()` fields. That is correct for branded ids (brands are
 * compile-time only) and for open vocabularies like preference paths. It is
 * NOT correct for closed vocabularies enforced by `.superRefine` /
 * `.refine` — the path string fails parse, and the fixture case records a
 * `parseError` instead of a wire pin.
 *
 * The walker checks this map by schema identity before walking a node, so a
 * refined field nested inside a larger object (e.g. `LayoutState.entityId`)
 * hits the same override as the schema when exported alone.
 *
 * Add an entry when a new schema cannot be satisfied by the generic walker.
 * Do not weaken the schema to make sampling easier — the override is the
 * intentional fixture value.
 */

import {
  canonicalShippingDestination,
  LAYOUT_EXACT_KEYS,
  LayoutKeyField,
  LayoutSnapshot,
  READ_STREAM_IDS,
  ReadPositionSnapshot,
  ReadStreamIdField,
  ShipHoldAction,
  ShipHoldCode,
  ShipOrder,
  ShipStep,
  ShipTrainLane,
  ShipTrainManifest,
  shipRepairRef,
  ShipwrightAttemptResult,
  ShipwrightEvidenceRef,
  TERMINAL_SHIP_STEP_STATES,
} from '@podium/model'
import type { z } from 'zod'
import {
  ShippingEvidenceRequestMessage,
  ShippingRepairApplyRequestMessage,
  ShippingTrainExecution,
} from '../messages/shipping'
import type { SampleOptions } from './sampler'

/** One exact key from the closed layout vocabulary — stable fixture pin. */
const FIXTURE_LAYOUT_KEY = LAYOUT_EXACT_KEYS[0]

/** One stream from the closed read-position vocabulary (POD-1380). */
const FIXTURE_STREAM_ID = READ_STREAM_IDS[0]

export type SampleOverride = (opts: SampleOptions, path: string) => unknown

/**
 * Schema identity → fixture value. Keys must be the same zod instances the
 * registry walks (exported singletons), not reconstructed clones.
 */
// Explicit Map type params: a heterogeneous array of [ZodEffects<…>, fn]
// otherwise collapses key/value types and fails typecheck.
export const SAMPLE_OVERRIDES = new Map<z.ZodTypeAny, SampleOverride>([
  // Closed isLayoutKey vocabulary (POD-1350 / POD-402). Path-derived samples
  // like "" / "entityId" / "key" fail the refine; pin the first exact key.
  [LayoutKeyField, () => FIXTURE_LAYOUT_KEY],
  // Record keys are plain z.string() with a whole-object refine, so the
  // LayoutKeyField override does not reach them — pin a valid map.
  [
    LayoutSnapshot,
    (opts: SampleOptions) =>
      opts.mode === 'minimal'
        ? {}
        : { [FIXTURE_LAYOUT_KEY]: { unknownFixture: FIXTURE_LAYOUT_KEY } },
  ],
  // Closed isReadStreamId vocabulary (POD-1380) — same two shapes as layout:
  // the refined field, and the record whose KEYS the field override cannot reach.
  [ReadStreamIdField, () => FIXTURE_STREAM_ID],
  [
    ReadPositionSnapshot,
    (opts: SampleOptions) =>
      opts.mode === 'minimal'
        ? {}
        : { [FIXTURE_STREAM_ID]: { lastEventId: 7, seenAt: '2026-08-02T00:00:00.000Z' } },
  ],
  // The shipping hold vocabulary is `union([enum, /^policy:…/])`. Arm 0 is the
  // enum and the generic walker handles it; arm 1 is the open policy escape
  // hatch, and a path-derived string cannot match its pattern. Both arms are
  // spelled here so the union keeps BOTH sampled — pinning only the enum would
  // leave the extension point with no wire coverage at all.
  // `arm >= 1`, not `arm % 2`, because the walker CLAMPS an arm index to a node's
  // arity instead of wrapping it (see `clamp` in sampler.ts): on a two-option
  // union every arm above the first is the second option. Wrapping here would
  // make this node disagree with every other union in the corpus.
  [
    ShipHoldCode,
    (opts: SampleOptions) => (opts.arm >= 1 ? 'policy:fixture-hold' : 'approval-stale'),
  ],
  [ShipHoldAction, (opts: SampleOptions) => (opts.arm >= 1 ? 'policy:fixture-action' : 'retry')],
  // `artifact://…` with a regex plus a refine that rejects `..` segments and
  // anything that smells of a credential. Deliberately a plain opaque ref: the
  // point of the type is that raw executor paths and log text never reach it.
  [ShipwrightEvidenceRef, () => 'artifact://fixture/shipwright/evidence'],
])

export type SampleFixup = (value: unknown, opts: SampleOptions, path: string) => unknown

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The one 64-hex digest every `^[a-f0-9]{64}$` field in these fixtures uses. */
const DIGEST = 'a'.repeat(64)

/**
 * Schema identity → repair of a CROSS-FIELD invariant, applied after the walk.
 *
 * The difference from SAMPLE_OVERRIDES is the reason this exists: an override
 * REPLACES a node, so using one on a wide object would freeze that object's
 * fixture at whatever fields someone typed out by hand, and a field added to the
 * schema later would never appear in the golden. These fixtures exist to make
 * exactly that addition visible. A fixup keeps the schema-derived sample and
 * adjusts only the handful of fields a `.superRefine` correlates.
 *
 * Prefer deriving the corrected value FROM the sample (copy the order's own head
 * sha into its receipt) over asserting a constant — a constant is a second copy
 * of the invariant, and it drifts.
 */
export const SAMPLE_FIXUPS = new Map<z.ZodTypeAny, SampleFixup>([
  [
    ShipOrder,
    (value: unknown) => {
      if (!isRecord(value)) return value
      const order = { ...value }
      // `holdCode` is legal EXACTLY while the order is held. Adjust the code to
      // the sampled state rather than forcing the state to 'held': the arm index
      // is what varies `state` across cases, and overwriting it would collapse
      // every ShipOrder case onto one state.
      if (order.state === 'held') order.holdCode ??= 'approval-stale'
      else delete order.holdCode
      // A receipt is an admission proof about the order carrying it, so it must
      // bind that order's issue, head sha and descendant tips. Copied across
      // instead of dropping the receipt, which would cost this golden its
      // coverage of every RootIntegrationReceipt field.
      const receipt = order.currentIntegrationReceipt
      if (isRecord(receipt)) {
        order.currentIntegrationReceipt = {
          ...receipt,
          rootIssueId: order.issueId,
          approvedHeadSha: order.approvedHeadSha,
          descendants: order.descendantManifest,
        }
      }
      return order
    },
  ],
  [
    ShipStep,
    (value: unknown, opts: SampleOptions) => {
      if (!isRecord(value)) return value
      // `full` populates startedAt/finishedAt/outcome, which only a TERMINAL step
      // may carry. Move the state to one that legitimately carries them rather
      // than deleting the three fields — keeping them is what makes this case
      // cover the terminal shape at all, and `minimal` already covers 'planned'.
      if (opts.mode === 'minimal') return value
      return { ...value, state: TERMINAL_SHIP_STEP_STATES[0] }
    },
  ],
  [
    ShipTrainLane,
    (value: unknown) => {
      if (!isRecord(value)) return value
      const profile = isRecord(value.validationProfile) ? value.validationProfile : undefined
      const locks = Array.isArray(profile?.resourceLocks) ? (profile.resourceLocks as string[]) : []
      return {
        ...value,
        // Two 64-hex digests the generic walker cannot spell.
        laneKey: DIGEST,
        validationProfileDigest: DIGEST,
        // The lane must carry the CANONICAL spelling of its own destination.
        // Run it through the production canonicaliser rather than writing the
        // canonical form out here, so the fixture cannot disagree with the rule.
        destination: canonicalShippingDestination(
          typeof value.destination === 'string' ? value.destination : 'local:main',
          typeof value.targetBranch === 'string' ? value.targetBranch : 'main',
        ),
        ...(profile
          ? {
              // Sorted and de-duplicated, which is the invariant stated twice.
              validationProfile: { ...profile, resourceLocks: [...new Set(locks)].sort() },
            }
          : {}),
      }
    },
  ],
  [
    ShipTrainManifest,
    (value: unknown) => {
      if (!isRecord(value)) return value
      // ONE MEMBER, and that is the whole trick. The manifest correlates nine
      // invariants across its member list — unique order/attempt/issue/branch
      // ids, a single machine custody owner, dependencies that are sorted,
      // unique, and must both precede their dependent AND name the immediate
      // predecessor. A single member satisfies every one of them by
      // construction, so the fixture pins the shape without encoding a
      // canonical ordering that would then be a second copy of the rule.
      const members = Array.isArray(value.members) ? value.members : []
      const first = isRecord(members[0]) ? members[0] : undefined
      if (!first) return value
      const lane = isRecord(value.lane) ? value.lane : undefined
      const orderId = first.orderId
      const member = {
        ...first,
        orderId,
        // The frozen target is the lane's, so the member's approval base is
        // READ FROM the lane rather than restated.
        approvedBaseSha: lane?.expectedTargetSha ?? first.approvedBaseSha,
        machineId: lane?.machineId ?? first.machineId,
        deliveryDependsOn: [],
      }
      return {
        ...value,
        members: [member],
        memberCount: 1,
        // The leader is the final ordered member — with one member, that member.
        leaderOrderId: orderId,
      }
    },
  ],
  [
    ShippingTrainExecution,
    (value: unknown) => {
      if (!isRecord(value)) return value
      const manifest = isRecord(value.manifest) ? value.manifest : undefined
      const members = Array.isArray(manifest?.members) ? manifest.members : []
      // The executed subset is drawn FROM the manifest it claims, so take the
      // ids from there rather than sampling a parallel list that then has to be
      // kept in step with it.
      const memberOrderIds = members.filter(isRecord).map((member) => member.orderId)
      const candidate = isRecord(value.candidate) ? value.candidate : undefined
      return {
        ...value,
        ...(memberOrderIds.length > 0 ? { memberOrderIds } : {}),
        // Round zero means an approved candidate and nothing else; a repaired
        // one is a later round. Derived from the sampled candidate so whichever
        // arm the arm index picked stays coherent.
        repairRound: candidate?.kind === 'approved' ? 0 : 1,
      }
    },
  ],
  [
    ShippingEvidenceRequestMessage,
    (value: unknown) =>
      isRecord(value) ? { ...value, artifactRef: `artifact://shipping/${DIGEST}` } : value,
  ],
  [
    ShippingRepairApplyRequestMessage,
    (value: unknown) =>
      isRecord(value)
        ? {
            ...value,
            repairRef: shipRepairRef('fixture-order', 'fixture-attempt', 1, DIGEST),
          }
        : value,
  ],
  [
    ShipwrightAttemptResult,
    (value: unknown) => {
      if (!isRecord(value)) return value
      // The repair ref is an inline `.regex(/^refs\/podium\/ship-repair\//)`, so
      // it has no schema identity of its own to override. Built with the
      // production speller so the fixture cannot disagree with the real ref —
      // which is the point: when that speller grew an order id and a context
      // digest, this call failed to compile the corpus rather than pinning a ref
      // shape the server had stopped minting.
      return {
        ...value,
        repairRef: shipRepairRef('fixture-order', 'fixture-attempt', 1, 'a'.repeat(64)),
      }
    },
  ],
])
