/**
 * THE ONE MODEL-CATALOG WRITE — `models.refresh`.
 *
 * Live per-agent model lists (grok / cursor / opencode `models`). The surface is
 * stale-while-revalidate: `catalog` returns instantly from cache and refreshes in
 * the background, and `refresh` forces and AWAITS a fresh probe. `catalog` stays a
 * query; only the forced probe is a command.
 *
 * CLASSIFICATION: `deployment-substrate`, ADR 9 D3 rule 1 — a property of the
 * DEPLOYMENT rather than of a person. The catalog is one cache per server, shared
 * by every client; there is no per-user partition and could not be one, because
 * what it caches is which models the agent CLIs installed on this host report.
 *
 * THE PLAUSIBLE MISTAKE IS `owned-compute`, and it deserves a sentence because
 * the command genuinely does execute on a host: `refresh` shells out to each
 * agent CLI. But `visibility` classifies THE STATE THE COMMAND WRITES, not what
 * it authorizes against (ADR 3 D1's asymmetry, spelled out in
 * `classificationErrors`), and what this writes is the server's shared catalog
 * cache. There is also no machine argument — the probe runs on whatever host
 * serves the request — so there is no per-machine row for `owned-compute` to
 * name, and the lint would refuse it anyway: `owned-compute` requires
 * `resource: 'machine'`.
 */

import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
} from '../contract'

/** `trpc` alone — the settings model pickers are the only caller. */
const SERVED_ON: readonly TransportTag[] = ['trpc']

/** Takes nothing, matching the shipped procedure, which had no `.input(…)` and so
 *  accepted anything. `.passthrough()` keeps that rather than newly refusing keys
 *  a shipped client may already send. */
export const modelsRefreshInput = z.object({}).passthrough().optional()

export const modelsRefreshContract = {
  name: 'models.refresh',
  version: 1,
  visibility: 'deployment-substrate',
  input: modelsRefreshInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'global',
    confirmation: 'none',
    rationale:
      'A `write` on the deployment’s shared catalog cache, so `resource: global`. `roleFloor: ' +
      'member`: refreshing a list of available models is what any user does when opening a model ' +
      'picker that looks stale, and it is idempotent — the result is whatever the CLIs report, so a ' +
      'second call cannot do more than the first. NOT `manage` despite shelling out: what it writes ' +
      'is a cache, the probe is read-only against the agent CLIs, and grading it administrative ' +
      'would put a routine UI affordance behind an admin gate. No confirmation: nothing is ' +
      'destroyed and the previous catalog is simply replaced by a fresher one.',
  },
  exposure: SERVED_ON,
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'NEVER queued. The command exists to AWAIT a live probe — that is the whole difference ' +
      'between it and the cached `catalog` read — so a queued refresh drained later would return a ' +
      'catalog the caller stopped waiting for, and the stale-while-revalidate path already covers ' +
      'the offline case correctly by serving the cache. Nothing is lost by dropping it.',
    applyTimeReauthorization:
      'Not reachable in practice, since the class forbids queuing; stated for totality (ADR 3 D8). ' +
      'A replayed refresh would be re-authorized live and dropped on refusal — the caller has long ' +
      'since been served from cache either way.',
  } satisfies DeliveryPolicy,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'The command takes no input. The OUTPUT is a list of model identifiers reported by locally ' +
      'installed agent CLIs — public product names, not entitlements — and it was reviewed rather ' +
      'than assumed because a model list can hint at which paid plans this host holds credentials ' +
      'for. It stays unredacted: the same list is already rendered in every model picker, so ' +
      'redacting the command’s result would hide nothing that the read beside it does not show.',
  } satisfies RedactionPolicy,
  ownership: {
    creates: [],
    note: 'Replaces a cache entry. Mints no entity and moves no ownership.',
  },
  attribution: {
    actor: 'not-applicable',
    onBehalfOf: 'none-representable',
    wirePlacement: 'not-on-the-wire',
    reservedWireKeys: [],
    rationale:
      'No pair, and stated rather than left off. The catalog cache records no writer — it is ' +
      'replaced wholesale by whatever the CLIs report — so there is no accountability record for a ' +
      'principal to be stamped into. D17 forbids attribution from payload; it does not require a ' +
      'command that records nothing to invent a principal.',
  } satisfies AttributionPolicy,
  errorConsistency: {
    callerSuppliedTargetId: false,
    note:
      'No input at all, so there is no caller-supplied id to iterate and no existence to leak — ' +
      'Amendment 1 D20.3’s question does not arise rather than being answered permissively.',
  } satisfies ErrorConsistency,
} as const satisfies CommandContract<typeof modelsRefreshInput>

export const MODEL_CONTRACTS = { refresh: modelsRefreshContract } as const

export type ModelContractName = keyof typeof MODEL_CONTRACTS

export const MODEL_CONTRACT_NAMES = Object.keys(MODEL_CONTRACTS).sort() as ModelContractName[]
