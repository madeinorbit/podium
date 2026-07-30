/**
 * SETTINGS — THE SERVER-OWNED SECRET HALF (POD-418, 3.7a).
 *
 * ADR 1's matrix row `server-secrets`, transcribed as shapes:
 *
 * > Server-owned secrets (apiKeys.*, linearApiKey, telegramBotToken, …) | server
 * > | operator online only | **none** for values; wire **secret-presence**
 * > (+ fingerprint) | online replace | clear server-side | **online-only, never
 * > outbox** | **secret-value**
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THIS FILE EXISTS TO MAKE STRUCTURALLY TRUE
 * ---------------------------------------------------------------------------
 *
 * **No wire or read projection can carry secret material, because no wire or
 * read projection has a key to put it in.** {@link SecretPresenceWire} is not
 * {@link ServerSecret} with the value stripped — it is a different shape built
 * from a different field group, so there is no omit-list to forget to grow. That
 * is POD-1075's `UserAccount` / `UserCredential` shape applied to settings, and
 * it is deliberate: the alternative (one record plus `omit()` on the way out) is
 * the shape where a later field lands on the wrong side silently, because adding
 * a key is additive and the omit list is a hand-maintained copy.
 *
 * `secrets.test.ts` proves it from both directions — structurally (the presence
 * shape has no member of the value shape) and with a key-NAME detector that
 * would catch material re-added under a name the structural check does not know
 * to look for — and each instrument has a planted-leak case proving it can say
 * NO.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SECRETS ARE A KEYED STORE AND NOT A NESTED BLOB
 * ---------------------------------------------------------------------------
 *
 * Today they are three nested objects inside `PodiumSettings`
 * ({@link LEGACY_IN_BLOB_SECRET_GROUPS}), interleaved with preferences —
 * `notifications` holds `telegramBotToken` (secret) beside `telegramChatId`
 * (routing, per-user). A blob whose members sit on three matrix rows cannot be
 * replicated, enqueued or authorized as one thing, which is the whole defect
 * POD-419 and POD-420 exist to fix.
 *
 * As a keyed store the three questions have one answer each: replication is
 * `none` for the store, the outbox refuses the store's commands outright (rather
 * than inspecting a payload for secret-shaped keys), and rotation is admin-grade
 * per row. The legacy groups stay declared here — POD-419 owns removing them
 * from the client blob — so that `classification.ts` can be TOTAL over the blob
 * that actually exists rather than over the one we would like.
 *
 * ---------------------------------------------------------------------------
 * NO OWNER, AND NO `machineVerb`
 * ---------------------------------------------------------------------------
 *
 * The matrix leaves `owner` empty with `reason: 'secret'` — *"the material is
 * the INSTANCE's, not personal. Giving secrets an owner would multiply the
 * surface D6 exists to minimise and would imply transfer semantics for
 * credentials."* POD-384 made the same call for `machines.pairingCode` and
 * deliberately left `ownership.creates` EMPTY rather than claiming an owner for
 * a row the matrix says has none. This file claims none either.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// The closed set of secret leaves
// ---------------------------------------------------------------------------

/**
 * EVERY server-owned secret in the settings blob, by the dotted path it occupies
 * there today. A closed `const` array so the zod enum, the type and every
 * totality check derive from ONE list.
 *
 * The paths are the LEGACY blob's, on purpose: POD-419's scrub migration and
 * POD-420's commands both need to name what they are removing and refusing, and
 * a key named `apiKeys.anthropic` is greppable in a way a renamed one is not.
 * Renaming them is a later, separate change with a migration behind it.
 */
export const SERVER_SECRET_KEYS = [
  'apiKeys.openrouter',
  'apiKeys.anthropic',
  'apiKeys.openai',
  'integrations.linearApiKey',
  'notifications.telegramBotToken',
] as const

export const ServerSecretKey = z.enum(SERVER_SECRET_KEYS)
export type ServerSecretKey = (typeof SERVER_SECRET_KEYS)[number]

/** Compile-time pin: the zod enum and the vocabulary are one set (the shape
 *  `USER_ROLES` uses). Widening either without the other stops this from
 *  typechecking. */
const _serverSecretKeyIsOneVocabulary: ServerSecretKey = null as unknown as z.infer<
  typeof ServerSecretKey
>
void _serverSecretKeyIsOneVocabulary

// ---------------------------------------------------------------------------
// R3 — the stored secret. Server-local, never replicated, never enqueued.
// ---------------------------------------------------------------------------

/**
 * A server-owned secret AT REST. Read by the storage layer and by the injection
 * path at spawn; composed by NO wire shape.
 *
 * `value` is the material. It is the only member of this shape that is, and it
 * exists in exactly one type in the model — which is what makes "does anything
 * ship the material" a question a test can answer structurally.
 *
 * `.min(1)`: an empty secret is not a secret, it is an ABSENT one, and the two
 * must not be spellable the same way. Today's blob uses `''` for "not
 * configured" (and `credentialEnv` already refuses to export a blank env var
 * because some CLIs read it as "configured but broken"); in the keyed store,
 * absence is the ROW being absent. A store that accepted `''` would make
 * {@link SecretPresenceWire.present} unable to mean anything.
 */
export const ServerSecret = z.object({
  key: ServerSecretKey,
  value: z.string().min(1),
  /** When it was last replaced. `cmd` conflict: online replace only. */
  updatedAt: z.string(),
})
export type ServerSecret = z.infer<typeof ServerSecret>

// ---------------------------------------------------------------------------
// R4 — what a replica may see: presence + fingerprint, and nothing else
// ---------------------------------------------------------------------------

/**
 * THE FINGERPRINT IS NOT A HASH OF THE SECRET, and this is a real constraint
 * rather than a note.
 *
 * A provider API key is short and highly structured (`sk-ant-…`, `sk-…`), so an
 * unsalted digest of one is brute-forceable offline by anyone holding the
 * projection — which would make the "safe" wire field a slower spelling of the
 * secret itself. The fingerprint a producer puts here MUST be derived under a
 * server-held key that never leaves the server (an HMAC), and truncated.
 *
 * What it is FOR is the only thing it may support: telling two configured
 * secrets apart across a rotation ("did the key change?", "is this the same key
 * the other machine has?"). Nothing about the material may be recoverable from
 * it, and no consumer may compare it against a locally-computed digest — a
 * consumer that could do that would be a consumer holding the material.
 *
 * The model DECLARES the contract and does not implement it: `@podium/model`
 * imports nothing but zod, and a derivation needing a server-held key has no
 * business in an L0 leaf that ships to browsers. POD-420 owns the producer.
 */
export const SECRET_FINGERPRINT_CONTRACT =
  'A truncated HMAC under a server-held key — never a bare digest of the material, which is ' +
  'brute-forceable for a short structured credential. It supports exactly one question: are two ' +
  'configured secrets the same one? Nothing may be recoverable from it, and no consumer may ' +
  'compare it against a locally computed digest.'

/**
 * What a replica is told about a server-owned secret: THAT there is one, and an
 * opaque tag for telling one from another.
 *
 * Deliberately NOT a projection of {@link ServerSecret}. It shares only `key`
 * (the join), and it is built independently precisely so that a field added to
 * the stored secret cannot reach the wire by being additive. If this were
 * `ServerSecret.omit({ value: true })`, a second material-bearing member added
 * later would ship by default and the diff would show only the new field, never
 * the omit-list that failed to grow.
 *
 * `fingerprint` is `.nullable()` rather than `.optional()`, for the reason
 * `UserCredential.passwordHash` is: `null` is a representable "configured, but
 * this producer computes no fingerprint", while an absent key would be
 * indistinguishable from "nobody threaded the value".
 */
export const SecretPresenceWire = z.object({
  key: ServerSecretKey,
  /** Is a secret configured for this key? The `secret-presence` class, exactly. */
  present: z.boolean(),
  /** Opaque. See {@link SECRET_FINGERPRINT_CONTRACT}. `null` when absent or when
   *  the producer computes none. */
  fingerprint: z.string().nullable(),
  /** When it was last replaced — a rotation is visible even though the material
   *  is not. `null` when no secret is configured. */
  updatedAt: z.string().nullable(),
})
export type SecretPresenceWire = z.infer<typeof SecretPresenceWire>

/** The whole secret surface as a replica sees it: one presence row per key,
 *  always all of them, so "absent from the list" is never a third state that a
 *  reader has to distinguish from `present: false`.
 *
 *  The member is `presence` and not `secrets` deliberately. `secrets` is what
 *  this list is ABOUT, not what it contains, and a projection whose own key
 *  claims to hold secrets is a name that will be believed by the next reader —
 *  and by `secrets.test.ts`'s key-name detector, which flagged it. Naming the
 *  container for its contents beats carrying an exclusion for it. */
export const SecretPresenceListWire = z.object({
  presence: z.array(SecretPresenceWire),
})
export type SecretPresenceListWire = z.infer<typeof SecretPresenceListWire>

// ---------------------------------------------------------------------------
// The legacy in-blob groups — declared here so the classification can be TOTAL
// ---------------------------------------------------------------------------

/** Provider API keys as the legacy blob still carries them. Stored plaintext in
 *  the self-hosted SQLite — same trust domain as the shell the agents already
 *  run in — and REMOVED FROM THE CLIENT BLOB by POD-419. */
export const ApiKeySecrets = z.object({
  openrouter: z.string().default(''),
  anthropic: z.string().default(''),
  openai: z.string().default(''),
})
export type ApiKeySecrets = z.infer<typeof ApiKeySecrets>

/** Third-party integration credentials as the legacy blob still carries them. */
export const IntegrationSecrets = z.object({
  linearApiKey: z.string().default(''),
})
export type IntegrationSecrets = z.infer<typeof IntegrationSecrets>

/** The secret half of the legacy `notifications` object. Its sibling members are
 *  ROUTING and live in `./preferences.ts` — one nested object, two matrix rows.
 *  Splitting the declaration here is what lets the composite be assembled from
 *  two classified groups instead of being one unclassifiable object. */
export const NotificationSecrets = z.object({
  /** Telegram bot token for global server push (empty = off). */
  telegramBotToken: z.string().default(''),
})
export type NotificationSecrets = z.infer<typeof NotificationSecrets>

/**
 * The legacy groups, listed with the blob prefix each occupies, so the
 * classification derives the secret paths STRUCTURALLY rather than restating
 * {@link SERVER_SECRET_KEYS} by hand. `secrets.test.ts` asserts the derived set
 * equals the closed vocabulary — two instruments over one fact, so a group that
 * grows a member without the vocabulary growing is a failure rather than a
 * silently unclassified secret.
 */
export const LEGACY_IN_BLOB_SECRET_GROUPS = [
  { prefix: 'apiKeys', schema: ApiKeySecrets },
  { prefix: 'integrations', schema: IntegrationSecrets },
  { prefix: 'notifications', schema: NotificationSecrets },
] as const

/**
 * ADJACENT AND DELIBERATELY NOT RE-HOMED HERE: managed account credentials
 * (`accounts.credential`, matrix row `managed-credentials`).
 *
 * They are `secret-value` at rest and `never-enqueue`, exactly like these — but
 * they are a different matrix row with a different id-minting story (a server
 * account id, not a settings key) and an OPEN question of their own (O5:
 * whether server-injected material should bill the delegating human rather than
 * the machine owner). Folding them into the settings secret store would answer
 * O5 by accident. Named rather than defaulted, per this issue's rule that
 * anything which is neither preference nor settings-secret gets said out loud.
 */
export const NOT_A_SETTINGS_SECRET = ['accounts.credential'] as const
