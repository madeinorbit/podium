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
  settingsTelegramSetupPollInput,
  settingsTelegramSetupStartInput,
  settingsUpdateInstanceInput,
  settingsUpdatePersonalInput,
  TIER_COMMAND,
  WRITABLE_PREFERENCE_PATHS,
} from './contracts'

const NAMES = SETTINGS_COMMAND_NAMES
const ALL = NAMES.map((name) => SETTINGS_CONTRACTS[name])

describe('the family is complete and classified', () => {
  it('declares seven contracts: one per tier, the secret CLEAR and READ arms, and the ceremony pair', () => {
    // SEVEN as of POD-421, which added `settings.secretPresence` — the presence
    // READ POD-420 recorded as this issue's ("`settings.get` is deliberately
    // absent … what it returns is POD-419's question and POD-421's"). The number
    // rose because a surface became CLASSIFIED, not because one was absorbed:
    // the read existed as `SettingsService.secretPresenceList()` with its
    // `roleFloor` decided nowhere. Widening a pin is only a defect when the
    // commit does not say why.
    expect(NAMES).toEqual([
      'settings.clearSecret',
      'settings.secretPresence',
      'settings.setSecret',
      'settings.telegramSetupPoll',
      'settings.telegramSetupStart',
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

    it(`${name}: names only transports something actually dispatches`, () => {
      expect(contract.exposure).toEqual(
        name === 'settings.updatePersonal' ? ['trpc', 'outbox'] : ['trpc'],
      )
    })
  }
})

describe('the secret arms are never queueable, and the matrix says so too', () => {
  const secrets = NAMES.filter((n) => CONTRACT_TIER[n] === 'server-secret')

  it('there ARE secret arms — the claims below are not vacuous', () => {
    expect(secrets).toEqual([
      'settings.clearSecret',
      // The READ answers to the same `server-secrets` row as the two writes, so
      // it is subject to the same never-queueable claim rather than exempted
      // from it — a presence projection served from an offline cache would
      // answer "is a key configured" from before it was cleared.
      'settings.secretPresence',
      'settings.setSecret',
    ])
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
    // 38 = 24 personal + 14 instance (idleShellHours, POD-565). Secrets stay out.
    expect(WRITABLE_PREFERENCE_PATHS.length).toBe(38)
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

  it('no BLOB arm redacts an OUTPUT, because no output has a value key by construction', () => {
    // Scoped to the four blob writes by their TIER membership rather than by a
    // hand list, so a seventh blob contract inherits the claim and a seventh
    // ceremony contract does not. The ceremony arms genuinely do carry material
    // outwards and are asserted separately below — widening this loop over them
    // would have meant either a false claim or a weakened one.
    const blobArms = (NAMES as SettingsContractName[]).filter((n) => CONTRACT_TIER[n] !== undefined)
    // FIVE since POD-421: the presence read is a `server-secrets`-tier arm whose
    // output is `SecretPresenceWire[]`, built independently of `ServerSecret` so
    // that it has no value key to strip. It inherits the claim by tier
    // membership exactly as the comment above intends.
    expect(blobArms).toHaveLength(5)
    for (const name of blobArms) {
      expect(SETTINGS_CONTRACTS[name].redaction.outputPaths).toEqual([])
      expect(SETTINGS_CONTRACTS[name].redaction.reviewed).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// The binding ceremony (POD-1080)
// ---------------------------------------------------------------------------

describe('the ceremony pair classifies a MINT and a REDEMPTION differently', () => {
  const start = SETTINGS_CONTRACTS['settings.telegramSetupStart']
  const poll = SETTINGS_CONTRACTS['settings.telegramSetupPoll']

  it('the mint is secret-classed and the redeem is per-user-state — they DIFFER', () => {
    expect(start.visibility).toBe('secret')
    expect(poll.visibility).toBe('per-user-state')
    // If these ever agree, one of the two rows is being misread and the split
    // between "writes a credential" and "writes an owned row" has no content.
    expect(start.visibility).not.toBe(poll.visibility)
  })

  it('reads BOTH classes off shipped matrix rows, and the rows are not the same row', () => {
    // `contractMatrixRow` is the instrument; these two assertions are its
    // per-arm use. The rows are looked up by id and the lookup THROWS on a miss,
    // so a row id that stopped existing reddens here rather than defaulting.
    expect(contractMatrixRow('settings.telegramSetupStart').visibility).toBe('secret')
    expect(contractMatrixRow('settings.telegramSetupPoll').visibility).toBe('per-user-state')
    expect(contractMatrixRow('settings.telegramSetupStart').id).not.toBe(
      contractMatrixRow('settings.telegramSetupPoll').id,
    )
  })

  it('the instrument can say NO: an unclassified contract name throws', () => {
    // Non-vacuity for the two assertions above. Without this, a
    // `contractMatrixRow` that returned some default row would satisfy them.
    expect(() => contractMatrixRow('settings.notAContract' as SettingsContractName)).toThrow(
      /names no settings tier and no matrix row/,
    )
  })

  it('neither arm is queueable — a live bearer code and a chat binding are both online', () => {
    expect(start.delivery.class).toBe('online-sensitive')
    expect(poll.delivery.class).toBe('online-only')
    expect(start.exposure).not.toContain('outbox')
    expect(poll.exposure).not.toContain('outbox')
    // …and the shipped rows say the same from the other end.
    expect(contractMatrixRow('settings.telegramSetupStart').offline).toBe('never-enqueue')
    expect(contractMatrixRow('settings.telegramSetupPoll').offline).toBe('online-only')
  })

  it('THE MINT REDACTS THE URL AS WELL AS THE CODE — the joinCommand lesson', () => {
    // `telegramUrl` is `t.me/<bot>?start=<code>`: it INLINES the credential, so
    // redacting `code` alone would be theatre. `machines.pairingCode` learned
    // this about `joinCommand` and this is the same shape.
    expect(start.redaction.outputPaths).toEqual(['code', 'telegramUrl'])
    expect(start.redaction.inputPaths).toEqual([])
  })

  it('the mint takes NO identity input — there is nothing for a caller to assert', () => {
    // The mechanism claim at the schema layer: the input parses to an empty
    // object, so a `userId` or `chatId` a caller adds cannot survive it.
    const parsed = settingsTelegramSetupStartInput.safeParse(undefined)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toEqual({})
    // Keyed on the OUTPUT (POD-640): zod STRIPS unknown keys and succeeds, so
    // `.success` alone would prove nothing about what got through.
    const smuggled = settingsTelegramSetupStartInput.safeParse({ userId: 'user:bob' })
    expect(smuggled.success && smuggled.data).toEqual({})
  })

  it('the redeem is addressed by the mint handle, and refuses an empty one', () => {
    expect(settingsTelegramSetupPollInput.safeParse({ setupId: 'abc' }).success).toBe(true)
    expect(settingsTelegramSetupPollInput.safeParse({ setupId: '' }).success).toBe(false)
    expect(settingsTelegramSetupPollInput.safeParse({}).success).toBe(false)
    // The CODE is not a field here: it reaches the server out-of-band, through
    // Telegram. A `code` key would make the ceremony a single-channel one.
    const smuggled = settingsTelegramSetupPollInput.safeParse({ setupId: 'abc', code: 'PODIUM1' })
    expect(smuggled.success && smuggled.data).toEqual({ setupId: 'abc' })
  })

  it('OWNERSHIP FLOWS FROM THE MINT: the redeem inherits from its PARENT', () => {
    // POD-1079's rule. `on-behalf-of-human` alone would name the REDEEMER, and
    // then whoever obtained a `setupId` could complete someone else's ceremony
    // and take the chat.
    expect(poll.ownership).toMatchObject({
      creates: ['telegram-chat-binding'],
      owner: 'on-behalf-of-human',
      inheritanceOnCreate: 'parent',
      visibility: 'per-user-state',
    })
  })

  it('the MINT creates nothing — a secret has no owner to assign', () => {
    expect(start.ownership.creates).toEqual([])
    expect('owner' in start.ownership).toBe(false)
    expect(contractMatrixRow('settings.telegramSetupStart').owner?.kind).toBe('none')
  })

  it('both halves of one ceremony carry the SAME floor', () => {
    // The lower floor is the ceremony's real floor; two different ones would
    // make the higher a decoration.
    expect(start.policy.roleFloor).toBe('admin')
    expect(poll.policy.roleFloor).toBe(start.policy.roleFloor)
  })

  it('the redeem takes a caller-supplied target id and must not become a probe', () => {
    // The only arm in this family that does, which is why it does not share
    // `CLOSED_VOCABULARY_ERRORS`.
    expect(poll.errorConsistency.callerSuppliedTargetId).toBe(true)
    expect(start.errorConsistency.callerSuppliedTargetId).toBe(false)
    expect(
      poll.errorConsistency.callerSuppliedTargetId && poll.errorConsistency.invisibleFailsAs,
    ).toBe('nonexistent')
  })
})
