/**
 * THE TOTALITY GATE for the settings split (POD-418).
 *
 * Every instrument here is written against one question: **what does its
 * REFUSING arm depend on, and can this environment produce it?** A derivation
 * that finds nothing passes everything (POD-363), and set equality between two
 * broken walkers is the most convincing green there is — so each walk is pinned
 * by a cardinality a broken walk cannot reach, by NAMED members including one
 * nested two levels deep, and by a planted fixture that the instrument must
 * NAME and must stop naming when it is removed.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OWNERSHIP_MATRIX_INDEX, ROW } from '../annotations/matrix'
import {
  classifySettingsPath,
  SETTINGS_CLASSIFICATION,
  SETTINGS_CLASSIFICATION_INDEX,
  SETTINGS_OPEN_RECORD_LEAVES,
  SETTINGS_TIER_ROW,
  SETTINGS_TIERS,
  type SettingsTier,
  settingsLeafPaths,
  settingsPathMayEnqueue,
  settingsPathMayReplicate,
  settingsPathsInTier,
  settingsTierRow,
} from './classification'
import { InstancePreferences, PersonalPreferences, Sidebar } from './preferences'
import { LEGACY_IN_BLOB_SECRET_GROUPS, SERVER_SECRET_KEYS } from './secrets'

// ---------------------------------------------------------------------------
// The walker, before anything is believed about what it found
// ---------------------------------------------------------------------------

describe('settingsLeafPaths — the instrument, probed first', () => {
  it('finds a leaf nested TWO levels deep, not just the top layer', () => {
    // The POD-363 shape: a peel loop that stops early reports [] and every
    // downstream claim passes unchanged. `roles.coding.model` is three segments
    // and behind a `.default()` wrapper at two of them, so a walker that fails
    // to unwrap `ZodDefault` cannot produce it.
    expect(settingsLeafPaths(PersonalPreferences, '', ['userId'])).toContain('roles.coding.model')
  })

  it('unwraps `.default()`, `.optional()` and `.nullable()` to reach the object inside', () => {
    const wrapped = z.object({
      a: z.object({ b: z.string() }).default({ b: '' }),
      c: z.object({ d: z.string() }).optional(),
      e: z.object({ f: z.string() }).nullable(),
    })
    expect(settingsLeafPaths(wrapped).sort()).toEqual(['a.b', 'c.d', 'e.f'])
  })

  it('stops at a branded scalar rather than sailing past the brand', () => {
    // POD-363 exactly: `ZodBranded` exposes `.unwrap()` too, so a peel that
    // treats every unwrappable node as a wrapper walks THROUGH the brand. Here
    // that would be harmless for the path, but the same over-peel on an object
    // would flatten a group into its parent, so the behaviour is pinned.
    expect(settingsLeafPaths(PersonalPreferences, '', ['userId'])).toContain(
      'roles.coding.accountId',
    )
  })

  it('treats a record and an array as LEAVES, not as objects to descend into', () => {
    // `experimental` is an open record of feature ids: its members are data, and
    // a walker that tried to enumerate them would report nothing (an empty
    // record has no keys) — which reads as "no leaves here" and would silently
    // drop the flag surface from the classification altogether.
    expect(settingsLeafPaths(InstancePreferences)).toContain('experimental')
    expect(settingsLeafPaths(PersonalPreferences, '', ['userId'])).toContain('sidebar.repoOrder')
    expect([...SETTINGS_OPEN_RECORD_LEAVES]).toEqual(['experimental'])
  })

  it('DROPS the row key and nothing else — `userId` is not a preference', () => {
    const withKey = settingsLeafPaths(PersonalPreferences)
    const withoutKey = settingsLeafPaths(PersonalPreferences, '', ['userId'])
    expect(withKey).toContain('userId')
    expect(withoutKey).not.toContain('userId')
    expect(withoutKey.length).toBe(withKey.length - 1)
  })

  it('NAMES a planted leaf, and stops naming it when it is removed', () => {
    // The can-say-NO probe for the walker itself. Both arms are asserted: an
    // instrument that reported the planted leaf unconditionally would pass the
    // first arm alone.
    const planted = PersonalPreferences.extend({
      sidebar: Sidebar.extend({ plantedLeaf: z.string() }),
    })
    expect(settingsLeafPaths(planted, '', ['userId'])).toContain('sidebar.plantedLeaf')
    expect(settingsLeafPaths(PersonalPreferences, '', ['userId'])).not.toContain(
      'sidebar.plantedLeaf',
    )
  })
})

// ---------------------------------------------------------------------------
// Totality
// ---------------------------------------------------------------------------

describe('the classification is TOTAL over the split shapes', () => {
  it('classifies every leaf of every tier, and the count is non-trivial', () => {
    // A cardinality a broken walk cannot reach. 43 = 24 personal + 14 instance
    // + 5 secret; the three parts are pinned separately below so a failure names
    // which half moved rather than only that the total did. Instance went 13 →
    // 14 with `hibernation.idleShellHours` (POD-565).
    expect(SETTINGS_CLASSIFICATION.length).toBe(43)
    expect(settingsPathsInTier('personal-preference').length).toBe(24)
    expect(settingsPathsInTier('instance-preference').length).toBe(14)
    expect(settingsPathsInTier('server-secret').length).toBe(5)
  })

  it('has no duplicate path — the index cannot silently collapse two leaves', () => {
    expect(SETTINGS_CLASSIFICATION_INDEX.size).toBe(SETTINGS_CLASSIFICATION.length)
  })

  it('names known members of each tier explicitly', () => {
    // Named members, not just a count: a walk that produced 39 wrong paths would
    // satisfy the cardinality pin perfectly.
    expect(classifySettingsPath('sidebar.repoSort')?.tier).toBe('personal-preference')
    expect(classifySettingsPath('notifications.telegramChatId')?.tier).toBe('personal-preference')
    expect(classifySettingsPath('roles.superagent.accountId')?.tier).toBe('personal-preference')
    expect(classifySettingsPath('gitWorkflow.mergeStyle')?.tier).toBe('instance-preference')
    expect(classifySettingsPath('experimental')?.tier).toBe('instance-preference')
    expect(classifySettingsPath('hibernation.memoryPct')?.tier).toBe('instance-preference')
    expect(classifySettingsPath('apiKeys.anthropic')?.tier).toBe('server-secret')
    expect(classifySettingsPath('notifications.telegramBotToken')?.tier).toBe('server-secret')
  })

  it('splits the ONE nested `notifications` object across two tiers', () => {
    // The seam that makes the whole issue necessary: three routing members and
    // one secret, in one legacy object, on two matrix rows.
    const notif = SETTINGS_CLASSIFICATION.filter((c) => c.path.startsWith('notifications.'))
    expect(notif.map((c) => `${c.path}=${c.tier}`).sort()).toEqual([
      'notifications.ntfyTopic=personal-preference',
      'notifications.telegramBotToken=server-secret',
      'notifications.telegramChatId=personal-preference',
      'notifications.web=personal-preference',
    ])
  })

  it('derives the secret paths structurally AND matches the closed vocabulary', () => {
    // Two instruments over one fact (POD-418): the derived set comes from
    // walking the legacy groups, the vocabulary is the hand-declared closed
    // list, and they must agree. A group that grows a member without the
    // vocabulary growing fails here rather than shipping an unclassified secret.
    const derived = LEGACY_IN_BLOB_SECRET_GROUPS.flatMap((g) =>
      settingsLeafPaths(g.schema, g.prefix),
    )
    expect(derived.sort()).toEqual([...SERVER_SECRET_KEYS].sort())
    expect(settingsPathsInTier('server-secret').sort()).toEqual([...SERVER_SECRET_KEYS].sort())
  })
})

// ---------------------------------------------------------------------------
// DECLARATION is a separate obligation from CLASSIFICATION
// ---------------------------------------------------------------------------

describe('every tier names a row that EXISTS (POD-385 / POD-731)', () => {
  it('resolves each tier to a real shipped matrix row', () => {
    // The hole POD-385 found: a class with no matrix row at all still resolved
    // `personal` from the D4 backstop, so "never classified" and "deliberately
    // personal" read identically. Here the row lookup is a separate obligation
    // and it is asserted directly against the SHIPPED index.
    for (const tier of SETTINGS_TIERS) {
      expect(OWNERSHIP_MATRIX_INDEX.has(SETTINGS_TIER_ROW[tier]), tier).toBe(true)
      expect(settingsTierRow(tier).id).toBe(SETTINGS_TIER_ROW[tier])
    }
  })

  it('THROWS on a tier whose row id does not exist — the mistyped-id case', () => {
    // POD-731's finding: a mistyped row id also resolves `personal` and passes.
    // `settingsTierRow` refuses instead of defaulting, and this proves the
    // refusing arm is reachable — the fixture tier is not in the matrix and
    // never can be.
    expect(() => settingsTierRow('not-a-tier' as SettingsTier)).toThrow(/does not exist/)
  })

  it('binds to the shipped rows rather than restating their columns', () => {
    // POD-305's shape: assert against the shared INSTANCE, per member. If the
    // matrix weakened the secret row — replication away from 'none', offline
    // away from 'never-enqueue' — these answers change and this test says so.
    const secretRow = settingsTierRow('server-secret')
    expect(secretRow.id).toBe(ROW.serverSecrets)
    expect(secretRow.visibility).toBe('secret')
    expect(secretRow.secret).toBe('secret-value')
    expect(secretRow.replication).toBe('none')
    expect(secretRow.offline).toBe('never-enqueue')

    const personalRow = settingsTierRow('personal-preference')
    expect(personalRow.id).toBe(ROW.preferencesPersonal)
    expect(personalRow.visibility).toBe('per-user-state')
    expect(personalRow.secret).toBe('preference')

    const instanceRow = settingsTierRow('instance-preference')
    expect(instanceRow.id).toBe(ROW.preferencesInstance)
    expect(instanceRow.visibility).toBe('deployment-substrate')
    expect(instanceRow.secret).toBe('preference')
    expect(instanceRow.offline).toBe('offline-eligible')
  })

  it('reads replication and enqueue off the row, not off a literal', () => {
    for (const c of SETTINGS_CLASSIFICATION) {
      const row = settingsTierRow(c.tier)
      expect(c.replicates).toBe(row.replication !== 'none')
      expect(c.visibility).toBe(row.visibility)
      expect(c.secret).toBe(row.secret)
    }
  })
})

// ---------------------------------------------------------------------------
// The backstop, and the distinction it must NOT collapse
// ---------------------------------------------------------------------------

describe('unknown paths: honest lookup, closed answer', () => {
  it('returns `undefined` for an unclassified path rather than a default tier', () => {
    // The whole point. A default here would make "nobody classified this" and
    // "this is deliberately personal" the same value — the failure that let an
    // entire entity class go unclassified with every gate green.
    expect(classifySettingsPath('someLaterFeature.enabled')).toBeUndefined()
    expect(classifySettingsPath('')).toBeUndefined()
  })

  it('FAILS CLOSED on replication and enqueue for a path it has never heard of', () => {
    expect(settingsPathMayReplicate('someLaterFeature.apiKey')).toBe(false)
    expect(settingsPathMayEnqueue('someLaterFeature.apiKey')).toBe(false)
  })

  it('says YES for a known preference — the backstop is not refusing everything', () => {
    // The other half of "prove it can say YES": a gate that answered `false`
    // unconditionally would pass every refusal assertion above and be useless.
    expect(settingsPathMayReplicate('sidebar.repoSort')).toBe(true)
    expect(settingsPathMayEnqueue('sidebar.repoSort')).toBe(true)
    expect(settingsPathMayReplicate('gitWorkflow.mergeStyle')).toBe(true)
  })

  it('refuses replication and enqueue for EVERY server secret, and for no preference', () => {
    for (const path of SERVER_SECRET_KEYS) {
      expect(settingsPathMayReplicate(path), path).toBe(false)
      expect(settingsPathMayEnqueue(path), path).toBe(false)
    }
    for (const c of SETTINGS_CLASSIFICATION) {
      if (c.tier === 'server-secret') continue
      expect(c.replicates, c.path).toBe(true)
      expect(c.mayEnqueue, c.path).toBe(true)
    }
  })
})
