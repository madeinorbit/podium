/**
 * NO WIRE PROJECTION CARRIES SECRET MATERIAL (POD-418 AC3).
 *
 * Three instruments of different KINDS, because one of a kind is a claim:
 *
 *   1. STRUCTURAL — the presence shape has no member of the value shape. This is
 *      the property that makes the guarantee hold for fields that do not exist
 *      yet: there is no key to forget to strip.
 *   2. NAME DETECTOR — no secret-shaped key on any projection, at any depth. This
 *      catches material re-added under a name the structural check does not know
 *      to look for.
 *   3. CLASSIFICATION — every secret path answers "must not replicate", and
 *      every preference path answers "may". Ties the shapes to the matrix rather
 *      than to this file's opinion.
 *
 * Each has a planted-leak case that must FAIL the check. A detector with no
 * positive case is indistinguishable from a detector looking at a shape too
 * small to violate it (POD-1075's `user.test.ts` is the precedent).
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  SETTINGS_CLASSIFICATION,
  settingsLeafPaths,
  settingsPathMayEnqueue,
  settingsPathMayReplicate,
} from './classification'
import { InstancePreferences, PersonalPreferences } from './preferences'
import {
  ApiKeySecrets,
  IntegrationSecrets,
  NOT_A_SETTINGS_SECRET,
  NotificationSecrets,
  SECRET_FINGERPRINT_CONTRACT,
  SecretPresenceListWire,
  SecretPresenceWire,
  SERVER_SECRET_KEYS,
  ServerSecret,
  ServerSecretKey,
} from './secrets'

/**
 * Matches a PATH that names credential material. Extends `user.test.ts`'s
 * account-wire pattern with `apikey`, and is matched against the FULL dotted
 * path rather than the leaf name — two corrections the first draft of this file
 * needed, and both are the "detector covers one syntax form" shape:
 *
 *   - matching the LEAF missed `apiKeys.anthropic`, `apiKeys.openai` and
 *     `apiKeys.openrouter`, whose leaves are provider names and whose
 *     secretness lives entirely in the PARENT. A detector blind to three of the
 *     five real secrets would have reported a clean wire either way.
 *   - a bare `\bkey$` alternative fired on `SecretPresenceWire.key`, which is a
 *     path NAME, not material. An over-matching detector is not a safe one: it
 *     forces the next reader to add exclusions, and an exclusion list is where a
 *     real leak eventually hides.
 */
const SECRET_SHAPED = /password|credential|hash|secret|token|salt|apikey/i

/** Every wire / read projection this issue introduces. Enumerated so a new one
 *  added without being checked is a visible omission in THIS list, not an
 *  invisible one in the diff.
 *
 *  `SecretPresenceWire` is listed even though `SecretPresenceListWire` embeds
 *  it: the walker stops at an array rather than descending into its element, so
 *  an element shape checked only through its container would not be checked at
 *  all. */
const WIRE_PROJECTIONS: readonly { readonly name: string; readonly schema: z.ZodTypeAny }[] = [
  { name: 'SecretPresenceWire', schema: SecretPresenceWire },
  { name: 'SecretPresenceListWire', schema: SecretPresenceListWire },
  { name: 'PersonalPreferences', schema: PersonalPreferences },
  { name: 'InstancePreferences', schema: InstancePreferences },
]

describe('the presence projection is built INDEPENDENTLY of the stored secret', () => {
  it('has no member of the stored secret except the join key', () => {
    // The structural half. `ServerSecret.value` is the only member of the model
    // that holds material, and the presence shape does not have it — not because
    // it was omitted, but because it was never composed from the shape that has
    // it. An `omit()` would put a new material-bearing member on the wire by
    // default and the diff would show only the new field.
    for (const key of Object.keys(ServerSecret.shape)) {
      if (key === 'key') continue // the join, legitimately on both
      if (key === 'updatedAt') continue // a rotation timestamp is not material
      expect(Object.keys(SecretPresenceWire.shape)).not.toContain(key)
    }
    expect(Object.keys(SecretPresenceWire.shape)).not.toContain('value')
  })

  it('exposes exactly presence, fingerprint and rotation time', () => {
    expect(Object.keys(SecretPresenceWire.shape).sort()).toEqual([
      'fingerprint',
      'key',
      'present',
      'updatedAt',
    ])
  })

  it('REJECTS a payload carrying the material, rather than stripping it silently', () => {
    // The refusing arm, and what it depends on: zod's default is to STRIP unknown
    // keys and SUCCEED (POD-640's trap), so `safeParse().success` proves nothing
    // about shape. Keyed on the parsed OUTPUT instead.
    const parsed = SecretPresenceWire.parse({
      key: 'apiKeys.anthropic',
      present: true,
      fingerprint: 'ab12',
      updatedAt: '2026-07-30T00:00:00.000Z',
      value: 'sk-ant-leaked',
    })
    expect(Object.keys(parsed)).not.toContain('value')
    expect(JSON.stringify(parsed)).not.toContain('sk-ant-leaked')
  })

  it('makes `fingerprint` and `updatedAt` nullable but never ABSENT', () => {
    // `null` is a representable "configured, no fingerprint"; an absent key would
    // be indistinguishable from "nobody threaded the value" (the
    // `UserCredential.passwordHash` rule).
    const missing = SecretPresenceWire.safeParse({ key: 'apiKeys.openai', present: false })
    expect(missing.success).toBe(false)
    const explicit = SecretPresenceWire.safeParse({
      key: 'apiKeys.openai',
      present: false,
      fingerprint: null,
      updatedAt: null,
    })
    expect(explicit.success).toBe(true)
  })

  it('refuses an empty stored secret — absence is a missing ROW, not `""`', () => {
    // Without this, `present: true` could be derived from a row holding '' and
    // the presence bit would mean nothing.
    expect(
      ServerSecret.safeParse({ key: 'apiKeys.openai', value: '', updatedAt: 'now' }).success,
    ).toBe(false)
    expect(
      ServerSecret.safeParse({ key: 'apiKeys.openai', value: 'sk-x', updatedAt: 'now' }).success,
    ).toBe(true)
  })

  it('records the fingerprint contract, and it forbids a bare digest', () => {
    // The constraint is load-bearing: an unsalted digest of a short structured
    // credential is brute-forceable, which would make the "safe" field a slower
    // spelling of the secret. Pinned as text so deleting the reasoning is a
    // visible edit rather than a silent one.
    expect(SECRET_FINGERPRINT_CONTRACT).toMatch(/HMAC/)
    expect(SECRET_FINGERPRINT_CONTRACT).toMatch(/never a bare digest/)
  })
})

describe('the key-name detector over every projection', () => {
  it('finds no secret-shaped key at any depth on any wire projection', () => {
    for (const { name, schema } of WIRE_PROJECTIONS) {
      for (const path of settingsLeafPaths(schema)) {
        expect(path, `${name}.${path}`).not.toMatch(SECRET_SHAPED)
      }
    }
  })

  it('DETECTS material smuggled onto the presence wire — proving it can say NO', () => {
    // Two plants: one under the obvious name, one under a name the structural
    // check would never look for. Both must be NAMED, and the assertion is on
    // the exact hit list so an over-matching detector fails too.
    const leaky = SecretPresenceWire.extend({
      apiKey: z.string(),
      recoveryToken: z.string(),
    })
    const hits = settingsLeafPaths(leaky).filter((p) => SECRET_SHAPED.test(p))
    expect(hits.sort()).toEqual(['apiKey', 'recoveryToken'])
  })

  it('does NOT over-match: `key`, `present` and `telegramChatId` are not material', () => {
    // The other half of POD-640's rule. A detector that fired on everything would
    // score green above and prove nothing — `key` (a path name), `present` (a
    // boolean) and the routing chat id must all pass. `key` is the one that
    // actually bit: an earlier `\bkey$` alternative flagged the presence wire's
    // own join column as a leak.
    expect(SECRET_SHAPED.test('key')).toBe(false)
    expect(SECRET_SHAPED.test('present')).toBe(false)
    expect(SECRET_SHAPED.test('notifications.telegramChatId')).toBe(false)
    expect(SECRET_SHAPED.test('notifications.ntfyTopic')).toBe(false)
    expect(SECRET_SHAPED.test('roles.coding.accountId')).toBe(false)
  })

  it('matches on the FULL PATH, so a parent that names the secret is not missed', () => {
    // `apiKeys.anthropic`'s leaf is a provider name. A leaf-only detector calls
    // it clean, and three of the five real secrets go unseen while the check
    // reports green. Both arms asserted.
    expect(SECRET_SHAPED.test('anthropic')).toBe(false)
    expect(SECRET_SHAPED.test('apiKeys.anthropic')).toBe(true)
  })

  it('fires on the LEGACY blob groups — the material that is still there today', () => {
    // Proof the detector is pointed at something real, and an honest record of
    // what POD-419 still has to scrub. If this list ever empties, the scrub
    // landed; if it grows, a new secret arrived in the blob.
    const legacy = [
      ...settingsLeafPaths(ApiKeySecrets, 'apiKeys'),
      ...settingsLeafPaths(IntegrationSecrets, 'integrations'),
      ...settingsLeafPaths(NotificationSecrets, 'notifications'),
    ]
    expect(legacy.filter((p) => SECRET_SHAPED.test(p)).sort()).toEqual([
      'apiKeys.anthropic',
      'apiKeys.openai',
      'apiKeys.openrouter',
      'integrations.linearApiKey',
      'notifications.telegramBotToken',
    ])
  })
})

describe('the vocabulary and its neighbours', () => {
  it('is one closed set — enum and array cannot drift apart', () => {
    expect(ServerSecretKey.options).toEqual([...SERVER_SECRET_KEYS])
    expect(ServerSecretKey.safeParse('apiKeys.anthropic').success).toBe(true)
    expect(ServerSecretKey.safeParse('sidebar.repoSort').success).toBe(false)
  })

  it('classifies every secret key as never-replicated and never-enqueued', () => {
    for (const key of SERVER_SECRET_KEYS) {
      const c = SETTINGS_CLASSIFICATION.find((x) => x.path === key)
      expect(c?.secret, key).toBe('secret-value')
      expect(c?.visibility, key).toBe('secret')
      expect(settingsPathMayReplicate(key), key).toBe(false)
      expect(settingsPathMayEnqueue(key), key).toBe(false)
    }
  })

  it('names the adjacent secret it deliberately does NOT own', () => {
    // Managed account credentials are `secret-value` too, on a DIFFERENT matrix
    // row with an open billing question (O5). Folding them in here would answer
    // O5 by accident, so they are named rather than defaulted.
    expect([...NOT_A_SETTINGS_SECRET]).toEqual(['accounts.credential'])
    for (const path of NOT_A_SETTINGS_SECRET) {
      expect(SERVER_SECRET_KEYS).not.toContain(path)
      // …and the backstop still refuses it, because it is unclassified HERE.
      expect(settingsPathMayReplicate(path)).toBe(false)
    }
  })
})
