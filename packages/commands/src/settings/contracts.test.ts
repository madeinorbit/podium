/**
 * THE SETTINGS FAMILY, CHECKED AGAINST THE SHIPPED MATRIX — not against a copy
 * of it, and not against arm 0.
 *
 * Two things this file is deliberately careful about, both earned in this run:
 *
 *  - **Every classification is asserted PER CONTRACT against the row its tier
 *    names** (`contractMatrixRow`), so a matrix edit that weakened the secret
 *    row's `offline: 'never-enqueue'` reddens a named test here. Asserting the
 *    first arm and trusting the rest is how a restatement passes (POD-305).
 *  - **Every instrument is shown to say YES before its NO is believed.** The
 *    schema tests are mostly refusals, which is exactly what a broken schema
 *    produces; each refusal is paired with the acceptance it must not swallow,
 *    and the derived path sets are asserted non-empty with a known deep member.
 */

import {
  classifySettingsPath,
  SERVER_SECRET_KEYS,
  SETTINGS_CLASSIFICATION,
  SETTINGS_TIERS,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import { type AnyCommandContract, registryClassificationErrors } from '../contract'
import {
  CONTRACT_TIER,
  contractMatrixRow,
  preferencePathsInTier,
  SETTINGS_COMMAND_NAMES,
  SETTINGS_CONTRACTS,
  type SettingsContractName,
  settingsClearSecretInput,
  settingsSetSecretInput,
  settingsUpdateInstanceInput,
  settingsUpdatePersonalInput,
  TIER_COMMAND,
  WRITABLE_PREFERENCE_PATHS,
} from './contracts'

const NAMES = SETTINGS_COMMAND_NAMES
const ALL = NAMES.map((name) => SETTINGS_CONTRACTS[name])

describe('the family is complete and classified', () => {
  it('declares four contracts, one per tier plus the secret CLEAR arm', () => {
    expect(NAMES).toEqual([
      'settings.clearSecret',
      'settings.setSecret',
      'settings.updateInstance',
      'settings.updatePersonal',
    ])
  })

  it('passes the L1 classification lint with no errors', () => {
    expect(registryClassificationErrors(ALL)).toEqual([])
  })

  it('covers every tier — no settings leaf is left with no command that writes it', () => {
    // Derived from the model's tier vocabulary, so a FOURTH tier added later is
    // a failure here rather than a silently unwritable set of leaves.
    for (const tier of SETTINGS_TIERS) {
      expect(TIER_COMMAND[tier], `no command writes the ${tier} tier`).toBeDefined()
      expect(NAMES).toContain(TIER_COMMAND[tier])
    }
  })
})

describe('each contract reads its classification off the SHIPPED matrix row', () => {
  // PER ARM. A loop over the table, so a fifth contract added with a copied
  // classification is checked against ITS row and not against a neighbour's.
  for (const name of NAMES) {
    const contract = SETTINGS_CONTRACTS[name]
    const row = contractMatrixRow(name)

    it(`${name}: visibility matches the row`, () => {
      expect(contract.visibility).toBe(row.visibility)
    })

    it(`${name}: the delivery class agrees with the row's offline class`, () => {
      // Read off the row, never restated: `never-enqueue` and `online-only` both
      // mean "not offline-eligible", and `offline-eligible` means it exactly.
      if (row.offline === 'offline-eligible') {
        expect(contract.delivery.class).toBe('offline-eligible')
      } else {
        expect(contract.delivery.class).not.toBe('offline-eligible')
      }
    })

    it(`${name}: is not exposed on the outbox`, () => {
      expect(contract.exposure).not.toContain('outbox')
    })

    it(`${name}: names only transports something actually dispatches`, () => {
      // `relay.ts` has no `settings` arm and there is no `podium settings` CLI
      // verb or MCP tool — a declared transport nothing serves is POD-385's
      // defect, so the whole family is trpc-only until one exists.
      expect(contract.exposure).toEqual(['trpc'])
    })
  }
})

describe('the secret arms are never queueable, and the matrix says so too', () => {
  const secrets = NAMES.filter((n) => CONTRACT_TIER[n] === 'server-secret')

  it('there ARE secret arms — the claims below are not vacuous', () => {
    expect(secrets).toEqual(['settings.clearSecret', 'settings.setSecret'])
  })

  for (const name of ['settings.setSecret', 'settings.clearSecret'] as const) {
    it(`${name}: secret visibility, secret resource, online-sensitive, confirmed`, () => {
      const c = SETTINGS_CONTRACTS[name]
      expect(c.visibility).toBe('secret')
      expect(c.policy.resource).toBe('secret')
      expect(c.delivery.class).toBe('online-sensitive')
      expect(c.policy.confirmation).toBe('confirm')
      expect(c.policy.roleFloor).toBe('admin')
    })

    it(`${name}: carries no machineVerb — there is no compute to place work on`, () => {
      // Asserted as ABSENCE of the key, not as an `undefined` read: a contract
      // that declared `machineVerb: undefined` would satisfy the second and is
      // not the same declaration. Read through the erased view, because the
      // `as const satisfies` narrows the optional field out of the literal type.
      const policy = (SETTINGS_CONTRACTS[name] as AnyCommandContract).policy
      expect('machineVerb' in policy).toBe(false)
      expect(policy.machineVerb).toBeUndefined()
      // …and the in-check can say YES: a policy that HAS the key is detected.
      expect('machineVerb' in { ...policy, machineVerb: 'use' as const }).toBe(true)
    })

    it(`${name}: creates nothing, because the matrix row has no owner`, () => {
      const c = SETTINGS_CONTRACTS[name]
      expect(c.ownership.creates).toEqual([])
      expect('owner' in c.ownership).toBe(false)
      expect(contractMatrixRow(name).owner?.kind).toBe('none')
    })
  }

  it('the shipped row still says never-enqueue — the source of the class above', () => {
    // The tie-back POD-418 built the row-reading for. If a matrix edit weakened
    // this, the per-arm delivery test above changes meaning; this names it.
    expect(contractMatrixRow('settings.setSecret').offline).toBe('never-enqueue')
    expect(contractMatrixRow('settings.setSecret').replication).toBe('none')
  })
})

describe('the preference arms are offline-eligible and differ only where the rows differ', () => {
  it('both are offline-eligible', () => {
    expect(SETTINGS_CONTRACTS['settings.updatePersonal'].delivery.class).toBe('offline-eligible')
    expect(SETTINGS_CONTRACTS['settings.updateInstance'].delivery.class).toBe('offline-eligible')
  })

  it('each tier ARGUES its own offline-eligibility rather than sharing one cell', () => {
    // POD-735's precedent: a delivery class copied from a row's column is a
    // class nobody argued. The two reconciliations must be DIFFERENT texts, and
    // each must carry the reasoning specific to its tier — single-writer for the
    // personal row, the surviving field-LWW group for the instance one.
    const personal = SETTINGS_CONTRACTS['settings.updatePersonal'].delivery
    const instance = SETTINGS_CONTRACTS['settings.updateInstance'].delivery
    expect(personal.outboxReconciliation).not.toBe(instance.outboxReconciliation)
    expect(personal.outboxReconciliation).toContain('SINGLE-WRITER')
    expect(instance.outboxReconciliation).toContain('field-LWW')
    // Both name the inertness test D18.3 turns on, which is what makes the
    // class an argument rather than an inheritance.
    expect(personal.outboxReconciliation).toContain('INERT')
    expect(instance.outboxReconciliation).toContain('inert')
  })

  it('personal is per-user-state at a member floor; instance is substrate at an admin floor', () => {
    const personal = SETTINGS_CONTRACTS['settings.updatePersonal']
    const instance = SETTINGS_CONTRACTS['settings.updateInstance']
    expect(personal.visibility).toBe('per-user-state')
    expect(personal.policy.roleFloor).toBe('member')
    expect(instance.visibility).toBe('deployment-substrate')
    expect(instance.policy.roleFloor).toBe('admin')
    // The two visibility classes DIFFER — which is the argument for two
    // contracts. If this ever passes with them equal, the split has no content.
    expect(personal.visibility).not.toBe(instance.visibility)
  })
})

// ---------------------------------------------------------------------------
// The schema IS the authorization gate for a preference path
// ---------------------------------------------------------------------------

describe('a preference patch is gated on the classified path — and can say YES', () => {
  it('accepts a real personal path (the positive control)', () => {
    const parsed = settingsUpdatePersonalInput.safeParse({
      values: { 'roles.coding.model': 'opus' },
    })
    expect(parsed.success).toBe(true)
    // Keyed on the OUTPUT, not on `.success` alone: zod strips unknown keys and
    // succeeds, so a schema that dropped `values` entirely would still report
    // success (POD-640).
    expect(parsed.success && parsed.data.values).toEqual({ 'roles.coding.model': 'opus' })
  })

  it('accepts a real instance path on the instance command', () => {
    const parsed = settingsUpdateInstanceInput.safeParse({
      values: { 'gitWorkflow.mergeStyle': 'pr' },
    })
    expect(parsed.success && parsed.data.values).toEqual({ 'gitWorkflow.mergeStyle': 'pr' })
  })

  it('REFUSES a path nothing classifies — the fail-closed branch', () => {
    const parsed = settingsUpdatePersonalInput.safeParse({
      values: { 'telemetry.uploadToken': 'x' },
    })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain('not a classified settings path')
  })

  it('REFUSES a secret path on the offline-eligible command', () => {
    // The write POD-352 named: a generic offline settings write carrying a
    // credential. Refused by the SCHEMA, before any handler exists.
    for (const key of SERVER_SECRET_KEYS) {
      const parsed = settingsUpdatePersonalInput.safeParse({ values: { [key]: 'sk-live' } })
      expect(parsed.success, `${key} was accepted by settings.updatePersonal`).toBe(false)
      const issues = JSON.stringify(parsed.error?.issues)
      // BOTH gates fire, and they are independent mechanisms (ADR 9 D4 point 2):
      // the tier check and the may-enqueue backstop.
      expect(issues).toContain('server-secret')
      expect(issues).toContain('may not be enqueued')
    }
  })

  it('REFUSES an instance path on the personal command, and vice versa', () => {
    expect(
      settingsUpdatePersonalInput.safeParse({ values: { 'gitWorkflow.mergeStyle': 'pr' } }).success,
    ).toBe(false)
    expect(
      settingsUpdateInstanceInput.safeParse({ values: { 'roles.coding.model': 'opus' } }).success,
    ).toBe(false)
  })

  it('REFUSES an empty patch — a write that names no path is not a write', () => {
    expect(settingsUpdatePersonalInput.safeParse({ values: {} }).success).toBe(false)
  })

  it('accepts EVERY classified preference path on exactly one command, and no secret on either', () => {
    // Totality, derived. A leaf added to a preference shape becomes writable on
    // the same commit; a leaf added to no tier is writable through neither.
    for (const c of SETTINGS_CLASSIFICATION) {
      const personal = settingsUpdatePersonalInput.safeParse({ values: { [c.path]: 1 } }).success
      const instance = settingsUpdateInstanceInput.safeParse({ values: { [c.path]: 1 } }).success
      if (c.tier === 'server-secret') {
        expect([personal, instance], `${c.path} reached a preference command`).toEqual([
          false,
          false,
        ])
      } else {
        expect(
          [personal, instance].filter(Boolean).length,
          `${c.path} is writable by ${[personal && 'personal', instance && 'instance']
            .filter(Boolean)
            .join(' and ')}`,
        ).toBe(1)
      }
    }
  })
})

describe('the derived path sets find something', () => {
  it('the personal tier has its 24 leaves, including a deep one', () => {
    const personal = preferencePathsInTier('personal-preference')
    expect(personal.length).toBe(24)
    expect(personal).toContain('roles.coding.model')
    expect(personal).toContain('autoContinue.promptDismissed')
  })

  it('the writable set is both preference tiers and NOTHING from the secret tier', () => {
    expect(WRITABLE_PREFERENCE_PATHS.length).toBe(34)
    for (const key of SERVER_SECRET_KEYS) expect(WRITABLE_PREFERENCE_PATHS).not.toContain(key)
    // …and the exclusion is not an empty-set artefact.
    expect(WRITABLE_PREFERENCE_PATHS).toContain('experimental')
  })

  it('every writable path really is classified — the derivation is not fabricating names', () => {
    for (const path of WRITABLE_PREFERENCE_PATHS) {
      expect(classifySettingsPath(path), `${path} is not classified`).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// The secret schemas
// ---------------------------------------------------------------------------

describe('the secret write vocabulary is closed', () => {
  it('accepts each of the five keys with material', () => {
    for (const key of SERVER_SECRET_KEYS) {
      const parsed = settingsSetSecretInput.safeParse({ key, value: 'sk-live-1' })
      expect(parsed.success && parsed.data.key).toBe(key)
    }
  })

  it('REFUSES a key outside the vocabulary', () => {
    expect(settingsSetSecretInput.safeParse({ key: 'apiKeys.smuggled', value: 'x' }).success).toBe(
      false,
    )
    expect(settingsClearSecretInput.safeParse({ key: 'apiKeys.smuggled' }).success).toBe(false)
  })

  it('REFUSES an empty value — absence is `clearSecret`, not a blank replace', () => {
    expect(settingsSetSecretInput.safeParse({ key: 'apiKeys.openai', value: '' }).success).toBe(
      false,
    )
  })

  it('clearSecret carries no material key at all', () => {
    const parsed = settingsClearSecretInput.safeParse({
      key: 'apiKeys.openai',
      value: 'sk-should-not-survive',
    })
    // zod strips the unknown key, so the assertion is on the OUTPUT: there is
    // nowhere in a clear command for material to ride.
    expect(parsed.success && Object.keys(parsed.data)).toEqual(['key'])
  })
})

describe('redaction was reviewed, and the answers differ where the tiers differ', () => {
  it('setSecret names its material input; clearSecret has none to name', () => {
    expect(SETTINGS_CONTRACTS['settings.setSecret'].redaction.inputPaths).toEqual(['value'])
    expect(SETTINGS_CONTRACTS['settings.clearSecret'].redaction.inputPaths).toEqual([])
  })

  it('no arm redacts an OUTPUT, because no output has a value key by construction', () => {
    for (const name of NAMES as SettingsContractName[]) {
      expect(SETTINGS_CONTRACTS[name].redaction.outputPaths).toEqual([])
      expect(SETTINGS_CONTRACTS[name].redaction.reviewed).toBe(true)
    }
  })
})
