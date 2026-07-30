/**
 * THE SETTINGS WRITE FAMILY (POD-420, 3.7c) — `settings.updatePersonal ·
 * settings.updateInstance · settings.setSecret · settings.clearSecret`.
 *
 * POD-418 split the settings MODEL into three tiers and classified all 39 leaves.
 * This file is the command half of that split: which authority a write answers
 * to, whether it may be queued, and what a transport may carry.
 *
 * ---------------------------------------------------------------------------
 * WHY FOUR CONTRACTS AND NOT ONE, WHICH IS THE WHOLE POINT OF THE ISSUE
 * ---------------------------------------------------------------------------
 *
 * The shipped surface is ONE command — `settings.set(PodiumSettings)` — over a
 * blob whose members sit on THREE ADR 1 matrix rows. A single contract over that
 * blob has to give one answer to questions the rows answer differently:
 *
 *   | tier                  | matrix row              | visibility             | offline        |
 *   |-----------------------|-------------------------|------------------------|----------------|
 *   | `personal-preference` | `preferences-personal`  | `per-user-state`       | offline-eligible |
 *   | `instance-preference` | `preferences-instance`  | `deployment-substrate` | offline-eligible |
 *   | `server-secret`       | `server-owned-secrets`  | `secret`               | never-enqueue  |
 *
 * `visibility` is a REQUIRED, single-valued field on a contract, so a blob
 * command cannot be classified at all without lying about two thirds of what it
 * writes — and the value it would take is whichever the author typed. That is
 * POD-352's defect stated structurally: *"a generic offline `settings.set` would
 * persist secrets into browser and mobile replica storage AND into the outbox"*.
 * The split is what makes the refusal a CLASS decision rather than a payload
 * inspection, which is the property ADR 1 D6 asks for.
 *
 * The tier boundary is therefore not a taste call: **one contract per matrix
 * row**, and the two preference tiers stay apart because their visibility
 * classes differ even though their delivery class does not.
 *
 * ---------------------------------------------------------------------------
 * THE PATCH IS ADDRESSED BY CLASSIFIED PATH, AND THE SCHEMA IS THE GATE
 * ---------------------------------------------------------------------------
 *
 * A preference write carries `{ values: { '<dotted path>': <value> } }` where
 * every key must be a path {@link classifySettingsPath} knows AND whose tier is
 * this contract's. It is not a partial of the blob shape, for three reasons:
 *
 *  1. A partial of the blob can express a secret. `{ apiKeys: { openai: '…' } }`
 *     is a valid `Partial<PodiumSettings>`, so a blob-shaped preference command
 *     would need a handler-side detector to refuse it — and a detector that
 *     misses one key fails OPEN. Addressed by path, the same write is refused by
 *     `settings.updatePersonal`'s own input schema, before a handler exists.
 *  2. It fails CLOSED on an unknown path. POD-418 made `classifySettingsPath`
 *     answer `undefined` rather than a default tier precisely so that "never
 *     classified" is distinguishable from "deliberately personal"; this schema
 *     is the first consumer to depend on that, and it refuses the `undefined`.
 *  3. It is TOTAL by derivation. The admissible key set is
 *     {@link SETTINGS_CLASSIFICATION} filtered by tier — a leaf added to
 *     `PersonalPreferences` becomes writable through the personal command on the
 *     same commit, and a leaf added to no tier is writable through none of them.
 *
 * The second gate is deliberately a DIFFERENT question asked of the same fact:
 * every key must also satisfy {@link settingsPathMayEnqueue}, POD-418's semantic
 * backstop. A secret path fails both — wrong tier, and not enqueueable — and the
 * two checks would have to be broken together for a secret to reach an
 * offline-eligible command. ADR 9 D4 point 2's shape: the totality check and the
 * semantic backstop are not the same mechanism.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SECRET CONTRACTS MAY NOT DO, AND WHO ENFORCES IT
 * ---------------------------------------------------------------------------
 *
 * `secret` FORCES `online-sensitive` and forbids `outbox` — ADR 3 D4 rule 1 and
 * D3 rule 2, both already enforced by `classificationErrors`, so this file does
 * not restate them as tests of its own. What it adds is the reasoning at the
 * declaration and, in `contracts.test.ts`, the tie-back to the SHIPPED matrix
 * row: a matrix edit that weakened `offline: 'never-enqueue'` reddens a named
 * test rather than silently permitting a queued secret.
 *
 * `machines.pairingCode` (POD-384) is the nearest precedent and this family
 * follows it exactly where it applies: `resource: 'secret'`, no `machineVerb`
 * (there is no compute to place work on), and `ownership.creates` deliberately
 * EMPTY because the matrix row records `owner: { kind: 'none', reason: 'secret'
 * }` — listing a created entity would force an `owner: 'on-behalf-of-human'`
 * declaration for a row the matrix says has no owner, which is the well-typed
 * lie POD-1075 refused.
 */

import {
  classifySettingsPath,
  SERVER_SECRET_KEYS,
  SETTINGS_CLASSIFICATION,
  ServerSecretKey,
  type SettingsTier,
  settingsPathMayEnqueue,
  settingsPathsInTier,
  settingsTierRow,
} from '@podium/model'
import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  CreationOwnership,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
} from '../contract'

// ---------------------------------------------------------------------------
// The path-addressed preference patch
// ---------------------------------------------------------------------------

/**
 * The admissible keys of a preference patch, per tier — DERIVED from POD-418's
 * classification rather than listed here.
 *
 * Exported because both audits and the write planner need to name the surface,
 * and because a consumer that re-derived it would be a second answer to "which
 * paths does this command accept".
 */
export function preferencePathsInTier(tier: SettingsTier): readonly string[] {
  return settingsPathsInTier(tier)
}

/**
 * A patch addressed by classified path, gated on the tier it belongs to.
 *
 * `z.record(z.string(), z.unknown())` and NOT a shape: the VALUE type of a leaf
 * belongs to the model's own schema and is validated where the blob is composed
 * (`normalizeSettings`), not restated per leaf here — restating 39 value types
 * in an L1 contract is exactly the drift ADR 4 reserves the model to prevent.
 * What this schema decides is the ADDRESS, which is the authorization question.
 *
 * Empty is refused. A write that names no path is not a write; admitting it
 * would make "the command succeeded" say nothing about whether anything was
 * classified, and an empty patch is the shape a broken client sends.
 */
function preferencePatch(tier: SettingsTier) {
  return z
    .record(z.string(), z.unknown())
    .superRefine((values: Record<string, unknown>, ctx: z.RefinementCtx) => {
      const keys = Object.keys(values)
      if (keys.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a settings patch must name at least one path',
        })
      }
      for (const path of keys) {
        const classification = classifySettingsPath(path)
        // FAILS CLOSED, and this is the branch POD-418 built `undefined` for: an
        // unclassified path is refused rather than being handed whichever tier
        // the reader assumed. "Deliberately personal" and "never classified"
        // reach different arms here.
        if (!classification) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path],
            message: `'${path}' is not a classified settings path`,
          })
          continue
        }
        if (classification.tier !== tier) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path],
            message: `'${path}' is ${classification.tier}, not ${tier} — it is written by a different command`,
          })
        }
        // The SECOND, semantically independent gate (ADR 9 D4 point 2). A path
        // whose classification says it may not be queued may not ride an
        // offline-eligible command even if its tier somehow matched.
        if (!settingsPathMayEnqueue(path)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path],
            message: `'${path}' may not be enqueued and cannot ride an offline-eligible command`,
          })
        }
      }
    })
}

// ---------------------------------------------------------------------------
// Shared cells — one rule, one object, so a repeat cannot drift
// ---------------------------------------------------------------------------

/**
 * WHAT ACTUALLY SERVES A SETTINGS WRITE, measured rather than aspirational.
 *
 * `trpc` — `apps/server/src/router.ts`'s `settings` slice, which is the only
 * dispatcher for this family. NOT `relay`: `relay.ts` has arms for `specs`,
 * `sessions`, `issues`, `workflows`, `messages`, `workspace`, `lock`, `offer`,
 * `approvals`, `features` and `quota`, and no `settings` arm — so declaring it
 * would be POD-385's defect verbatim, a transport nothing dispatches. NOT `cli`
 * and not `mcp`: there is no `podium settings` verb and no settings tool.
 */
const SERVED_ON: readonly TransportTag[] = ['trpc']

/**
 * PREFERENCES ARE `offline-eligible` AND ARE STILL NOT EXPOSED ON `outbox`, and
 * the gap between those two statements is deliberate.
 *
 * The delivery CLASS is the matrix row's (`offline: 'offline-eligible'`, both
 * preference rows) and it is what this issue was asked to declare. Exposure is a
 * separate, default-closed decision (ADR 3 D3), and today nothing enqueues a
 * settings write: the web outbox (`packages/client-core/src/outbox.ts`) is a
 * kind-keyed executor table with no settings executor in it. Declaring `outbox`
 * here would name a transport no dispatcher reads — POD-385's finding, which
 * POD-386 had to measure the router to catch.
 *
 * So the class says "this MAY be queued" and the exposure says "nothing queues
 * it yet". `contracts.test.ts` pins both halves, and the audit gate pins that no
 * outbox executor names a settings command — so the day one appears, the
 * exposure decision is retaken deliberately instead of by accident.
 */
const PREFERENCE_DELIVERY: DeliveryPolicy = {
  class: 'offline-eligible',
  outboxReconciliation:
    'MAY be queued, and is not queued today. The class is the matrix row’s (`offline: ' +
    '"offline-eligible"` on both preference rows): a preference is field-LWW at the instance tier ' +
    'and single-writer at the personal one, so a write replayed after a reconnect lands on a clock ' +
    'the Authority assigns and never on a client wall clock (ADR 1 D3 condition 1). Exposure ' +
    'deliberately omits `outbox` because no client executor dispatches a settings write — a ' +
    'transport nothing serves is a decoration (POD-385), and POD-419 owns the replica/outbox audit ' +
    'that would land one.',
  applyTimeReauthorization:
    'Re-authorized at every apply against the delegation resolved LIVE (ADR 9 D5 A1 / ADR 3 D8): the ' +
    'role floor and, for the personal tier, the OWNING USER are re-checked at drain, never read from ' +
    'a capability frozen at enqueue. A principal who lost the floor between enqueue and drain has the ' +
    'entry refused and is told so — the entry is dead-lettered rather than retried, because a rights ' +
    'change is not a transient failure (ADR 3 Amendment 1 D16).',
}

/**
 * SECRETS: `online-sensitive`, which the lint already forces from
 * `visibility: 'secret'` — the reasoning is here so the forced value is a
 * DECLARATION and not a value someone typed to satisfy a lint.
 *
 * ADR 1's row: `offline: 'never-enqueue'`, `replication: 'none'`, `conflict:
 * 'cmd'` with the note "online replace only". The Outbox refuses the class
 * outright (`ENQUEUEABLE_DELIVERY` is `offline-eligible` and nothing else), so
 * this is not a rule a handler remembers: an `online-sensitive` command cannot
 * be spelled into `enqueue` at the type level, with a runtime refusal behind it
 * for the untyped boundaries.
 */
const SECRET_DELIVERY: DeliveryPolicy = {
  class: 'online-sensitive',
  outboxReconciliation:
    'NEVER queued, at any layer. ADR 1’s `server-owned-secrets` row is `offline: "never-enqueue"` ' +
    'and `replication: "none"`; ADR 3 D4 rule 1 makes a `secret` policy imply `online-sensitive`, and ' +
    'D3 rule 2 forbids `outbox` exposure for it. The Outbox enforces the class rather than inspecting ' +
    'the payload (POD-352): a queued secret would persist credential material into browser and mobile ' +
    'replica storage, where the whole content of ADR 1 D6 is that it never goes. An offline caller is ' +
    'REFUSED with a reason, not held — holding it durably is the failure.',
  applyTimeReauthorization:
    'Apply IS the call — there is no queue and therefore no gap to re-authorize across — so the ' +
    'obligation ADR 3 D8 / Amendment 1 D16 places on this family is the LIVE check at the moment of ' +
    'the write: the admin floor is resolved against the principal’s CURRENT rights, never a ' +
    'capability minted at spawn, and an agent’s scope is intersected with its human’s (ADR 9 D5 A1). ' +
    'The caller is told which of the two refused it. Nothing enforces the floor today — that is ' +
    'POD-1079’s, the same recorded gap `machines.pairingCode` carries.',
}

/**
 * ADR 3 D7 / Amendment 1 D17 — the pair, both halves from the transport
 * principal. Identical across the family because it is one rule.
 *
 * The rows agree: both preference rows and the secret row carry `attribution:
 * { actor: 'required', onBehalfOf: 'required' }`. Note that the settings blob
 * itself persists NEITHER half today — it is one un-attributed singleton — which
 * is a statement about what the STORE remembers, not about what the command must
 * carry to be authorized and audited. POD-421 owns the audit-log half.
 */
const SETTINGS_ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Both halves stamped from the transport principal, never from payload — the shape ADR 1’s three ' +
    'settings rows already require (`attribution: { actor: "required", onBehalfOf: "required" }`). ' +
    'Separate wire keys: the only address these commands carry is a settings PATH or a secret KEY, ' +
    'and Amendment 1 D17 forbids a routing address doubling as the accountability record. The blob ' +
    'persists neither half today; POD-421 owns making the rotation of a secret auditable.',
}

/**
 * No settings command mints an entity.
 *
 * A preference write moves a member of a singleton that already exists — ADR 1
 * records `tombstone: 'never-delete'` with "reset-to-default is a write, not a
 * delete" — and the per-user tier's row is materialised by the store on first
 * write, which is a storage act rather than an ADR 9 D5 A4 creation with an
 * owner to assign. The secret arm's emptiness is a stronger claim; see
 * {@link SECRET_OWNERSHIP}.
 */
const PREFERENCE_OWNERSHIP: CreationOwnership = {
  creates: [],
  note:
    'Mints nothing. Writes a member of a settings singleton that already exists — ADR 1: ' +
    '`tombstone: "never-delete"`, "reset-to-default is a write, not a delete". The personal tier’s ' +
    'row is keyed `(userId)` and is materialised by the store on first write, which assigns no ' +
    'ownership: the row IS the user’s by its key, and there is nothing for `inheritanceOnCreate` to ' +
    'decide (ADR 9 D3 rule 4 — per-user state is non-grantable, so no grant can be inherited).',
}

/**
 * EMPTY, and the emptiness is the decision — `machines.pairingCode`'s exactly.
 *
 * ADR 1's `server-owned-secrets` row records `owner: { kind: 'none', reason:
 * 'secret' }`: *"the material is the INSTANCE's, not personal. Giving secrets an
 * owner would multiply the surface D6 exists to minimise and would imply
 * transfer semantics for credentials."* Listing the stored secret under
 * `creates` would force this contract to declare `owner: 'on-behalf-of-human'`
 * for a row the matrix says has no owner.
 */
const SECRET_OWNERSHIP: CreationOwnership = {
  creates: [],
  note:
    'Deliberately EMPTY, per `machines.pairingCode` (POD-384) and for the same reason: ADR 1’s ' +
    '`server-owned-secrets` row carries `owner: { kind: "none", reason: "secret" }` and ' +
    '`inheritanceOnCreate: not-applicable`. A secret has no owner and no grants to inherit (D15), so ' +
    'naming the stored row under `creates` would force an `owner: "on-behalf-of-human"` declaration ' +
    'for a row the matrix says has none — the well-typed lie POD-1075 refused. Replacing a secret is ' +
    'a REPLACE (`conflict: "cmd"`, "online replace only"), not a mint.',
}

/**
 * Reviewed, and the answer differs by tier — which is why this is not one shared
 * cell.
 *
 * Preferences: nothing redacted, with the candidate named. `notifications.
 * telegramChatId` and `notifications.ntfyTopic` are ROUTING addresses, and ADR 9
 * D8 S4 says in as many words that classifying the chat id as a secret would
 * break the per-user routing S3 depends on. They are `secret: 'preference'` on
 * the matrix.
 */
const PREFERENCE_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note:
    'Nothing redacted, and the candidates are named so the empty lists are a finding rather than a ' +
    'default. `notifications.telegramChatId` and `notifications.ntfyTopic` are notification ROUTING ' +
    'addresses, not credentials: ADR 9 D8 S4 moves the chat id to the personal-preference row ' +
    'explicitly because classifying it as a secret would break the per-user routing S3 depends on, ' +
    'and the matrix carries both as `secret: "preference"`. `roles.*.accountId` is a REFERENCE to a ' +
    'managed account row, never the material (POD-418, §3.1.6 S1). No path this command can address ' +
    'is `secret-value` — the schema refuses one — so there is no credential on this surface to redact.',
}

/**
 * THE INPUT IS THE SECRET, which is the whole reason this cell exists.
 *
 * `value` is the material and must never be logged, echoed into an event,
 * persisted client-side, or included in an error. The OUTPUT deliberately
 * carries no material at all: the response is `SecretPresenceWire`, which
 * POD-418 built independently of `ServerSecret` precisely so there is no value
 * key to forget to strip — so `outputPaths` is empty by CONSTRUCTION rather than
 * by review, and the note says which.
 */
const SECRET_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: ['value'],
  outputPaths: [],
  note:
    'THE INPUT IS THE SECRET. `value` is credential material: never logged, never echoed into an ' +
    'event, never included in an error, never persisted client-side. `key` is NOT redacted — it is a ' +
    'member of a closed five-value vocabulary that the presence projection already publishes, so ' +
    'redacting it would hide the only thing that makes a refusal actionable while protecting nothing. ' +
    '`outputPaths` is empty BY CONSTRUCTION and not by review: the response is `SecretPresenceWire` ' +
    '(presence + opaque fingerprint + rotation time), which POD-418 built independently of ' +
    '`ServerSecret` so that no projection has a value key to strip. The fingerprint is a truncated ' +
    'HMAC under a server-held key and is safe to return; a bare digest of a short structured ' +
    'credential would not be, and `SECRET_FINGERPRINT_CONTRACT` says so at the model.',
}

/**
 * Neither tier takes an entity id, and both take a caller-supplied ADDRESS from
 * a CLOSED vocabulary — which is why this is `false` rather than a D20.2
 * declaration.
 *
 * D20's hazard is an existence oracle: a caller iterating ids and reading the
 * difference between "you may not see it" and "there is no such thing". Neither
 * address here can carry that. A preference path must be one of the 39 the
 * classification names, and every one of them exists on every instance; a secret
 * key must be one of the five `SERVER_SECRET_KEYS`, and the presence projection
 * publishes a row for ALL FIVE always — POD-418 made "absent from the list"
 * unrepresentable so that a reader never has to distinguish it from
 * `present: false`. An unknown address fails as a SCHEMA error, which discloses
 * only that the vocabulary is closed, and the vocabulary is public.
 */
const CLOSED_VOCABULARY_ERRORS: ErrorConsistency = {
  callerSuppliedTargetId: false,
  note:
    'The caller supplies an ADDRESS, never an entity id, and both address spaces are CLOSED and ' +
    'public: one of 39 classified settings paths, or one of five `SERVER_SECRET_KEYS`. Every member ' +
    'of both exists on every instance — the presence projection publishes a row for all five keys ' +
    'always (POD-418) — so there is no hidden entity whose existence an error could confirm and ' +
    'nothing to converge D20.2 onto. An address outside the vocabulary fails as a schema error, ' +
    'disclosing only that the vocabulary is closed. NOTE the one thing that is NOT disclosed by ' +
    'design: a refusal must never differ by whether a secret is currently CONFIGURED, which is the ' +
    'presence bit and belongs to the projection, not to an error.',
}

// ---------------------------------------------------------------------------
// settings.updatePersonal
// ---------------------------------------------------------------------------

/** The 24 personal-preference leaves, addressed by path. */
export const settingsUpdatePersonalInput = z.object({
  values: preferencePatch('personal-preference'),
})

/**
 * A PER-USER write, and the classification POD-418 settled which this contract
 * must not re-open.
 *
 * `per-user-state` and NOT `personal`: these leaves differ per READER and are
 * keyed `(userId)`. `autoContinue.promptDismissed` is exactly the readAt/snooze
 * shape POD-351 and POD-731 warn about — a `personal` classification here would
 * key a per-user fact as a shared one, which is the trap that has now bitten
 * this run more than once.
 *
 * `roleFloor: 'member'` and `action: 'write'`: a member writes their OWN row and
 * nobody else's. There is no subtree gate because there is no shared row to
 * gate, and ADR 9 D3 rule 4 makes the class non-grantable — there is deliberately
 * no "share my sidebar order" verb to authorize.
 *
 * RECORDED GAP, unchanged by this issue: the row is an instance-wide SINGLETON
 * today, not one per user. `PerUserSingletonKey` is the model's declaration of
 * the intended key and the `per-user-singletons` ratchet counts the defect. The
 * contract states the CLASS truthfully — the same call POD-311 made for the
 * issue read markers — rather than describing today's storage.
 */
export const settingsUpdatePersonalContract = {
  name: 'settings.updatePersonal',
  version: 1,
  visibility: 'per-user-state',
  input: settingsUpdatePersonalInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'settings-domain',
    confirmation: 'none',
    rationale:
      'A member writes their OWN preference row. `resource: "settings-domain"` names the row gate: the ' +
      'settings surface, scoped by the key `(userId)` the matrix row declares — not `none`, because ' +
      'there IS a target class, and not `global`, because a personal preference is nobody else’s. No ' +
      'confirmation: every leaf is reversible by writing it again and ADR 1 records ' +
      '`tombstone: "never-delete"`. No `machineVerb`: a preference write places no work on owned ' +
      'compute — `hibernation` and `gitWorkflow`, the two leaves that DO describe machine behaviour, ' +
      'are on the instance tier and are still only rows (POD-418). RECORDED GAP: the row is an ' +
      'instance-wide singleton today, so this floor cannot yet be enforced per user; the ' +
      '`per-user-singletons` ratchet counts it and POD-302 owns the re-key.',
  },
  exposure: SERVED_ON,
  delivery: PREFERENCE_DELIVERY,
  redaction: PREFERENCE_REDACTION,
  ownership: PREFERENCE_OWNERSHIP,
  attribution: SETTINGS_ATTRIBUTION,
  errorConsistency: CLOSED_VOCABULARY_ERRORS,
  cli: { summary: 'Write personal preference leaves by classified path' },
} as const satisfies CommandContract<typeof settingsUpdatePersonalInput>

// ---------------------------------------------------------------------------
// settings.updateInstance
// ---------------------------------------------------------------------------

/** The 10 instance-preference leaves, addressed by path. */
export const settingsUpdateInstanceInput = z.object({
  values: preferencePatch('instance-preference'),
})

/**
 * A DEPLOYMENT-SUBSTRATE write: one answer for everybody on this instance.
 *
 * `deployment-substrate`, read off the row, whose owner is `{ kind: 'none',
 * reason: 'substrate' }` — *"a property of the DEPLOYMENT, not of a person"* —
 * and whose grants cell says "Write is admin-grade" in as many words. That is
 * the `roleFloor: 'admin'`, and it is the ONLY difference in policy from the
 * personal tier.
 *
 * POD-418 settled the two memberships this contract must not re-open, and both
 * are here rather than on the personal tier for reasons that are about
 * COHERENCE, not privacy: a per-user memory ceiling cannot be honoured
 * (`hibernation` — one machine, one RAM budget), and two merge styles on one
 * repo is one repo with two histories (`gitWorkflow`). `experimental` is an open
 * record of feature ids and is instance-wide by its own matrix note.
 */
export const settingsUpdateInstanceContract = {
  name: 'settings.updateInstance',
  version: 1,
  visibility: 'deployment-substrate',
  input: settingsUpdateInstanceInput,
  policy: {
    action: 'write',
    roleFloor: 'admin',
    resource: 'settings-domain',
    confirmation: 'none',
    rationale:
      'One answer for the whole deployment, so the floor is ADMIN — ADR 1’s row states it directly ' +
      '(`grants: { kind: "none", reason: "substrate", note: "Write is admin-grade." }`, `writers: ' +
      '["operator"]`). `resource: "settings-domain"` and not `global`: the gate is the settings ' +
      'surface, not every instance-wide row there is. No confirmation — these are toggles, every one ' +
      'reversible by writing it again — with the deliberate note that `hibernation.enabled` and ' +
      '`gitWorkflow.mergeStyle` have instance-wide behavioural blast radius; the ADMIN FLOOR is the ' +
      'gate that answers that, not a per-call confirmation prompt an agent would click through. ' +
      'Nothing enforces the floor today (single operator principal); POD-1079 owns it, and this ' +
      'contract is what it will read.',
  },
  exposure: SERVED_ON,
  delivery: PREFERENCE_DELIVERY,
  redaction: PREFERENCE_REDACTION,
  ownership: PREFERENCE_OWNERSHIP,
  attribution: SETTINGS_ATTRIBUTION,
  errorConsistency: CLOSED_VOCABULARY_ERRORS,
  cli: { summary: 'Write instance preference leaves by classified path' },
} as const satisfies CommandContract<typeof settingsUpdateInstanceInput>

// ---------------------------------------------------------------------------
// settings.setSecret
// ---------------------------------------------------------------------------

/**
 * Replace one server-owned secret.
 *
 * `.min(1)` on the value, matching `ServerSecret.value`: an empty secret is not
 * a secret, it is an ABSENT one, and the two must not be spellable the same way
 * — that is what `clearSecret` is for, and keeping them separate is what lets
 * `present` mean something. Today's blob spells "not configured" as `''`, which
 * is precisely the ambiguity this pair removes at the command layer.
 */
export const settingsSetSecretInput = z.object({
  key: ServerSecretKey,
  value: z.string().min(1),
})

export const settingsSetSecretContract = {
  name: 'settings.setSecret',
  version: 1,
  visibility: 'secret',
  input: settingsSetSecretInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'secret',
    confirmation: 'confirm',
    rationale:
      'Replaces credential material with an instance-wide billing and access blast radius, so it is ' +
      'ADMIN-grade: ADR 9 D3 rule 5 — "secret management becomes admin-grade once there is more than ' +
      'one human" — and the matrix row’s own `visibilityMutability` note, "any authenticated principal ' +
      'may replace the org’s provider key is a privilege escalation with a billing blast radius". ' +
      '`action: "manage"` rather than `write`: this administers the instance’s credentials, it does ' +
      'not edit a row the caller owns — the row has no owner at all (`owner: { kind: "none", reason: ' +
      '"secret" }`). `resource: "secret"` is what forces `online-sensitive` through ' +
      '`classificationErrors`, and it carries NO `machineVerb`, exactly as `machines.pairingCode` ' +
      'does: there is no compute this places work on. `confirmation: "confirm"` because a replace is ' +
      'DESTRUCTIVE — `conflict: "cmd"`, online replace only, and the previous material is ' +
      'unrecoverable the moment it is overwritten. Nothing enforces the floor today; POD-1079 owns it.',
  },
  exposure: SERVED_ON,
  delivery: SECRET_DELIVERY,
  redaction: SECRET_REDACTION,
  ownership: SECRET_OWNERSHIP,
  attribution: SETTINGS_ATTRIBUTION,
  errorConsistency: CLOSED_VOCABULARY_ERRORS,
  cli: { summary: 'Replace a server-owned secret (online only)' },
} as const satisfies CommandContract<typeof settingsSetSecretInput>

// ---------------------------------------------------------------------------
// settings.clearSecret
// ---------------------------------------------------------------------------

/** Remove one server-owned secret. ADR 1: `tombstone: 'hard-delete'`, "cleared
 *  server-side" — there is no tombstone and no recovery path. */
export const settingsClearSecretInput = z.object({ key: ServerSecretKey })

export const settingsClearSecretContract = {
  name: 'settings.clearSecret',
  version: 1,
  visibility: 'secret',
  input: settingsClearSecretInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'secret',
    confirmation: 'confirm',
    rationale:
      'The same admin floor and the same `secret` resource as `setSecret`, for the same ADR 9 D3 rule ' +
      '5 reason — and it is a SEPARATE command rather than `setSecret` with an empty value, because ' +
      'the model refuses to let absence and emptiness be spelled the same way (`ServerSecret.value` ' +
      'is `.min(1)`). Collapsing them would make `SecretPresenceWire.present` unable to mean ' +
      'anything, and would make "I cleared the key" and "I saved a blank form field" the same wire ' +
      'message. `confirmation: "confirm"`: ADR 1 records `tombstone: "hard-delete"` — cleared ' +
      'server-side, no tombstone, no recovery — and clearing a provider key stops every agent that ' +
      'depends on it.',
  },
  exposure: SERVED_ON,
  delivery: SECRET_DELIVERY,
  redaction: {
    ...SECRET_REDACTION,
    inputPaths: [],
    note:
      'Carries NO material: the input is a key from the closed vocabulary, which is why `inputPaths` ' +
      'is empty here where `setSecret`’s names `value`. Stated rather than shared, so the difference ' +
      'between the two is a declaration. The output is the same `SecretPresenceWire` — presence ' +
      'false, fingerprint null — and carries no value key by construction (POD-418).',
  },
  ownership: SECRET_OWNERSHIP,
  attribution: SETTINGS_ATTRIBUTION,
  errorConsistency: CLOSED_VOCABULARY_ERRORS,
  cli: { summary: 'Clear a server-owned secret (online only)' },
} as const satisfies CommandContract<typeof settingsClearSecretInput>

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * The four settings WRITES, keyed by wire name.
 *
 * `settings.get` is deliberately absent — the same split every family here made.
 * It is a read, and what it returns is POD-419's question (the scrub that stops
 * the blob carrying secrets to clients) and POD-421's (the presence projection
 * that replaces them). A contract for it written now would classify a payload
 * that is about to change shape.
 *
 * `settings.telegramSetupStart` / `telegramSetupPoll` are also absent, and that
 * is a decision rather than an oversight: they are a stateful PAIRING CEREMONY
 * over a third-party API — start mints a code, poll long-polls Telegram and
 * writes `notifications.telegramChatId` on success — not a settings write with a
 * payload. They read the bot token and never carry it. Modelling a ceremony as a
 * command contract is its own design question, and ADR 9 D8's note that the
 * inbound Telegram edge becomes an AUTHENTICATION surface under multi-user says
 * that question is bigger than this issue. `audit-settings-commands.ts` names
 * them as the two hand-written writes this family still allows, by key, so the
 * exception is visible and counted rather than assumed.
 */
export const SETTINGS_CONTRACTS = {
  'settings.updatePersonal': settingsUpdatePersonalContract,
  'settings.updateInstance': settingsUpdateInstanceContract,
  'settings.setSecret': settingsSetSecretContract,
  'settings.clearSecret': settingsClearSecretContract,
} as const

export type SettingsContractName = keyof typeof SETTINGS_CONTRACTS

/** Sorted, so a table-driven consumer's order does not depend on declaration order. */
export const SETTINGS_COMMAND_NAMES = Object.keys(
  SETTINGS_CONTRACTS,
).sort() as SettingsContractName[]

/**
 * Which command writes a given tier — the mapping the write planner and the
 * server registry both need, declared ONCE so neither invents its own.
 *
 * There is no entry for a fourth tier because `SettingsTier` has three members;
 * the `satisfies` makes a new tier a compile error here rather than a path with
 * no command, which is how a settings leaf could otherwise become unwritable
 * without anything noticing.
 */
export const TIER_COMMAND: Readonly<Record<SettingsTier, SettingsContractName>> = {
  'personal-preference': 'settings.updatePersonal',
  'instance-preference': 'settings.updateInstance',
  // A secret write is addressed by KEY, not by path, so the mapping names the
  // replace arm; `clearSecret` is the same tier reached by the other verb.
  'server-secret': 'settings.setSecret',
} as const satisfies Record<SettingsTier, SettingsContractName>

/**
 * The matrix row each command's tier answers to. Used by `contracts.test.ts` to
 * assert every column against the SHIPPED row rather than against a restatement
 * — POD-305's rule, applied per contract rather than to arm 0.
 */
export const CONTRACT_TIER: Readonly<Record<SettingsContractName, SettingsTier>> = {
  'settings.updatePersonal': 'personal-preference',
  'settings.updateInstance': 'instance-preference',
  'settings.setSecret': 'server-secret',
  'settings.clearSecret': 'server-secret',
}

/** The shipped matrix row a contract's classification is read off. */
export function contractMatrixRow(name: SettingsContractName): ReturnType<typeof settingsTierRow> {
  return settingsTierRow(CONTRACT_TIER[name])
}

/** Every classified path this family can write, across both preference tiers.
 *  Derived, so it grows with the model and never with a hand list. */
export const WRITABLE_PREFERENCE_PATHS: readonly string[] = SETTINGS_CLASSIFICATION.filter(
  (c) => c.tier !== 'server-secret',
).map((c) => c.path)

/** The five secret keys, re-exported at the command layer so a consumer of the
 *  family does not have to reach past it into the model for the vocabulary. */
export const SECRET_COMMAND_KEYS = SERVER_SECRET_KEYS
