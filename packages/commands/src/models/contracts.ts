/**
 * THE ONE MODEL-CATALOG WRITE — `models.refresh`.
 *
 * Live per-agent model lists (grok / cursor / opencode `models`) for ONE machine.
 * The surface is stale-while-revalidate: `catalog` returns instantly from that
 * machine's cache and refreshes in the background, and `refresh` forces and
 * AWAITS a fresh probe. `catalog` stays a query; only the forced probe is a
 * command.
 *
 * CLASSIFICATION: `owned-compute`, from ADR 1 Amendment 1 D13.5 — harness AND
 * model inventory is a per-machine fact (owner inherits Machine, verbs
 * see/use/manage). The catalog is keyed by `machineId`; an instance-global
 * singleton cannot express two machines whose installed harnesses differ.
 * Scoping (who may see which machine's catalog) is applied at the server
 * projection boundary (POD-1079); this command carries no principal on the
 * snapshot itself.
 *
 * THE PLAUSIBLE MISTAKE IS `deployment-substrate`, which is what the pre-split
 * singleton looked like: one cache per server, shared by every client. That
 * classification was honest only while the cache was unkeyed; once the snapshot
 * names a machine, the state written is owned-compute and the lint requires
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

/**
 * `machineId` absent means the server's default / host machine, kept so a shipped
 * client that still calls with no input keeps working. The whole input is optional
 * for the same reason: the procedure previously accepted anything via
 * `.passthrough().optional()`.
 */
export const modelsRefreshInput = z
  .object({ machineId: z.string().optional() })
  .passthrough()
  .optional()

export const modelsRefreshContract = {
  name: 'models.refresh',
  version: 1,
  visibility: 'owned-compute',
  input: modelsRefreshInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    confirmation: 'none',
    machineVerb: 'use',
    rationale:
      'A `write` on one machine’s catalog cache, so `resource: machine` with `machineVerb: use` — ' +
      'the probe shells out to agent CLIs on that host (code execution on owned compute, readiness ' +
      '§3.1.4 M2). `roleFloor: member`: refreshing a list of available models is what any user does ' +
      'when opening a model picker that looks stale, and it is idempotent — the result is whatever ' +
      'the CLIs report. NOT `manage`: what it writes is a cache, the probe is read-only against the ' +
      'agent CLIs, and grading it administrative would put a routine UI affordance behind an admin ' +
      'gate. No confirmation: nothing is destroyed and that machine’s previous catalog is simply ' +
      'replaced by a fresher one.',
  },
  exposure: SERVED_ON,
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'NEVER queued. The command exists to AWAIT a live probe — that is the whole difference ' +
      'between it and the cached `catalog` read — so a queued refresh drained later would return a ' +
      'catalog the caller stopped waiting for, and the stale-while-revalidate path already covers ' +
      'the offline case correctly by serving the cache. ADR 3 Amendment 1 D18.3 also forbids ' +
      'queuing a command that executes on owned compute. Nothing is lost by dropping it.',
    applyTimeReauthorization:
      'Re-authorized live at apply against the delegation resolved at that moment (ADR 9 D5 A1). ' +
      'Losing `use` on the target machine between call and answer denies the probe — the grant is ' +
      'consulted per call rather than cached.',
  } satisfies DeliveryPolicy,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'The INPUT is at most a machineId. The OUTPUT is a list of model identifiers reported by ' +
      'agent CLIs on that machine — public product names, not entitlements — and it was reviewed ' +
      'rather than assumed because a model list can hint at which paid plans that host holds ' +
      'credentials for. It stays unredacted: the same list is already rendered in every model ' +
      'picker, so redacting the command’s result would hide nothing that the read beside it does ' +
      'not show. The protection is the machine gate, not the projection.',
  } satisfies RedactionPolicy,
  ownership: {
    creates: [],
    note: 'Replaces one machine’s cache entry. Mints no entity and moves no ownership.',
  },
  attribution: {
    actor: 'from-capability',
    onBehalfOf: 'from-delegation',
    wirePlacement: 'separate-field',
    reservedWireKeys: ['actor', 'onBehalfOf'],
    rationale:
      'A PAIR EVEN THOUGH THE CACHE RECORDS NO WRITER: the probe runs on hardware someone owns, so ' +
      'who asked is an accountability fact regardless of whether a durable row stamps it — the ' +
      'grant it is checked against is per-principal. The catalog snapshot itself still carries no ' +
      'principal (POD-1123); attribution is for the command, not the fact.',
  } satisfies AttributionPolicy,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: true,
    note:
      'machineId is optional; when present it is a caller-supplied target. readiness §3.1.4 M5 ' +
      'wins for machine `use`: unauthorized stays distinguishable from unreachable so an operator ' +
      'knows whether to request a grant or wait for a daemon. D20.2 still governs everything inside ' +
      'a machine the caller may already use. POD-1079 owns the projection boundary that enforces ' +
      'who may see which machine’s catalog.',
  } satisfies ErrorConsistency,
} as const satisfies CommandContract<typeof modelsRefreshInput>

export const MODEL_CONTRACTS = { refresh: modelsRefreshContract } as const

export type ModelContractName = keyof typeof MODEL_CONTRACTS

export const MODEL_CONTRACT_NAMES = Object.keys(MODEL_CONTRACTS).sort() as ModelContractName[]
