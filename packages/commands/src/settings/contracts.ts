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
  MutationIdField,
  OWNERSHIP_MATRIX_INDEX,
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
const PERSONAL_SERVED_ON: readonly TransportTag[] = ['trpc', 'outbox']

/**
 * PREFERENCE WRITES ARE `offline-eligible`; personal preferences are now exposed on `outbox`.
 *
 * Personal preferences have a client executor and therefore name the Outbox transport.
 * Instance preferences remain tRPC-only until their owning client action is migrated.
 */
const PREFERENCE_REAUTHORIZATION =
  'Re-authorized at every apply against the delegation resolved LIVE (ADR 9 D5 A1 / ADR 3 D8): the ' +
  'role floor and, for the personal tier, the OWNING USER are re-checked at drain, never read from ' +
  'a capability frozen at enqueue. A principal who lost the floor between enqueue and drain has the ' +
  'entry refused and is told so — the entry is dead-lettered rather than retried, because a rights ' +
  'change is not a transient failure (ADR 3 Amendment 1 D16).'

/**
 * THE PERSONAL TIER'S offline-eligibility, argued rather than inherited.
 *
 * POD-735 is the precedent for NOT simply copying the row's `offline` column: it
 * argued `automations` online-only against ADR 1 §7's `offline-eligible`,
 * because ADR 3 Amendment 1 D18.3 as amended is hard and an ARMED automation is
 * not inert text. The test that reasoning suggests is *what does this write DO
 * while it sits in a queue, and what does it do when replayed late?*
 *
 * A personal preference is genuinely inert on both counts. It arms nothing,
 * spawns nothing and executes nowhere — `sidebar.repoSort`, `roles.*.model`,
 * `autoContinue.enabled` are read at the next decision point and have no effect
 * until something asks. Replayed late it is a stale opinion overwriting a newer
 * one, which is the ordinary last-writer cost every offline-eligible class
 * accepts, and the row is SINGLE-WRITER (keyed `(userId)`), so the only writer
 * it can race is the same person on another device.
 *
 * The one member that gave pause is `autoContinue.enabled`, which does gate an
 * automatic action. It is still inert as a WRITE: it is a boolean the
 * auto-continue loop reads when it next runs, not a command that starts one, and
 * queueing it can at most delay or advance an opinion by the length of a
 * partition. That is the D18.3 line — it forbids a command whose APPLY executes
 * on someone's hardware, not one whose value is later read by something that
 * does.
 */
const PERSONAL_PREFERENCE_DELIVERY: DeliveryPolicy = {
  class: 'offline-eligible',
  outboxReconciliation:
    'MAY be queued, and is not queued today. ARGUED, not inherited from the row (POD-735’s ' +
    'precedent for departing from a written column): a personal preference is INERT — it arms ' +
    'nothing and executes nowhere, so a queued write does nothing while it waits, and replayed late ' +
    'it is at worst a stale opinion overwriting a newer one on a SINGLE-WRITER row keyed `(userId)`. ' +
    '`autoContinue.enabled` is the member that gave pause and is still inert as a write: it is a ' +
    'boolean the loop reads when it next runs, not a command that starts one, which is the D18.3 ' +
    'line. The personal contract is exposed on `outbox` because the client actions dispatcher queues this replicated per-user row. Instance preferences remain direct until their owning action is migrated.',
  applyTimeReauthorization: PREFERENCE_REAUTHORIZATION,
}

/**
 * THE INSTANCE TIER'S offline-eligibility, which is the harder of the two and is
 * argued separately for that reason.
 *
 * Same inertness test, same answer — a merge style and a memory ceiling are rows
 * read at a decision point, not work placed on compute — but the CONFLICT story
 * differs and it is the reason this is not one shared cell. The instance row is
 * `field-LWW` and is *"THE ONLY SURVIVING field-LWW MEMBER"* (ADR 1 Amendment 1
 * D10), whose four D3 conditions the row re-checks explicitly: a defined clock
 * (the Authority-assigned event time at commit — client wall clocks never
 * arbitrate), an independent key group, low semantic risk, and reset-to-default
 * as a write on the same clock. A queued instance preference is exactly the case
 * that machinery was kept for, so `offline-eligible` here is not a copied class
 * but the one the conflict rule was designed around.
 *
 * The blast radius is real and is answered elsewhere: `hibernation.enabled` and
 * `gitWorkflow.mergeStyle` affect everybody on the deployment, which is why the
 * ROLE FLOOR is admin. A delivery class is not the gate for "should this person
 * be allowed to", and using one as such would be enforcing authorization through
 * a connectivity requirement.
 */
const INSTANCE_PREFERENCE_DELIVERY: DeliveryPolicy = {
  class: 'offline-eligible',
  outboxReconciliation:
    'MAY be queued, and is not queued today. ARGUED per tier: an instance preference is inert in the ' +
    'same way the personal ones are, and its conflict rule is the one case ADR 1 Amendment 1 D10 ' +
    'KEPT field-LWW for — a defined Authority clock, an independent key group, low semantic risk, ' +
    'and reset-to-default as a write on the same clock, which is precisely a queued-then-replayed ' +
    'toggle. The instance-wide blast radius is answered by the ADMIN ROLE FLOOR, not by a ' +
    'connectivity requirement: a delivery class is not an authorization gate. Exposure omits ' +
    '`outbox` for the same reason the personal tier does — nothing dispatches it (POD-385).',
  applyTimeReauthorization: PREFERENCE_REAUTHORIZATION,
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
  mutationId: z.string().max(128).pipe(MutationIdField).optional(),
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
 * POD-1213 made the class physical: values are rows keyed `(userId, key)`, the
 * legacy shared blob no longer holds personal leaves, and every repository read
 * and write takes the user. The member floor therefore gates an actual owning
 * user's row rather than an intended key shape whose storage had not followed
 * its declaration.
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
      'are on the instance tier. POD-1213 stores personal values under `(userId, key)` and resolves ' +
      'the caller live, so this member floor now gates the owning user’s row at apply time rather ' +
      'than describing a future storage split.',
  },
  exposure: PERSONAL_SERVED_ON,
  delivery: PERSONAL_PREFERENCE_DELIVERY,
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
  delivery: INSTANCE_PREFERENCE_DELIVERY,
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
// settings.secretPresence — THE READ, and the only one this family contracts
// ---------------------------------------------------------------------------

/**
 * WHAT A REPLICA MAY LEARN ABOUT THE INSTANCE'S SECRETS: that they exist, an
 * opaque tag for telling one from another, and when each was last replaced
 * (POD-421, 3.7d).
 *
 * ---------------------------------------------------------------------------
 * WHY A READ IS CONTRACTED AT ALL, WHEN `settings.get` IS NOT
 * ---------------------------------------------------------------------------
 *
 * POD-420 left `settings.get` uncontracted with a stated reason — *"a
 * `visibility` class describes what a command WRITES"* — and that reason still
 * holds for the preference blob. It does NOT hold here, and the difference is
 * the whole point of this contract: what makes this read dangerous is not what
 * it writes but WHO MAY ISSUE IT, and `roleFloor` is the field that says so.
 * Leaving it uncontracted would leave the answer in a handler, where it is
 * invisible to `classificationErrors`, to `audit:settings`, and to the next
 * person adding a caller.
 *
 * `visibility: 'secret'` is therefore read as the class of the state the command
 * TOUCHES rather than writes. That is a widening of the field's meaning and it
 * is recorded as one; the alternative — a `visibility` this contract cannot
 * honestly fill — would have meant either a lie or an exemption, and ADR 9 D4's
 * default-closed rule exists precisely so that an unclassifiable surface is a
 * problem to solve rather than a field to leave off.
 *
 * ---------------------------------------------------------------------------
 * THE FLOOR IS `admin`, AND IT IS A PLACEHOLDER FOR AN OPEN QUESTION
 * ---------------------------------------------------------------------------
 *
 * `docs/multi-user-readiness.md` §3.1.2 lists existence leaks as an UNRESOLVED
 * policy class — *"Decide per surface whether existence is private or only
 * content is"* — and whether a non-admin may see secret presence and fingerprint
 * is one of the two questions POD-352 is holding open for a human.
 *
 * Absent that decision this FAILS CLOSED at `admin`. Shipping the closed default
 * is explicitly NOT the decision: it is the safe placeholder, it is recorded as
 * still-open on POD-352, and it is the direction that can be relaxed later
 * without having leaked anything in the meantime. The opposite default cannot be
 * un-leaked.
 *
 * ---------------------------------------------------------------------------
 * AND THE REFUSAL MUST NOT BE AN EXISTENCE ORACLE
 * ---------------------------------------------------------------------------
 *
 * §3.1.5's consistent-error rule: an unauthorized read must fail IDENTICALLY to
 * a nonexistent one. It applies to an error toast exactly as it applies to a
 * status code — a member who can tell "you may not see this" from "there is
 * nothing here" has been told whether the instance has a key configured, which
 * is the very fact the floor is withholding.
 */
export const settingsSecretPresenceInput = z.object({})

export const settingsSecretPresenceContract = {
  name: 'settings.secretPresence',
  version: 1,
  visibility: 'secret',
  input: settingsSecretPresenceInput,
  policy: {
    action: 'read',
    roleFloor: 'admin',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      'A READ, contracted for the field the others are contracted for: `roleFloor`. What makes this ' +
      'surface dangerous is who may ISSUE it, not what it writes, and leaving that in a handler puts ' +
      'it beyond `classificationErrors` and `audit:settings`. The floor is `admin` because ADR 9 D3 ' +
      'rule 5 makes secret management admin-grade and `docs/multi-user-readiness.md` §3.1.2 leaves ' +
      'the EXISTENCE-leak question — may a member see presence and fingerprint? — explicitly open. ' +
      'Failing closed is the placeholder, not the answer: it is recorded as still-open on POD-352, ' +
      'and it is the only direction that can be revised later without having already leaked. ' +
      '`action: "read"` and `resource: "secret"` — the latter forces `online-sensitive` through ' +
      '`classificationErrors`, which is correct here for an independent reason: a presence ' +
      'projection cached offline would answer "is a key configured" from a snapshot taken before it ' +
      'was cleared. `confirmation: "none"`: reading nothing destroys nothing.',
  },
  exposure: SERVED_ON,
  delivery: SECRET_DELIVERY,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'BOTH LISTS ARE EMPTY BY CONSTRUCTION, not by review, and the distinction is the same one ' +
      'POD-418 built the shape for. The input is `{}` — there is nothing to carry. The output is ' +
      '`SecretPresenceWire[]`, which POD-418 built INDEPENDENTLY of `ServerSecret` rather than as a ' +
      'projection of it, precisely so no value key exists to forget to strip; a field added to the ' +
      'stored secret cannot reach this response by being additive. The `fingerprint` is safe to ' +
      'return because it is a truncated HMAC under a server-held key (POD-420’s producer, ' +
      '`SECRET_FINGERPRINT_CONTRACT` at the model) — a bare digest of a short structured ' +
      'credential would NOT be, and would make this "safe" field a slower spelling of the secret.',
  },
  ownership: { creates: [], note: 'A read creates nothing.' },
  attribution: SETTINGS_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: false,
    note:
      'Takes no target id — it answers for the whole closed five-key vocabulary at once, so there is ' +
      'no id to probe with. The consistent-error obligation is therefore about the SURFACE rather ' +
      'than about a row: a principal below the floor must not be able to tell a refusal from an ' +
      'instance that has no secrets configured, and must not be able to tell it from an error either. ' +
      'readiness §3.1.5, applied to an error toast as much as to a status code.',
  },
  cli: { summary: 'Show which server-owned secrets are configured (presence + fingerprint only)' },
} as const satisfies CommandContract<typeof settingsSecretPresenceInput>

// ---------------------------------------------------------------------------
// settings.telegramSetupStart / settings.telegramSetupPoll — THE BINDING CEREMONY
// ---------------------------------------------------------------------------

/**
 * THE TWO HALVES OF ONE AUTHENTICATION CEREMONY (POD-1080, ADR 3 Amendment 1
 * D22) — and the answer to the question POD-420 recorded and deferred.
 *
 * That note read: *"Modelling a ceremony as a command contract is its own design
 * question, and ADR 9 D8's note that the inbound Telegram edge becomes an
 * AUTHENTICATION surface under multi-user says that question is bigger than this
 * issue."* This is that issue, and the answer is yes: a mint and a redemption
 * are two commands, they write state on two different matrix rows, and being
 * unclassifiable was never a property of ceremonies — it was a property of not
 * having decided what the ceremony was FOR.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE NAMES AND NOT NEW ONES
 * ---------------------------------------------------------------------------
 *
 * They are the wire keys `router.ts` already serves and the web client already
 * calls. A `telegram.claimCode` family beside them would be a THIRD spelling of
 * one ceremony (after the procedure keys and the service methods), and the
 * exception list in `scripts/audit-settings-commands.ts` would then have to name
 * the old pair forever while a new pair sat next to it. Contracting the existing
 * names instead makes that exception list SHRINK, which is the direction a
 * ratchet is supposed to move.
 *
 * ---------------------------------------------------------------------------
 * WHY START IS `secret` AND POLL IS `per-user-state`
 * ---------------------------------------------------------------------------
 *
 * `visibility` names what a command WRITES, and these two write different rows.
 * Start mints a claim code — a bearer preimage, ADR 9 D3's `secrets` class, the
 * same cell `machines.pairingCode` carries. Poll consumes that mint and writes
 * the durable `(userId, chatId)` binding, which ADR 1's matrix carries as
 * `telegram-chat-binding`: `perUserState`, `secret: 'preference'`,
 * `offline: 'online-only'`. Giving both the mint's class would have classified
 * the binding as credential material and made it unreplicable to its own owner;
 * giving both the binding's class would have put a live bearer code in a class
 * that replicates.
 */

/**
 * Start takes no arguments — and `.default({})` is what lets that stay true
 * through a schema-driven transport.
 *
 * The shipped client calls `telegramSetupStart.mutate()` with no argument, so
 * the parsed input is `undefined`; a bare `z.object({})` rejects that and the
 * ceremony would break at runtime while every type still checked. The default
 * makes "no argument" the schema's own answer rather than a transport quirk.
 *
 * What is deliberately ABSENT is any user, chat or identity field. There is
 * nothing here for a caller to assert about who they are: the mint reads its
 * user from the transport principal, which is the entire mechanism (ADR 3 D7).
 */
export const settingsTelegramSetupStartInput = z.object({}).default({})

/**
 * The mint's delivery class, argued rather than inherited.
 *
 * Same conclusion as {@link SECRET_DELIVERY} and a different row: ADR 1's
 * `telegram-chat-binding` row is `offline: 'online-only'`, and the code this
 * command RETURNS is a preimage on top of that. Both reasons point the same way,
 * so the class is `online-sensitive` — which `resource: 'secret'` forces anyway
 * (ADR 3 D4 rule 1), and the agreement between the forced value and the argued
 * one is the check.
 */
const TELEGRAM_MINT_DELIVERY: DeliveryPolicy = {
  class: 'online-sensitive',
  outboxReconciliation:
    'NEVER queued. The mint RETURNS a live bearer credential, so a queue entry for it is a token at ' +
    'rest on a client and a replay mints a SECOND live code nobody asked for — `machines.pairingCode`’s ' +
    'reasoning verbatim, because it is the same act. The ceremony is also a real-time conversation ' +
    'with a third-party API (`getMe`, then `getUpdates` long-polls for the code), which a queue ' +
    'cannot replay meaningfully: the window it opens is measured in minutes and the update it waits ' +
    'for is consumed by the poll. ADR 1’s `telegram-chat-binding` row says `online-only` from the ' +
    'other end.',
  applyTimeReauthorization:
    'Apply IS the call — no queue, so no gap to re-authorize across. The obligation ADR 3 D8 / ' +
    'Amendment 1 D16 places here lands at the REDEEM instead, and it is the interesting half: the ' +
    'binding names the MINTING user, resolved live at redemption, so a principal disabled between ' +
    'mint and redeem must not acquire a chat that speaks as them. Nothing enforces the admin floor ' +
    'today — POD-315 owns per-user login, and `settings.setSecret` records the same gap.',
}

/**
 * THE OUTPUT IS THE SECRET, TWICE OVER — and the second one is the trap.
 *
 * `code` is the bearer credential, and `telegramUrl` is
 * `https://t.me/<bot>?start=<code>` with the code embedded VERBATIM. Redacting
 * one and not the other would be theatre — exactly the finding
 * `machines.pairingCode` recorded about `joinCommand`, which is the same shape
 * (a convenience string that inlines the credential). Both are named.
 *
 * `setupId` is NOT redacted: it is a server-minted handle to the pending
 * ceremony and confers nothing on its own — presenting it to Telegram does not
 * bind anything, because the bot matches on the CODE. `botUsername` is public by
 * definition; it is how anyone finds the bot.
 */
const TELEGRAM_MINT_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: ['code', 'telegramUrl'],
  note:
    'THE OUTPUT IS THE SECRET, and `telegramUrl` embeds it verbatim (`t.me/<bot>?start=<code>`), so ' +
    'both are named — `machines.pairingCode`’s `joinCommand` lesson, which is the identical shape. ' +
    'Never logged, never echoed into an event, never persisted client-side, never included in an ' +
    'error. `setupId` is a server-minted handle that binds nothing by itself (the bot matches the ' +
    'CODE, not the handle) and `botUsername` is public — redacting either would hide the only fields ' +
    'that make the flow usable while protecting nothing. The INPUT is empty and carries no material.',
}

export const settingsTelegramSetupStartContract = {
  name: 'settings.telegramSetupStart',
  version: 1,
  visibility: 'secret',
  input: settingsTelegramSetupStartInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'secret',
    confirmation: 'confirm',
    rationale:
      'Mints a bearer credential that lets whoever presents it bind a chat that SPEAKS AS THE MINTER. ' +
      '`resource: "secret"` because what it writes is a preimage (ADR 9 D3’s `secrets` class names ' +
      'pairing token preimages; this is that row’s sibling), which forces `online-sensitive` through ' +
      '`classificationErrors`. `action: "manage"` and not `write`: it administers an authentication ' +
      'path, it does not edit a row the caller owns. No `machineVerb` — there is no compute here. ' +
      'RECORDED FORK on the floor, and it is the same fork `machines.pairingCode` recorded and ' +
      'resolved the same way. D22 reads as SELF-SERVICE (each person binds their own chat, and the ' +
      'binding this mint leads to is owned by the minter, so a member could not escalate through it) ' +
      '— that argues `member`. ADR 3 Amendment 1 D15.3 is unconditional in the other direction: "any ' +
      'contract whose policy names the `secret` resource kind requires the `admin` instance role". ' +
      'The ADR is the pack’s tie-break and admin is the default-closed side, so admin it is; on ' +
      'today’s one-account instance the two answers coincide, and whoever relaxes this when per-user ' +
      'login lands must say why in the same place. `confirmation: "confirm"`: minting a credential ' +
      'that can impersonate you must not happen by a stray click — `machines.pairingCode` again. ' +
      'NOTHING ENFORCES EITHER THE FLOOR OR THE CONFIRMATION TODAY; the shipped button calls this ' +
      'directly, and POD-315 owns the principal that would make the floor mean something.',
  },
  exposure: SERVED_ON,
  delivery: TELEGRAM_MINT_DELIVERY,
  redaction: TELEGRAM_MINT_REDACTION,
  ownership: {
    creates: [],
    note:
      'Deliberately EMPTY, and for `machines.pairingCode`’s exact reason: what this mints is ' +
      'credential material, and ADR 1 gives a secret row `owner: { kind: "none", reason: "secret" }`. ' +
      'The row that DOES get an owner is the binding — and it is created by the REDEEM, which is why ' +
      '`settings.telegramSetupPoll` carries the non-empty `creates` and this does not. That split is ' +
      'the whole ceremony: the mint carries the user opaquely, the redeem is what mints the owned row.',
  },
  attribution: SETTINGS_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: false,
    note:
      'Takes NO input at all, so there is no id, address or vocabulary member an error could ' +
      'disclose the existence of. The one refusal it can produce — "no bot token is configured" — ' +
      'discloses the instance’s own configuration to a principal already authenticated on it, which ' +
      'is the presence bit the settings surface publishes anyway.',
  },
  cli: { summary: 'Mint a Telegram claim code bound to the calling principal' },
} as const satisfies CommandContract<typeof settingsTelegramSetupStartInput>

/** The redeem is addressed by the handle the mint returned, never by a user or a
 *  chat: both of those are read from state the caller did not supply. */
export const settingsTelegramSetupPollInput = z.object({ setupId: z.string().min(1) })

export const settingsTelegramSetupPollContract = {
  name: 'settings.telegramSetupPoll',
  version: 1,
  visibility: 'per-user-state',
  input: settingsTelegramSetupPollInput,
  policy: {
    action: 'write',
    roleFloor: 'admin',
    resource: 'settings-domain',
    confirmation: 'none',
    rationale:
      'Writes the durable `(userId, chatId)` binding — ADR 1’s `telegram-chat-binding` row, ' +
      '`perUserState`, whose owner resolves to the user in the key. `resource: "settings-domain"` ' +
      'names that row gate, following `settings.updatePersonal`: not `secret` (the secret is the ' +
      'mint, and it is CONSUMED here rather than written), not `global` (a binding is nobody else’s), ' +
      'not `none` (there IS a target class). `action: "write"` because it materialises the caller’s ' +
      'own row rather than administering the instance. THE FLOOR IS `admin` TO MATCH THE MINT, and ' +
      'that is a rule rather than a copy: the two halves of one ceremony must not carry different ' +
      'floors, because the LOWER of the two is then the ceremony’s real floor and the higher one is ' +
      'decoration. `confirmation: "none"`: the deliberate act was the mint, and re-confirming the ' +
      'completion of a ceremony the principal started is friction on the path that ENDS the window — ' +
      'a code that stays live because its redemption was awkward is the worse outcome.',
  },
  exposure: SERVED_ON,
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'ADR 1’s `telegram-chat-binding` row is `offline: "online-only"` and the addressing is why: ' +
      'this call LONG-POLLS a third-party API for an update that is consumed when it arrives, and it ' +
      'redeems a mint that lives for minutes. A queued redemption would drain against an expired ' +
      'mint at best and against a REUSED `setupId` at worst. Nothing names `outbox`, and per ADR 3 ' +
      'D3 rule 2 it could not.',
    applyTimeReauthorization:
      'THE HALF THAT MATTERS, and it is not the caller’s rights — it is the MINTER’s. The binding ' +
      'names `mint.userId`, so this resolves that user LIVE at redemption (ADR 3 D8 / Amendment 1 ' +
      'D16): a principal disabled between mint and redeem must not acquire a chat that speaks as ' +
      'them, and a mint is not a frozen capability. The caller’s own floor is re-checked here too, ' +
      'never read from a capability minted at enqueue — there is no enqueue.',
  },
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: ['settings.notifications.telegramBotToken'],
    note:
      'The INPUT carries no material: `setupId` is a server-minted handle, and note what is NOT here ' +
      '— THE CODE NEVER TRAVERSES THIS API. The claimant types it into Telegram; the server matches ' +
      'it out of `getUpdates`. That is what makes the code an out-of-band factor rather than a ' +
      'second field on the same authenticated channel. The OUTPUT is where the finding is: this ' +
      'procedure returns the whole `PodiumSettings` blob on success, which carries ' +
      '`notifications.telegramBotToken` — a `secret-value` leaf. It is named here rather than fixed ' +
      'here because the blob-returns-secrets surface is `settings.get`’s too and POD-419 owns the ' +
      'scrub for both; a one-command fix would leave the larger hole open and make it look closed. ' +
      '`chatId`, `chatType` and `chatLabel` are routing/display facts the matrix carries as ' +
      '`secret: "preference"` (ADR 9 D8 S4) and are returned to the principal that just bound them.',
  },
  ownership: {
    creates: ['telegram-chat-binding'],
    owner: 'on-behalf-of-human',
    visibility: 'per-user-state',
    inheritanceOnCreate: 'parent',
    note:
      'READ `inheritanceOnCreate: "parent"` CAREFULLY — IT IS THE SECURITY PROPERTY, NOT BOOKKEEPING. ' +
      'The parent is THE MINT, and the on-behalf-of human the binding records is the mint’s, resolved ' +
      'from stored state, NOT the human behind this redeeming call. POD-1079 established the shape ' +
      'for machine pairing ("ownership flows from the PAIRER, stamped at mint from the transport ' +
      'principal and carried opaquely to redeem") and the reason is sharper here: if the owner were ' +
      'the redeemer, anyone who obtained a `setupId` could complete someone else’s ceremony and take ' +
      'the chat. `redeemTelegramClaimCode(mint, chatId, now)` enforces it by having NO user ' +
      'parameter — the value cannot be supplied at redemption because there is nowhere to put it. ' +
      '`visibility: "per-user-state"` matches the matrix row; a binding is non-grantable by ' +
      'construction (ADR 9 D3 rule 4 — there is no "share my Telegram account" verb), so there are ' +
      'no grants to inherit either way.',
  },
  attribution: SETTINGS_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      '`setupId` IS a caller-supplied target id — the one command in this family that takes one, ' +
      'which is why this cell is not `CLOSED_VOCABULARY_ERRORS`. D20.2 applies and M5’s placement ' +
      'carve-out does not (no machine is named). An unknown id, an expired window and another ' +
      'principal’s pending ceremony must all fail as the same `expired` result the shipped surface ' +
      'already returns — otherwise the difference between "no such ceremony" and "someone else’s ' +
      'ceremony is open" is a probe for whether an admin is mid-binding.',
  },
  cli: { summary: 'Redeem a pending Telegram claim code and bind the chat' },
} as const satisfies CommandContract<typeof settingsTelegramSetupPollInput>

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
 * `settings.telegramSetupStart` / `telegramSetupPoll` ARE NOW HERE, and POD-420's
 * note deferring them is answered rather than deleted. It read: *"Modelling a
 * ceremony as a command contract is its own design question, and ADR 9 D8's note
 * that the inbound Telegram edge becomes an AUTHENTICATION surface under
 * multi-user says that question is bigger than this issue."* POD-1080 is that
 * issue. The answer: a mint and a redemption are two commands on two matrix
 * rows, and the pair being hard to classify was never a property of ceremonies —
 * it was the absence of a decision about what this one is FOR. They keep their
 * shipped wire keys deliberately, so the audit's exception list SHRINKS instead
 * of growing a second spelling beside it.
 */
export const SETTINGS_CONTRACTS = {
  'settings.updatePersonal': settingsUpdatePersonalContract,
  'settings.updateInstance': settingsUpdateInstanceContract,
  'settings.setSecret': settingsSetSecretContract,
  'settings.clearSecret': settingsClearSecretContract,
  'settings.secretPresence': settingsSecretPresenceContract,
  'settings.telegramSetupStart': settingsTelegramSetupStartContract,
  'settings.telegramSetupPoll': settingsTelegramSetupPollContract,
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
export const CONTRACT_TIER: Readonly<Partial<Record<SettingsContractName, SettingsTier>>> = {
  'settings.updatePersonal': 'personal-preference',
  'settings.updateInstance': 'instance-preference',
  'settings.setSecret': 'server-secret',
  'settings.clearSecret': 'server-secret',
  // The READ answers for the same tier it reads — the `server-secrets` row —
  // so it is checked against the SHIPPED row like the two writes, rather than
  // being exempted for being a read.
  'settings.secretPresence': 'server-secret',
  // `telegramSetupStart` / `telegramSetupPoll` are deliberately ABSENT and the
  // type is `Partial` to say so. They are not blob writes and answer to no
  // settings TIER: the mint's row is the shared preimage row and the redeem's is
  // the binding's. {@link CEREMONY_ROW} names both, and `contractMatrixRow`
  // resolves either kind — so the ceremony arms are still checked against a
  // SHIPPED row rather than exempted from the check.
}

/**
 * The ceremony arms' matrix rows, by id — the other half of
 * {@link contractMatrixRow}'s lookup.
 *
 * `pairing-token` is the mint's row and it is a REUSE, not an approximation: the
 * row is every server-minted bearer preimage (`machines.token_hash`,
 * `client_sessions.token_hash`, and now the claim code), and all five of its
 * security cells — `secret-value`, `replication: 'none'`, `never-enqueue`,
 * `owner: none/secret`, `visibility: 'secret'` — are already the right answers
 * for a Telegram claim code. A separate row would be a second place to keep them
 * in sync, which is how two answers to one question start.
 */
const CEREMONY_ROW = {
  'settings.telegramSetupStart': 'pairing-token',
  'settings.telegramSetupPoll': 'telegram-chat-binding',
} as const satisfies Partial<Record<SettingsContractName, string>>

/**
 * The shipped matrix row a contract's classification is read off.
 *
 * THROWS on a name it cannot resolve, rather than returning a default row. A
 * default would make the per-contract assertions in `contracts.test.ts` pass
 * against whatever row it defaulted to — the "instrument that finds nothing
 * passes everything" shape this run has hit twice in zod alone.
 */
export function contractMatrixRow(name: SettingsContractName): ReturnType<typeof settingsTierRow> {
  const tier = CONTRACT_TIER[name]
  if (tier) return settingsTierRow(tier)
  const rowId = (CEREMONY_ROW as Partial<Record<SettingsContractName, string>>)[name]
  const row = rowId ? OWNERSHIP_MATRIX_INDEX.get(rowId) : undefined
  if (!row) {
    throw new Error(
      `settings contract '${name}' names no settings tier and no matrix row — classify it before shipping it`,
    )
  }
  return row
}

/** Every classified path this family can write, across both preference tiers.
 *  Derived, so it grows with the model and never with a hand list. */
export const WRITABLE_PREFERENCE_PATHS: readonly string[] = SETTINGS_CLASSIFICATION.filter(
  (c) => c.tier !== 'server-secret',
).map((c) => c.path)

/** The five secret keys, re-exported at the command layer so a consumer of the
 *  family does not have to reach past it into the model for the vocabulary. */
export const SECRET_COMMAND_KEYS = SERVER_SECRET_KEYS
