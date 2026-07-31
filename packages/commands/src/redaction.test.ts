/**
 * The redactor is a walk-and-rebuild, so it carries POD-419's defect class: a
 * faulty REBUILD destroys data while every "is the secret gone" assertion stays
 * true. Both halves of its contract are therefore tested — the removal AND the
 * survival — and the survival half is seeded with the values a naive plain-object
 * check mistakes for objects.
 */

import { describe, expect, it } from 'vitest'
import type { AnyCommandContract, RedactionPolicy } from './contract'
import {
  applyRedaction,
  applyRedactionWithReport,
  messageMentionsRedactedValue,
  REDACTED,
  redactForLog,
  redactReport,
  redactUnknownForLog,
} from './redaction'
import { SETTINGS_CONTRACTS } from './settings/contracts'

const policy = (over: Partial<RedactionPolicy>): RedactionPolicy => ({
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note: 'fixture',
  ...over,
})

describe('applyRedaction — the removal half', () => {
  it('replaces a declared top-level path with the marker', () => {
    const out = applyRedaction(policy({ inputPaths: ['value'] }), 'input', {
      key: 'apiKeys.openai',
      value: 'sk-real-material',
    })
    expect(out).toEqual({ key: 'apiKeys.openai', value: REDACTED })
  })

  it('replaces a declared NESTED path and leaves its siblings alone', () => {
    const out = applyRedaction(
      policy({ outputPaths: ['settings.notifications.telegramBotToken'] }),
      'output',
      {
        settings: {
          notifications: { telegramBotToken: 'bot:123', telegramChatId: '42' },
          other: 'kept',
        },
      },
    )
    expect(out).toEqual({
      settings: {
        notifications: { telegramBotToken: REDACTED, telegramChatId: '42' },
        other: 'kept',
      },
    })
  })

  it('reads the INPUT and OUTPUT lists separately — a path on one side does not redact the other', () => {
    // The trap this is written against: merging the two lists would make an
    // output-only declaration silently cover inputs and read as working.
    const p = policy({ inputPaths: ['value'], outputPaths: ['code'] })
    expect(applyRedaction(p, 'input', { value: 'v', code: 'c' })).toEqual({
      value: REDACTED,
      code: 'c',
    })
    expect(applyRedaction(p, 'output', { value: 'v', code: 'c' })).toEqual({
      value: 'v',
      code: REDACTED,
    })
  })

  it('addresses an array element by index', () => {
    const out = applyRedaction(policy({ inputPaths: ['rows.1.value'] }), 'input', {
      rows: [{ value: 'keep' }, { value: 'burn' }],
    })
    expect(out).toEqual({ rows: [{ value: 'keep' }, { value: REDACTED }] })
  })
})

describe('applyRedaction — the PRESERVATION half (POD-419: only the rebuild is at risk)', () => {
  it('carries structured-clone values through BY REFERENCE, not rebuilt as {}', () => {
    const date = new Date('2026-07-31T00:00:00.000Z')
    const map = new Map([['a', 1]])
    const set = new Set([1, 2])
    const bytes = new Uint8Array([1, 2, 3])
    const nested = [[1, 2], [3]]
    const payload = { value: 'sk-real', date, map, set, bytes, nested, unicode: 'héllo → ✓' }

    const out = applyRedaction(policy({ inputPaths: ['value'] }), 'input', payload) as typeof payload

    expect(out.value).toBe(REDACTED)
    // BY REFERENCE — `toEqual` would pass against a `{}` rebuild for a Map and a
    // Set in some matchers, so identity is the assertion.
    expect(out.date).toBe(date)
    expect(out.map).toBe(map)
    expect(out.set).toBe(set)
    expect(out.bytes).toBe(bytes)
    expect(out.nested).toBe(nested)
    expect(out.unicode).toBe('héllo → ✓')
  })

  it('does not mutate the payload it was given', () => {
    const payload = { value: 'sk-real', keep: 'here' }
    applyRedaction(policy({ inputPaths: ['value'] }), 'input', payload)
    expect(payload.value).toBe('sk-real')
  })

  it('returns the SAME object when no declared path resolves — no rebuild at all', () => {
    const payload = { key: 'apiKeys.openai' }
    // `value` is declared but absent: the cheapest correct answer is the input
    // itself, and a rebuild here would be a rebuild with nothing to gain.
    expect(applyRedaction(policy({ inputPaths: ['value'] }), 'input', payload)).toBe(payload)
  })

  it('does not invent a key on a value that does not have one', () => {
    // A path that addresses nothing must not CREATE the address — otherwise a
    // stale declaration writes `[redacted]` into records that never had the field
    // and the log grows a fact that was never true.
    const out = applyRedaction(policy({ inputPaths: ['a.b.c'] }), 'input', { a: 5 })
    expect(out).toEqual({ a: 5 })
  })

  it('does not treat a non-index path segment as an array key', () => {
    const rows = [{ value: 'keep' }]
    const out = applyRedaction(policy({ inputPaths: ['rows.value'] }), 'input', { rows }) as {
      rows: unknown
    }
    expect(out.rows).toBe(rows)
  })
})

describe('the fail-closed arm', () => {
  it('an unknown command redacts WHOLE', () => {
    expect(redactUnknownForLog()).toBe(REDACTED)
  })

  it('a policy with an empty list is a PASS-THROUGH, and that is only safe because it was reviewed', () => {
    // The distinction the `reviewed: true` field exists to make: "nothing here is
    // sensitive" and "nobody looked" must not produce the same behaviour. A
    // contract cannot be constructed with `reviewed` unset (`classificationErrors`
    // refuses it), so an empty list is always the first case — and a caller with
    // NO contract gets `redactUnknownForLog` instead.
    const payload = { anything: 'visible' }
    expect(applyRedaction(policy({}), 'input', payload)).toBe(payload)
  })
})

describe('the shipped settings contracts — this reader against the real declarations', () => {
  // The positive control (POD-363): an instrument whose job is to FIND things
  // must be shown to find something on the REAL table, not only on a fixture.
  it('redacts settings.setSecret.value, the material itself', () => {
    const contract = SETTINGS_CONTRACTS['settings.setSecret'] as AnyCommandContract
    const out = redactForLog(contract, 'input', {
      key: 'apiKeys.openai',
      value: 'sk-ant-real-material',
    }) as Record<string, unknown>
    expect(out.value).toBe(REDACTED)
    // And the key is NOT redacted — POD-420's cell says so in as many words, and
    // an over-redacting reader would hide the only thing that makes a refusal
    // actionable. This is the "does not over-find" control.
    expect(out.key).toBe('apiKeys.openai')
  })

  it('redacts the claim-code mint output — the preimage, not just the material', () => {
    const contract = SETTINGS_CONTRACTS['settings.telegramSetupStart'] as AnyCommandContract
    const out = redactForLog(contract, 'output', {
      setupId: 's1',
      code: 'PODIUMABCD1234',
      telegramUrl: 'https://t.me/bot?start=PODIUMABCD1234',
      botUsername: 'bot',
    }) as Record<string, unknown>
    expect(out.code).toBe(REDACTED)
    // The URL EMBEDS the code, which is why POD-420 declared both paths. A reader
    // that redacted only `code` would leave the preimage in the log inside a URL.
    expect(out.telegramUrl).toBe(REDACTED)
    expect(out.botUsername).toBe('bot')
  })

  it('redacts the bot token out of settings.telegramSetupPoll, which answers with the whole blob', () => {
    const contract = SETTINGS_CONTRACTS['settings.telegramSetupPoll'] as AnyCommandContract
    const out = redactForLog(contract, 'output', {
      status: 'connected',
      chatId: '42',
      settings: { notifications: { telegramBotToken: 'bot:secret', telegramChatId: '42' } },
    }) as { settings: { notifications: Record<string, unknown> } }
    expect(out.settings.notifications.telegramBotToken).toBe(REDACTED)
    expect(out.settings.notifications.telegramChatId).toBe('42')
  })

  it('EVERY settings contract declares a reviewed policy, so no caller can reach the unknown arm through the table', () => {
    const names = Object.keys(SETTINGS_CONTRACTS)
    // Non-vacuity floor: an empty table would satisfy the loop below perfectly.
    expect(names.length).toBeGreaterThanOrEqual(6)
    for (const name of names) {
      const contract = SETTINGS_CONTRACTS[name as keyof typeof SETTINGS_CONTRACTS]
      expect(contract.redaction.reviewed).toBe(true)
      expect(contract.redaction.note.trim()).not.toBe('')
    }
  })
})

describe('the report — the redactor must NAME what it removed', () => {
  // POD-352's standing obligation on this run: asserting a clean log is
  // compatible with a redactor that dropped the payload, with an empty path
  // list, and with a walker that matched nothing. Only a named removal
  // distinguishes them.
  it('names the path it actually replaced', () => {
    const contract = SETTINGS_CONTRACTS['settings.setSecret'] as AnyCommandContract
    const report = redactReport(contract, 'input', { key: 'apiKeys.openai', value: 'sk-real' })
    expect(report.redactedPaths).toEqual(['value'])
  })

  it('reports NOTHING when the declared path addressed nothing', () => {
    // The non-vacuity control on the report itself. A stale declaration must not
    // be able to inflate the evidence that a redaction happened — otherwise
    // "redactedPaths is non-empty" becomes satisfiable without removing anything.
    const contract = SETTINGS_CONTRACTS['settings.setSecret'] as AnyCommandContract
    const report = redactReport(contract, 'input', { key: 'apiKeys.openai' })
    expect(report.redactedPaths).toEqual([])
  })

  it('reports both paths when both resolve', () => {
    const contract = SETTINGS_CONTRACTS['settings.telegramSetupStart'] as AnyCommandContract
    const report = redactReport(contract, 'output', {
      code: 'PODIUMABCD1234',
      telegramUrl: 'https://t.me/bot?start=PODIUMABCD1234',
    })
    expect([...report.redactedPaths].sort()).toEqual(['code', 'telegramUrl'])
  })

  it('reports a path whose value is undefined but PRESENT, which value-equality would miss', () => {
    const report = applyRedactionWithReport(policy({ inputPaths: ['value'] }), 'input', {
      value: undefined,
    })
    expect(report.redactedPaths).toEqual(['value'])
    expect((report.value as Record<string, unknown>).value).toBe(REDACTED)
  })
})

describe('messageMentionsRedactedValue — the half a path list CANNOT cover', () => {
  const contract = SETTINGS_CONTRACTS['settings.setSecret'] as AnyCommandContract
  const input = { key: 'apiKeys.openai', value: 'sk-ant-real-material' }

  it('says YES when a message was built from a redacted value', () => {
    expect(
      messageMentionsRedactedValue(
        'rejected value "sk-ant-real-material" for apiKeys.openai',
        contract,
        'input',
        input,
      ),
    ).toBe(true)
  })

  it('says NO for a message that names only the key', () => {
    // The control. A predicate that answered `true` for every message would be
    // discarded as noise within a week, which is the "floor a correct tree cannot
    // meet" failure applied to a guard.
    expect(
      messageMentionsRedactedValue(
        'settings.setSecret requires an admin account',
        contract,
        'input',
        input,
      ),
    ).toBe(false)
  })

  it('does not fire on an EMPTY declared value, which is a substring of every message', () => {
    expect(
      messageMentionsRedactedValue('anything at all', contract, 'input', {
        key: 'apiKeys.openai',
        value: '',
      }),
    ).toBe(false)
  })
})
