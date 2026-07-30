/**
 * The client-secret audit, in a LANE (POD-419).
 *
 * `scripts/audit-client-secrets.ts` is a gate somebody has to type — and a gate
 * nobody types is a gate that does not exist (`--probe` proved nothing after the
 * session that wrote it). This puts it in the unit lane as a standing tripwire
 * and asserts the two things a gate needs to be believed:
 *
 *  1. it is CLEAN against the live tree — the claim;
 *  2. each check FIRES on a fixture containing what it hunts — the instrument.
 *
 * (2) carries the weight here. Every check but one is an ABSENCE claim, and an
 * absence is exactly what a broken scanner reports. The gate's first draft
 * passed its own review and failed its own probe three ways at once: it read
 * inside string literals, so it flagged `store.secrets.get('apiKeys.openai')` —
 * the correct call — as loudly as the defect; and its wired-adapter fixture
 * supplied one of the two adapters, so the clean case reported the other
 * missing. Both are recorded below as cases rather than as history.
 */

import { describe, expect, it } from 'vitest'
import {
  auditBlobReads,
  auditClientSecrets,
  auditScrubDerives,
  auditScrubWired,
  auditVanishedSites,
  blankStringLiterals,
  collectSources,
  NAMED_SITES,
  SCRUB_CALLERS,
  SECRET_PATHS,
  secretTokens,
  SCRUB_MODULE,
} from './audit-client-secrets'

const tokens = secretTokens()
const file = (rel: string, text: string) => [{ rel, text }]

describe('the audit, against the live tree', () => {
  it('is clean', () => {
    expect(auditClientSecrets(collectSources(['apps', 'packages']))).toEqual([])
  })

  it('scans a NON-ZERO population — a walker that found no files reports clean', () => {
    // The `vitest run <missing path>` failure in its other form: an instrument
    // that measured nothing must not look like one that measured everything.
    const sources = collectSources(['apps', 'packages'])
    expect(sources.length).toBeGreaterThan(500)
    expect(sources.some((f) => f.rel === SCRUB_MODULE)).toBe(true)
  })
})

describe('the vocabulary is derived and non-empty', () => {
  it('comes from the classification, and yields the tokens a scan can hunt', () => {
    // An empty vocabulary makes every census in this gate report zero findings
    // perfectly — the POD-305 "fails first if the matrix imports empty" guard.
    expect(SECRET_PATHS.length).toBeGreaterThan(0)
    expect(tokens).toContain('apiKeys')
    expect(tokens).toContain('linearApiKey')
    expect(tokens).toContain('telegramBotToken')
  })
})

describe('this gate can say NO', () => {
  it('fires when an adapter stops running the scrub — per adapter, not just the first', () => {
    const wired = `class S { static async open(){ const s = new S(); await s.hydrate(); await s.scrubSecrets(); return s } private async scrubSecrets(){} }`
    const unwired = `class S { static async open(){ const s = new S(); await s.hydrate(); return s } private async scrubSecrets(){} }`
    expect(auditScrubWired(SCRUB_CALLERS.map((rel) => ({ rel, text: wired })))).toEqual([])
    // ONE unwired among wired ones must still fire. The first draft's probe
    // passed a single file and could not distinguish this from "adapter absent".
    const mixed = auditScrubWired([
      { rel: SCRUB_CALLERS[0] as string, text: wired },
      { rel: SCRUB_CALLERS[1] as string, text: unwired },
    ])
    expect(mixed).toHaveLength(1)
    expect(mixed[0]?.where).toBe(SCRUB_CALLERS[1])
  })

  it('fires when the scrub restates the key list instead of deriving it', () => {
    expect(
      auditScrubDerives(
        file(SCRUB_MODULE, `export const P = settingsPathsInTier('server-secret')`),
      ),
    ).toEqual([])
    const restated = auditScrubDerives(
      file(SCRUB_MODULE, `export const P = ['apiKeys.openai', 'integrations.linearApiKey']`),
    )
    expect(restated.length).toBeGreaterThan(0)
  })

  it('fires on every SYNTAX FORM of a blob read, not just the dotted one', () => {
    // A detector that covers one spelling of the concept passes the others.
    const forms = [
      'const k = settings.apiKeys.openai',
      "const k = settings['apiKeys']['openai']",
      'const { apiKeys } = settings',
      'const k = s.integrations.linearApiKey',
      'const k = s.notifications.telegramBotToken',
      'const k = `${settings.apiKeys.openai}`',
    ]
    for (const form of forms) {
      expect(auditBlobReads(file('apps/server/src/x.ts', form), tokens), form).toHaveLength(1)
    }
  })

  it('does NOT fire on the correct keyed-store call, or on a comment', () => {
    // The mirror trap: a gate that flags the fix as loudly as the defect is a
    // gate someone silences. This is the case the first draft failed.
    for (const clean of [
      `const k = store.secrets.get('apiKeys.anthropic')`,
      `const t = this.secrets.getOrEmpty('notifications.telegramBotToken')`,
      `const k = store.secrets.getOrEmpty("integrations.linearApiKey")`,
      `telegramBotToken: () => store.secrets.getOrEmpty('notifications.telegramBotToken'),`,
      `const t = this.deps.telegramBotToken()`,
      `// the material used to live at settings.apiKeys.openai\nconst k = 1`,
      `/* and at integrations.linearApiKey */\nconst k = 1`,
    ]) {
      expect(auditBlobReads(file('apps/server/src/x.ts', clean), tokens), clean).toEqual([])
    }
  })

  it('does not fire on a NAMED site, and fires when one stops naming anything', () => {
    const named = NAMED_SITES[0]?.file as string
    expect(auditBlobReads(file(named, 'const k = settings.apiKeys.openai'), tokens)).toEqual([])
    // The ratchet's other direction: an absorbed surface must not read as
    // progress on a list nobody edited. Every site is supplied and exactly ONE
    // is emptied, so the finding names that site rather than the whole list.
    const allNaming = NAMED_SITES.map((s) => ({
      rel: s.file,
      text: 'const k = settings.apiKeys.openai',
    }))
    expect(auditVanishedSites(allNaming, tokens)).toEqual([])
    const oneEmptied = allNaming.map((f) =>
      f.rel === named ? { rel: f.rel, text: 'const x = 1' } : f,
    )
    const vanished = auditVanishedSites(oneEmptied, tokens)
    expect(vanished).toHaveLength(1)
    expect(vanished[0]?.where).toBe(named)
    expect(auditVanishedSites([], tokens).length).toBe(NAMED_SITES.length)
  })
})

describe('blankStringLiterals — the distinction the gate turns on', () => {
  it('blanks quoted contents and leaves template literals alone', () => {
    expect(blankStringLiterals(`get('apiKeys.openai')`)).not.toContain('apiKeys')
    expect(blankStringLiterals(`get("apiKeys.openai")`)).not.toContain('apiKeys')
    // Left alone ON PURPOSE: a member access inside an interpolation is a real
    // read, and hiding it would be the fails-OPEN direction.
    expect(blankStringLiterals('`${settings.apiKeys.openai}`')).toContain('apiKeys')
  })

  it('keeps the text the same length, so reported line numbers stay true', () => {
    const source = `const a = 'apiKeys.openai'\nconst b = settings.apiKeys.openai`
    const blanked = blankStringLiterals(source)
    expect(blanked.split('\n')).toHaveLength(2)
    expect(blanked.split('\n')[1]).toContain('.apiKeys')
  })
})
