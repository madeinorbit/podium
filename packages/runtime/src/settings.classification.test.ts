/**
 * THE RECONCILIATION GATE (POD-418).
 *
 * `@podium/model` cannot import this package, so the model's classification is
 * derived from the SPLIT shapes and can never see a field added to the live
 * blob and to no tier. This file is the instrument that can: it compares the
 * leaves of the real {@link PodiumSettings} against the classification IN BOTH
 * DIRECTIONS.
 *
 * ---------------------------------------------------------------------------
 * WHY A BOTH-DIRECTIONS EQUALITY IS NOT ENOUGH ON ITS OWN
 * ---------------------------------------------------------------------------
 *
 * If the blob walk returned `[]` and the classification walk returned `[]`, the
 * equality would pass with maximum confidence and zero content — set equality
 * between two broken walkers is the most convincing green there is (POD-363,
 * POD-640). So the equality is preceded by:
 *
 *   - a CARDINALITY a broken walk cannot reach (39, split 24/10/5);
 *   - NAMED members, including one nested two levels deep and one on each side
 *     of the `notifications` seam;
 *   - a PLANTED leaf, asserted to break the equality and to be named as the
 *     unclassified one — the refusing arm, exercised.
 *
 * The second gate here is COMPOSITION IDENTITY. A restatement is byte-identical
 * on the wire, so no fixture can see it; only object identity can (POD-305).
 * Every member of the blob is asserted `toBe` the model's schema instance, and
 * PER MEMBER rather than on the first one — a sixth group arriving by copy-paste
 * is exactly the case a spot check passes.
 */

import * as model from '@podium/model'
import { SETTINGS_CLASSIFICATION, settingsLeafPaths } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEFAULT_SETTINGS, normalizeSettings, PodiumSettings } from './settings'

const blobLeaves = () => settingsLeafPaths(PodiumSettings)
const classifiedPaths = () => SETTINGS_CLASSIFICATION.map((c) => c.path)

describe('the blob walk, probed before it is believed', () => {
  it('finds a non-trivial number of leaves, nested ones included', () => {
    // 40 + `worktreeGc.mode` / `worktreeGc.afterDays` (POD-564).
    expect(blobLeaves().length).toBe(42)
    expect(blobLeaves()).toContain('roles.coding.model')
    expect(blobLeaves()).toContain('roles.background.accountId')
    expect(blobLeaves()).toContain('notifications.telegramBotToken')
    expect(blobLeaves()).toContain('notifications.telegramChatId')
    expect(blobLeaves()).toContain('experimental')
  })
})

describe('every leaf of the live blob is classified, and vice versa', () => {
  it('the two sets are equal', () => {
    expect(blobLeaves().sort()).toEqual(classifiedPaths().sort())
  })

  it('BREAKS when the blob grows a leaf no tier claims — the refusing arm', () => {
    // The planted fixture. Both arms: the unclassified leaf is NAMED, and the
    // real blob names none. Without this the equality above could be two empty
    // walks agreeing perfectly.
    const planted = PodiumSettings.extend({
      newFeature: z.object({ apiKey: z.string().default('') }).default({}),
    })
    const unclassified = settingsLeafPaths(planted).filter((p) => !classifiedPaths().includes(p))
    expect(unclassified).toEqual(['newFeature.apiKey'])
    expect(blobLeaves().filter((p) => !classifiedPaths().includes(p))).toEqual([])
  })

  it('BREAKS when a tier claims a path the blob does not have', () => {
    // The other direction, which catches a classification left behind by a
    // rename — a stale entry is not visible from the blob side at all.
    const stale = [...classifiedPaths(), 'sidebar.repoSortOrder']
    expect(stale.filter((p) => !blobLeaves().includes(p))).toEqual(['sidebar.repoSortOrder'])
    expect(classifiedPaths().filter((p) => !blobLeaves().includes(p))).toEqual([])
  })
})

describe('the blob COMPOSES the model schemas — no restatement', () => {
  // Per member, and against the model INSTANCE. `toBe`, not `toEqual`: a
  // restated schema is deep-equal and byte-identical on the wire, so only
  // identity sees the fork.
  const shape = PodiumSettings.shape

  const unwrapDefault = (s: z.ZodTypeAny): z.ZodTypeAny =>
    (s as unknown as { removeDefault?: () => z.ZodTypeAny }).removeDefault?.() ?? s

  const COMPOSED: readonly [keyof typeof shape, z.ZodTypeAny][] = [
    ['roles', model.Roles],
    ['apiKeys', model.ApiKeySecrets],
    ['integrations', model.IntegrationSecrets],
    ['hibernation', model.HibernationPolicy],
    ['sidebar', model.Sidebar],
    ['gitWorkflow', model.GitWorkflowPolicy],
    ['issues', model.IssueAssistantPolicy],
    ['steward', model.StewardPolicy],
    ['autoContinue', model.AutoContinuePreferences],
    ['experimental', model.ExperimentalFlags],
    ['worktreeGc', model.WorktreeGcPolicy],
  ]

  it('pins EVERY composable member, not a sample', () => {
    // Membership pin: the day a twelfth group is added, this fails until it is
    // listed. `notifications` is excluded by name below because it is the one
    // member assembled from TWO groups.
    expect(COMPOSED.map(([k]) => k).sort()).toEqual(
      Object.keys(shape)
        .filter((k) => k !== 'notifications')
        .sort(),
    )
  })

  for (const [key, schema] of COMPOSED) {
    it(`\`${key}\` is the model's schema instance`, () => {
      expect(unwrapDefault(shape[key] as z.ZodTypeAny)).toBe(schema)
    })
  }

  it('`notifications` composes both groups member-by-member, keeping key order', () => {
    const notif = unwrapDefault(shape.notifications) as z.AnyZodObject
    // Key ORDER, not just membership: reordering a persisted blob's JSON is an
    // invisible change with a real diff surface.
    expect(Object.keys(notif.shape)).toEqual([
      'web',
      'ntfyTopic',
      'telegramBotToken',
      'telegramChatId',
    ])
    expect(notif.shape.web).toBe(model.NotificationRouting.shape.web)
    expect(notif.shape.ntfyTopic).toBe(model.NotificationRouting.shape.ntfyTopic)
    expect(notif.shape.telegramChatId).toBe(model.NotificationRouting.shape.telegramChatId)
    expect(notif.shape.telegramBotToken).toBe(model.NotificationSecrets.shape.telegramBotToken)
  })

  it('re-exports the model bindings rather than redeclaring them', async () => {
    // Boundary rule 7's direction, asserted at the binding: a NEW declaration
    // under the same name is the bug; a re-export is the fix.
    const runtime = await import('./settings')
    expect(runtime.Roles).toBe(model.Roles)
    expect(runtime.Sidebar).toBe(model.Sidebar)
    expect(runtime.RoleBackend).toBe(model.RoleBackend)
    expect(runtime.CodingRole).toBe(model.CodingRole)
  })
})

describe('the composed blob still parses exactly as before', () => {
  it('produces the same defaults, key for key', () => {
    // The behaviour guard on the move. Defaults are what every consumer reads
    // when a key is absent, so a changed default is a silent behaviour change
    // across the whole product.
    expect(DEFAULT_SETTINGS).toEqual({
      roles: {
        coding: {
          accountId: '',
          model: 'auto',
          effort: 'auto',
          subagentModel: 'auto',
          subagentStrategy: 'builtin',
          startScreen: 'native',
          seedCliTheme: true,
        },
        superagent: { accountId: '', model: 'auto', effort: 'auto' },
        background: { accountId: '', model: 'google/gemini-2.5-flash', effort: 'auto' },
      },
      apiKeys: { openrouter: '', anthropic: '', openai: '' },
      integrations: { linearApiKey: '' },
      hibernation: {
        enabled: true,
        memoryPct: 80,
        loadPerCore: 1.5,
        maxIdleSessions: 8,
        idleMinutes: 30,
      },
      notifications: { web: true, ntfyTopic: '', telegramBotToken: '', telegramChatId: '' },
      sidebar: { repoSort: 'lastUsed', repoOrder: [], groupByRepo: false },
      gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true },
      issues: { assistantEnabled: true },
      steward: { enabled: true },
      autoContinue: { enabled: false, promptDismissed: false },
      experimental: {},
      worktreeGc: { mode: 'propose', afterDays: 14 },
    })
  })

  it('keeps the serialized key order of a round-tripped blob', () => {
    const parsed = normalizeSettings({})
    expect(Object.keys(parsed)).toEqual([
      'roles',
      'apiKeys',
      'integrations',
      'hibernation',
      'notifications',
      'sidebar',
      'gitWorkflow',
      'issues',
      'steward',
      'autoContinue',
      'experimental',
      // Appended, never slotted by topic: this list IS the serialized order of
      // a persisted blob (POD-564).
      'worktreeGc',
    ])
    expect(Object.keys(parsed.notifications)).toEqual([
      'web',
      'ntfyTopic',
      'telegramBotToken',
      'telegramChatId',
    ])
  })

  it('still enforces the bounds that live on the moved schemas', () => {
    // A move that dropped a `.min()`/`.max()` would be invisible to a defaults
    // comparison — every one of these refusals is a value the pre-split schema
    // rejected too.
    expect(() => normalizeSettings({ hibernation: { memoryPct: 20 } })).toThrow()
    expect(() => normalizeSettings({ hibernation: { memoryPct: 99 } })).toThrow()
    expect(() => normalizeSettings({ hibernation: { idleMinutes: 0 } })).toThrow()
    expect(() => normalizeSettings({ hibernation: { loadPerCore: 0.1 } })).toThrow()
    expect(() => normalizeSettings({ hibernation: { loadPerCore: 9 } })).toThrow()
    expect(() => normalizeSettings({ gitWorkflow: { mergeStyle: 'rebase' } })).toThrow()
    expect(() => normalizeSettings({ sidebar: { repoSort: 'random' } })).toThrow()
    // …and the valid neighbours still pass, so the refusals above are not a
    // schema that rejects everything.
    expect(normalizeSettings({ hibernation: { memoryPct: 50 } }).hibernation.memoryPct).toBe(50)
    expect(normalizeSettings({ hibernation: { memoryPct: 95 } }).hibernation.memoryPct).toBe(95)
    expect(normalizeSettings({ hibernation: { loadPerCore: 0.5 } }).hibernation.loadPerCore).toBe(
      0.5,
    )
    expect(normalizeSettings({ hibernation: { loadPerCore: null } }).hibernation.loadPerCore).toBe(
      null,
    )
    expect(normalizeSettings({ gitWorkflow: { mergeStyle: 'pr' } }).gitWorkflow.mergeStyle).toBe(
      'pr',
    )
  })
})
