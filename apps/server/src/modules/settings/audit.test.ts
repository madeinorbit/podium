/**
 * THE SETTINGS AUDIT TRAIL (POD-421) — the record, its attribution pair, and the
 * ERROR path.
 *
 * ---------------------------------------------------------------------------
 * WHAT WOULD MAKE THIS SUITE WORTHLESS, AND HOW EACH CASE AVOIDS IT
 * ---------------------------------------------------------------------------
 *
 * The standing obligation on this run, from POD-352: *"plant material and
 * require the redactor to NAME what it removed, rather than asserting a clean
 * log."* Asserting `JSON.stringify(row)` lacks the secret is satisfied by a
 * redactor that dropped the payload, by an empty declaration, and by a walker
 * that matched nothing — three broken instruments and one working one, all
 * green. So every redaction case here asserts THREE things: the material is
 * gone, the marker is present at the right address, and `redactedPaths` names
 * the path.
 *
 * The attribution cases have the mirror trap. "The pair is present" is satisfied
 * by a writer that stamps the same value into both columns, which is exactly the
 * collapse ADR 9 D5 A3 forbids — so they assert the two halves are DIFFERENT
 * where they should be, using an agent principal whose actor and human genuinely
 * differ. A suite run only as a human caller cannot see that: for a person the
 * pair is legitimately the same value, and a collapsed implementation is
 * indistinguishable from a correct one.
 */

import { REDACTED } from '@podium/commands'
import { asSessionId, asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { type CommandPrincipal, systemPrincipal } from '../../command-principal'
import type { SettingsAuditRow } from '../../store/settings-audit'
import { settingsAuditAttribution } from '../../store/settings-audit'
import { recordSettingsCommand, REDACTED_MESSAGE, redactErrorMessage } from './audit'

const HUMAN = FIRST_ADMIN_USER_ID
const DELEGATOR = asUserId('ada')

const person: CommandPrincipal = {
  kind: 'user',
  user: HUMAN,
  capability: { role: 'admin', scope: { kind: 'all' } },
}

/** An agent acting FOR a human — the only principal whose two halves differ, and
 *  therefore the only one that can prove the pair is not collapsed. */
const agent: CommandPrincipal = {
  kind: 'agent',
  agentSessionId: asSessionId('sess-42'),
  onBehalfOf: DELEGATOR,
  capability: { role: 'admin', scope: { kind: 'all' } },
  chain: [],
}

function port() {
  const rows: SettingsAuditRow[] = []
  return {
    rows,
    repo: {
      append: (row: SettingsAuditRow): void => {
        rows.push(row)
      },
    },
    now: () => '2026-07-31T00:00:00.000Z',
  }
}

const SECRET = 'sk-ant-real-material-do-not-log'

describe('the material never reaches the trail — and the removal is NAMED', () => {
  it('redacts settings.setSecret.value and reports the path', () => {
    const p = port()
    recordSettingsCommand(p, {
      command: 'settings.setSecret',
      outcome: 'applied',
      principal: person,
      input: { key: 'apiKeys.openai', value: SECRET },
    })
    const [row] = p.rows
    expect(row).toBeDefined()
    // 1 — gone from the WHOLE row, serialized, not just from the key we looked at.
    expect(JSON.stringify(row)).not.toContain(SECRET)
    // 2 — the marker is at the right address, so this is a redaction and not a
    //     dropped payload.
    expect((row?.detail as { input: { value: string; key: string } }).input.value).toBe(REDACTED)
    // 3 — and the key SURVIVES, so it is not an over-redaction either.
    expect((row?.detail as { input: { key: string } }).input.key).toBe('apiKeys.openai')
    // 4 — named.
    expect(row?.redactedPaths).toEqual(['value'])
  })

  it('records the KEY that was rotated — secret identity is what the row is FOR', () => {
    const p = port()
    recordSettingsCommand(p, {
      command: 'settings.clearSecret',
      outcome: 'applied',
      principal: person,
      input: { key: 'notifications.telegramBotToken' },
    })
    expect((p.rows[0]?.detail as { input: { key: string } }).input.key).toBe(
      'notifications.telegramBotToken',
    )
  })

  it('FAILS CLOSED on a command no contract names', () => {
    const p = port()
    recordSettingsCommand(p, {
      command: 'settings.smuggled',
      outcome: 'refused',
      principal: person,
      input: { value: SECRET },
    })
    expect(JSON.stringify(p.rows[0])).not.toContain(SECRET)
    expect((p.rows[0]?.detail as { input: string }).input).toBe(REDACTED)
    expect(p.rows[0]?.redactedPaths).toEqual(['*'])
  })
})

describe('THE ERROR PATH — the place redaction is usually forgotten', () => {
  it('redacts the refused input by the SAME rule as the applied one', () => {
    // The classic split: careful on the success path (where you think about what
    // you store), raw on the failure path (where you think about what went
    // wrong). A `setSecret` refused below the floor still carries the material.
    const p = port()
    recordSettingsCommand(p, {
      command: 'settings.setSecret',
      outcome: 'refused',
      principal: person,
      input: { key: 'apiKeys.openai', value: SECRET },
      error: 'settings.setSecret requires an admin account',
    })
    expect(JSON.stringify(p.rows[0])).not.toContain(SECRET)
    expect(p.rows[0]?.outcome).toBe('refused')
    expect(p.rows[0]?.redactedPaths).toEqual(['value'])
  })

  it('replaces a MESSAGE that was built from the material', () => {
    // The half no path list can address. A declaration cannot redact a substring
    // of `Invalid value "sk-…"`, so the trail asks and replaces.
    const p = port()
    recordSettingsCommand(p, {
      command: 'settings.setSecret',
      outcome: 'refused',
      principal: person,
      input: { key: 'apiKeys.openai', value: SECRET },
      error: `provider rejected the key "${SECRET}"`,
    })
    expect(JSON.stringify(p.rows[0])).not.toContain(SECRET)
    expect((p.rows[0]?.detail as { error: string }).error).toBe(REDACTED_MESSAGE)
  })

  it('KEEPS a message that names no material — the control', () => {
    // Without this the check is satisfied by replacing every message, which
    // destroys the diagnostic value of the trail while looking like security.
    const p = port()
    recordSettingsCommand(p, {
      command: 'settings.setSecret',
      outcome: 'refused',
      principal: person,
      input: { key: 'apiKeys.openai', value: SECRET },
      error: 'settings.setSecret requires an admin account',
    })
    expect((p.rows[0]?.detail as { error: string }).error).toBe(
      'settings.setSecret requires an admin account',
    )
  })

  it('an APPLIED row carries no error key at all', () => {
    const p = port()
    recordSettingsCommand(p, {
      command: 'settings.clearSecret',
      outcome: 'applied',
      principal: person,
      input: { key: 'apiKeys.openai' },
    })
    expect(Object.hasOwn(p.rows[0]?.detail as object, 'error')).toBe(false)
  })
})

describe('redactErrorMessage — the WIRE half of the error path', () => {
  it('replaces a message naming the material', () => {
    expect(
      redactErrorMessage('settings.setSecret', { key: 'apiKeys.openai', value: SECRET }, `bad ${SECRET}`),
    ).toBe(REDACTED_MESSAGE)
  })

  it('passes an innocent message through', () => {
    expect(
      redactErrorMessage('settings.setSecret', { key: 'apiKeys.openai', value: SECRET }, 'offline'),
    ).toBe('offline')
  })

  it('FAILS CLOSED for an unknown command', () => {
    // A message from a command with no contract has no declaration to check it
    // against, so it cannot be shown to be safe — and "cannot be shown safe" must
    // not be spelled the same way as "is safe".
    expect(redactErrorMessage('settings.smuggled', { value: SECRET }, 'anything')).toBe(
      REDACTED_MESSAGE,
    )
  })
})

describe('ATTRIBUTION IS A PAIR, AND IT IS NOT COLLAPSED (ADR 9 D5 A3)', () => {
  it('an agent write records the SESSION as actor and the DELEGATING HUMAN as on-behalf-of', () => {
    const p = port()
    recordSettingsCommand(p, {
      command: 'settings.setSecret',
      outcome: 'applied',
      principal: agent,
      input: { key: 'apiKeys.openai', value: SECRET },
    })
    const row = p.rows[0]
    expect(row?.actorKind).toBe('agent')
    expect(row?.actorId).toBe('session:sess-42')
    expect(row?.onBehalfOf).toBe(DELEGATOR)
    // THE ASSERTION THAT MATTERS. "Both fields are populated" is satisfied by a
    // writer that stamps one value into both — the collapse D5 A3 forbids —
    // and only an actor that genuinely differs from its human can see it.
    expect(row?.actorId).not.toBe(row?.onBehalfOf)
  })

  it('a human write records the same person on both halves, and that is CORRECT', () => {
    // The control that stops the assertion above from becoming "they must always
    // differ". For a person acting directly the pair legitimately coincides —
    // which is exactly why a suite run only as a human cannot detect a collapse.
    const p = port()
    recordSettingsCommand(p, {
      command: 'settings.updatePersonal',
      outcome: 'applied',
      principal: person,
      input: { values: {} },
    })
    expect(p.rows[0]?.actorKind).toBe('user')
    expect(p.rows[0]?.actorId).toBe(HUMAN)
    expect(p.rows[0]?.onBehalfOf).toBe(HUMAN)
  })

  it('a SYSTEM write is attributed as system and is given NO human (ADR 9 D8 S5)', () => {
    const p = port()
    recordSettingsCommand(p, {
      command: 'settings.updateInstance',
      outcome: 'applied',
      principal: systemPrincipal('boot-reconcile'),
      input: { values: {} },
    })
    const row = p.rows[0]
    expect(row?.actorKind).toBe('system')
    expect(row?.actorId).toBe('system:boot-reconcile')
    // NULL, and not the first admin, not the row's owner, not an empty string —
    // "none by construction" must stay distinguishable from "we failed to record
    // one", which an empty string would not be.
    expect(row?.onBehalfOf).toBeNull()
  })

  it('the derivation itself cannot give a system principal a human', () => {
    // Asserted at the function that DECIDES, not only at the row it produced:
    // there is no argument a caller could pass that would put a person here.
    expect(settingsAuditAttribution(systemPrincipal('expiry')).onBehalfOf).toBeNull()
    expect(settingsAuditAttribution(agent).onBehalfOf).toBe(DELEGATOR)
    expect(settingsAuditAttribution(person).onBehalfOf).toBe(HUMAN)
  })
})
