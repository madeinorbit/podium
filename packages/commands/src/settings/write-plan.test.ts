/**
 * THE PLANNER, AND SPECIFICALLY ITS REFUSING ARM.
 *
 * The acceptance criterion this file exists for is *"an offline attempt of a
 * secret write is refused"*, and the trap the coordinator named is a suite that
 * cannot say NO. So every refusal here is paired with the thing it must NOT
 * refuse:
 *
 *  - offline + secret ⇒ refused …and offline + preference ⇒ ISSUED, or the
 *    refusal is satisfied by an implementation that refuses everything offline;
 *  - online + secret ⇒ ISSUED, or the refusal is satisfied by one that never
 *    issues a secret write at all;
 *  - an unclassified change ⇒ refused …and a classified one ⇒ issued, or the
 *    refusal is satisfied by a planner that classifies nothing.
 *
 * The environmental fact the refusal depends on is a single injected boolean, so
 * the test environment can produce BOTH arms — which is the property the CSWSH
 * guard (POD-391) and the operator-only revocation suite (POD-351) did not have.
 */

import { describe, expect, it } from 'vitest'
import {
  applySettingsPatch,
  changedSettingsLeaves,
  ONLINE_ONLY_SETTINGS_COMMANDS,
  planSettingsWrite,
  readSettingsLeaf,
} from './write-plan'

/** A settings-blob-shaped fixture. Only the members a case touches. */
const base = {
  roles: { coding: { model: 'auto', effort: 'auto' } },
  sidebar: { repoSort: 'lastUsed' },
  gitWorkflow: { mergeStyle: 'ff-only' },
  experimental: { someFlag: true },
  apiKeys: { openai: '', anthropic: 'sk-old' },
  notifications: { telegramChatId: '', telegramBotToken: '' },
}

const edit = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...base, ...patch })

const ONLINE = { online: true }
const OFFLINE = { online: false }

describe('reading and writing one leaf by path', () => {
  it('reads a deep leaf, and answers undefined for an absent one', () => {
    expect(readSettingsLeaf(base, 'roles.coding.model')).toBe('auto')
    expect(readSettingsLeaf(base, 'roles.coding.nothing')).toBeUndefined()
    expect(readSettingsLeaf(base, 'nothing.at.all')).toBeUndefined()
  })

  it('writes a deep leaf without mutating the original', () => {
    const next = applySettingsPatch(base, { 'roles.coding.model': 'opus' })
    expect(readSettingsLeaf(next, 'roles.coding.model')).toBe('opus')
    expect(readSettingsLeaf(base, 'roles.coding.model')).toBe('auto')
    // The untouched siblings survive — a patch is not a replace.
    expect(readSettingsLeaf(next, 'roles.coding.effort')).toBe('auto')
    expect(readSettingsLeaf(next, 'sidebar.repoSort')).toBe('lastUsed')
  })

  it('creates missing intermediates, so a leaf lands on a blob written by an older build', () => {
    expect(readSettingsLeaf(applySettingsPatch({}, { 'a.b.c': 1 }), 'a.b.c')).toBe(1)
  })

  it('round-trips through the differ: applying a patch makes the diff empty', () => {
    const next = applySettingsPatch(base, { 'sidebar.repoSort': 'custom' })
    expect(changedSettingsLeaves(base, next).map((l) => l.path)).toEqual(['sidebar.repoSort'])
    expect(changedSettingsLeaves(next, next)).toEqual([])
  })
})

describe('leaf diffing stops at the classified path', () => {
  it('finds a changed deep leaf, at its own address', () => {
    const leaves = changedSettingsLeaves(
      base,
      edit({ roles: { coding: { model: 'opus', effort: 'auto' } } }),
    )
    expect(leaves).toEqual([
      { path: 'roles.coding.model', value: 'opus', tier: 'personal-preference' },
    ])
  })

  it('treats an OPEN RECORD as one leaf — a new feature id is not an unclassified path', () => {
    const leaves = changedSettingsLeaves(
      base,
      edit({ experimental: { someFlag: true, other: true } }),
    )
    expect(leaves.map((l) => l.path)).toEqual(['experimental'])
    expect(leaves[0]?.tier).toBe('instance-preference')
  })

  it('reports an unclassified change rather than dropping it', () => {
    const leaves = changedSettingsLeaves(base, { ...base, telemetry: { uploadToken: 'x' } })
    expect(leaves).toEqual([{ path: 'telemetry.uploadToken', value: 'x', tier: undefined }])
  })

  it('finds NOTHING when nothing changed — the instrument does not over-report', () => {
    expect(changedSettingsLeaves(base, { ...base })).toEqual([])
  })
})

describe('offline, a secret write is REFUSED — and a preference write is not', () => {
  it('refuses the secret and issues no command for it', () => {
    const plan = planSettingsWrite(
      base,
      edit({ apiKeys: { openai: 'sk-live-new', anthropic: 'sk-old' } }),
      OFFLINE,
    )
    expect(plan.intents).toEqual([])
    expect(plan.refusals).toEqual([
      {
        path: 'apiKeys.openai',
        reason: 'requires-connection',
        message: expect.stringContaining('never queued'),
      },
    ])
  })

  it('STILL ISSUES a preference write offline — the refusal is by class, not blanket', () => {
    const plan = planSettingsWrite(base, edit({ sidebar: { repoSort: 'alphabetical' } }), OFFLINE)
    expect(plan.refusals).toEqual([])
    expect(plan.intents).toEqual([
      {
        kind: 'preference',
        command: 'settings.updatePersonal',
        delivery: 'offline-eligible',
        values: { 'sidebar.repoSort': 'alphabetical' },
      },
    ])
  })

  it('a mixed save offline issues the preferences and refuses ONLY the secret', () => {
    const plan = planSettingsWrite(
      base,
      edit({
        sidebar: { repoSort: 'alphabetical' },
        apiKeys: { openai: 'sk-live-new', anthropic: 'sk-old' },
      }),
      OFFLINE,
    )
    expect(plan.refusals.map((r) => r.path)).toEqual(['apiKeys.openai'])
    expect(plan.intents.map((i) => i.command)).toEqual(['settings.updatePersonal'])
    // The refused material is nowhere in the plan — not in a payload, not in a
    // message. A refusal that echoed the value would be a leak dressed as an error.
    expect(JSON.stringify(plan)).not.toContain('sk-live-new')
  })
})

describe('online, a secret write IS issued — the refusal above is not vacuous', () => {
  it('issues setSecret with the key and material', () => {
    const plan = planSettingsWrite(
      base,
      edit({ apiKeys: { openai: 'sk-live-new', anthropic: 'sk-old' } }),
      ONLINE,
    )
    expect(plan.refusals).toEqual([])
    expect(plan.intents).toEqual([
      {
        kind: 'secret',
        command: 'settings.setSecret',
        delivery: 'online-sensitive',
        key: 'apiKeys.openai',
        value: 'sk-live-new',
      },
    ])
  })

  it('an EMPTIED secret becomes clearSecret, with no value key at all', () => {
    const plan = planSettingsWrite(base, edit({ apiKeys: { openai: '', anthropic: '' } }), ONLINE)
    expect(plan.intents).toEqual([
      {
        kind: 'secret',
        command: 'settings.clearSecret',
        delivery: 'online-sensitive',
        key: 'apiKeys.anthropic',
      },
    ])
    expect(Object.keys(plan.intents[0] ?? {})).not.toContain('value')
  })

  it('two rotated secrets are two commands, never one batched write', () => {
    const plan = planSettingsWrite(
      base,
      edit({
        apiKeys: { openai: 'sk-a', anthropic: 'sk-b' },
        notifications: { telegramChatId: '', telegramBotToken: 'bot-1' },
      }),
      ONLINE,
    )
    expect(plan.intents.filter((i) => i.kind === 'secret')).toHaveLength(3)
  })
})

describe('tiers are separated, and an unclassified change is refused', () => {
  it('a personal and an instance edit are TWO commands, one per tier', () => {
    const plan = planSettingsWrite(
      base,
      edit({
        sidebar: { repoSort: 'alphabetical' },
        gitWorkflow: { mergeStyle: 'pr' },
      }),
      ONLINE,
    )
    expect(plan.intents.map((i) => i.command).sort()).toEqual([
      'settings.updateInstance',
      'settings.updatePersonal',
    ])
    const personal = plan.intents.find((i) => i.command === 'settings.updatePersonal')
    expect(personal?.kind === 'preference' && personal.values).toEqual({
      'sidebar.repoSort': 'alphabetical',
    })
  })

  it('every path a tier owns rides ONE command — a save is one write per tier', () => {
    const plan = planSettingsWrite(
      base,
      edit({ roles: { coding: { model: 'opus', effort: 'high' } } }),
      ONLINE,
    )
    expect(plan.intents).toHaveLength(1)
    const only = plan.intents[0]
    expect(only?.kind === 'preference' && only.values).toEqual({
      'roles.coding.model': 'opus',
      'roles.coding.effort': 'high',
    })
  })

  it('REFUSES an unclassified change …', () => {
    const plan = planSettingsWrite(base, { ...base, telemetry: { uploadToken: 'x' } }, ONLINE)
    expect(plan.intents).toEqual([])
    expect(plan.refusals).toEqual([
      {
        path: 'telemetry.uploadToken',
        reason: 'unclassified',
        message: expect.stringContaining('belongs to no settings tier'),
      },
    ])
  })

  it('… while still issuing the classified change beside it', () => {
    // Without this arm, "refuses the unclassified path" is satisfied by a
    // planner that classifies nothing and refuses everything.
    const plan = planSettingsWrite(
      base,
      { ...edit({ sidebar: { repoSort: 'custom' } }), telemetry: { uploadToken: 'x' } },
      ONLINE,
    )
    expect(plan.refusals.map((r) => r.path)).toEqual(['telemetry.uploadToken'])
    expect(plan.intents.map((i) => i.command)).toEqual(['settings.updatePersonal'])
  })

  it('an unchanged save plans nothing at all', () => {
    expect(planSettingsWrite(base, { ...base }, ONLINE)).toEqual({ intents: [], refusals: [] })
  })
})

describe('the online-only set is derived and non-empty', () => {
  it('names the secret commands, the presence read, and both halves of the binding ceremony', () => {
    // Non-empty is the load-bearing half: an empty set would make every
    // "secrets are never queued" assertion in this file vacuously true.
    //
    // The ceremony pair joined it when POD-1080 contracted it, and DERIVED is
    // why nobody had to remember: the filter reads `delivery.class`, so the mint
    // (`online-sensitive`) and the redeem (`online-only`) appear here on the
    // same commit that declared them.
    // POD-421's `settings.secretPresence` appears here by the SAME derivation,
    // and for a reason that is about the read rather than about symmetry: a
    // presence projection answered from an offline cache would report "a key is
    // configured" from a snapshot taken before it was cleared. `resource:
    // 'secret'` forces `online-sensitive` through `classificationErrors`, so the
    // read could not have been declared any other way.
    expect([...ONLINE_ONLY_SETTINGS_COMMANDS].sort()).toEqual([
      'settings.clearSecret',
      'settings.secretPresence',
      'settings.setSecret',
      'settings.telegramSetupPoll',
      'settings.telegramSetupStart',
    ])
  })

  it('EXCLUDES the offline-eligible arms — the filter can say no', () => {
    // Without this, a filter that returned every command would satisfy the
    // assertion above's "non-empty" purpose and its membership list.
    expect(ONLINE_ONLY_SETTINGS_COMMANDS).not.toContain('settings.updatePersonal')
    expect(ONLINE_ONLY_SETTINGS_COMMANDS).not.toContain('settings.updateInstance')
  })
})
