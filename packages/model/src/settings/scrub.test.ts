/**
 * THE SCRUB'S OWN INSTRUMENT CHECK (POD-419).
 *
 * The dominant defect of this run is a suite that cannot say NO. For a SCRUB the
 * shape is inverted and worse: a scrub that finds nothing does not fail — it
 * silently succeeds, and every downstream "zero secret material" assertion then
 * passes vacuously against a store still holding the material. POD-363's rule
 * (`an instrument whose job is to FIND things must first be shown to find
 * something`) is therefore the organising principle here:
 *
 *   1. it FINDS — at four depths, each removal named BY ADDRESS, not counted;
 *   2. it does not OVER-find — the preference sibling beside every secret
 *      survives, including `experimental`, which POD-352's drift refresh
 *      whitelists as intentionally-replicated preference data;
 *   3. its input list is DERIVED and non-empty, asserted against the shipped
 *      classification rather than against a copy of it.
 */

import { describe, expect, it } from 'vitest'
import { SETTINGS_CLASSIFICATION, settingsPathsInTier } from './classification'
import { SETTINGS_SECRET_PATHS, findSecretMaterial, scrubSecretMaterial } from './scrub'

describe('the path list is the shipped classification, not a copy of it', () => {
  it('is exactly the server-secret tier', () => {
    expect([...SETTINGS_SECRET_PATHS]).toEqual(settingsPathsInTier('server-secret'))
  })

  it('is non-empty, and every member is classified as never-replicating and never-enqueueing', () => {
    // An empty list would make the scrub a no-op that passes everything. This is
    // the POD-305 "fails first if the matrix imports empty" guard as a test.
    expect(SETTINGS_SECRET_PATHS.length).toBeGreaterThan(0)
    for (const path of SETTINGS_SECRET_PATHS) {
      const row = SETTINGS_CLASSIFICATION.find((c) => c.path === path)
      expect(row?.replicates).toBe(false)
      expect(row?.mayEnqueue).toBe(false)
    }
  })

  it('names no preference path — the scrub may not reach one', () => {
    const preferences = [
      ...settingsPathsInTier('personal-preference'),
      ...settingsPathsInTier('instance-preference'),
    ]
    expect(SETTINGS_SECRET_PATHS.filter((p) => preferences.includes(p))).toEqual([])
  })
})

describe('it FINDS material — at every depth a store can hold it', () => {
  it('removes a secret at the root of a settings blob, and says where', () => {
    const before = {
      apiKeys: { openai: 'sk-root-openai', anthropic: 'sk-root-anthropic' },
      sidebar: { groupByRepo: true },
    }
    const { value, removed } = scrubSecretMaterial(before)

    expect([...removed].sort()).toEqual(['apiKeys.anthropic', 'apiKeys.openai'])
    expect(value).toEqual({ apiKeys: {}, sidebar: { groupByRepo: true } })
    // The key is GONE, not blanked: `''` is the legacy "not configured"
    // spelling, so a blanked key is indistinguishable from one that never held
    // anything — and it leaves an address for a later write to fill.
    expect(Object.hasOwn((value as { apiKeys: object }).apiKeys, 'openai')).toBe(false)
  })

  it('removes a secret nested under an outbox entry’s verbatim input', () => {
    const record = {
      mutationId: 'mut_1',
      command: { name: 'settings.set', version: 1 },
      input: {
        settings: {
          integrations: { linearApiKey: 'lin_api_queued' },
          notifications: { telegramBotToken: 'bot:queued', telegramChatId: '12345' },
        },
      },
    }
    const { value, removed } = scrubSecretMaterial(record)

    expect([...removed].sort()).toEqual([
      'input.settings.integrations.linearApiKey',
      'input.settings.notifications.telegramBotToken',
    ])
    // The ROUTING sibling in the same nested object survives: telegramChatId is
    // per-user routing (readiness §3.1.6 S4), not secret material.
    expect(value.input.settings.notifications).toEqual({ telegramChatId: '12345' })
    expect(value.mutationId).toBe('mut_1')
  })

  it('reaches inside an array — a dead-letter list is not a blind spot', () => {
    const before = { parked: [{ input: { apiKeys: { openrouter: 'or-1' } } }, { input: {} }] }
    const { value, removed } = scrubSecretMaterial(before)

    expect(removed).toEqual(['parked.0.input.apiKeys.openrouter'])
    expect(value.parked[1]).toEqual({ input: {} })
  })

  it('finds every classified secret when they are ALL present, with DISTINCT values', () => {
    // Distinct values on purpose: a fixture whose secrets all share one value
    // (or are all empty) passes whether the scrub removed five members or one.
    const blob: Record<string, unknown> = {}
    for (const [i, path] of SETTINGS_SECRET_PATHS.entries()) {
      const [group, leaf] = path.split('.') as [string, string]
      const node = (blob[group] ??= {}) as Record<string, unknown>
      node[leaf] = `distinct-secret-${i}`
    }
    const { value, removed } = scrubSecretMaterial(blob)

    expect([...removed].sort()).toEqual([...SETTINGS_SECRET_PATHS].sort())
    expect(JSON.stringify(value)).not.toContain('distinct-secret-')
  })
})

describe('it does NOT over-find — the mirror trap of a scrub that eats everything', () => {
  it('leaves a blob with no secret material untouched, BY REFERENCE', () => {
    const before = { sidebar: { repoSort: 'name' }, hibernation: { memoryPct: 80 } }
    const { value, removed } = scrubSecretMaterial(before)

    expect(removed).toEqual([])
    // Same reference: a caller uses this to skip a durable write it does not
    // need to make, so "nothing removed" has to be observable without a diff.
    expect(value).toBe(before)
  })

  it('leaves `experimental` alone — POD-352 whitelists it as replicated preference data', () => {
    const before = { experimental: { 'flag.a': true, apiKeysLike: 'not-a-secret' } }
    expect(findSecretMaterial(before)).toEqual([])
    expect(scrubSecretMaterial(before).value).toBe(before)
  })

  it('leaves a key whose NAME resembles a secret but whose path is not classified', () => {
    // `apiKeys` as a scalar, and a same-named leaf under a different parent:
    // neither resolves a classified path, so neither is touched. A detector
    // keyed on the word "key" would eat both.
    const before = { apiKeys: 'a string, not an object', other: { openai: 'sk-not-classified' } }
    expect(findSecretMaterial(before)).toEqual([])
  })

  it('does not invent a key that was absent', () => {
    const before = { apiKeys: { anthropic: 'sk-a' } }
    const { value } = scrubSecretMaterial(before)
    expect(Object.hasOwn((value as { apiKeys: object }).apiKeys, 'openai')).toBe(false)
    expect((value as { apiKeys: object }).apiKeys).toEqual({})
  })
})

describe('purity — the input is never mutated', () => {
  it('leaves the caller’s object holding its own material', () => {
    const before = { apiKeys: { openai: 'sk-original' } }
    scrubSecretMaterial(before)
    // The stores this runs against read the row again after the scrub decides
    // what to write; a mutating scrub would make "was it written?" unanswerable.
    expect(before.apiKeys.openai).toBe('sk-original')
  })

  it('walks a non-JSON value as an opaque leaf rather than reconstructing it', () => {
    const date = new Date(0)
    const before = { at: date, apiKeys: { openai: 'sk-x' } }
    const { value } = scrubSecretMaterial(before)
    expect(value.at).toBe(date)
  })
})
