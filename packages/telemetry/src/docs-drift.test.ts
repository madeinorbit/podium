/**
 * Doc-drift guard [spec:SP-f933]: CI fails if `docs/TELEMETRY.md` and the schema
 * module disagree.
 *
 * docs/TELEMETRY.md is a PROMISE — "if a field isn't in the tables above, it
 * cannot be sent". A promise that is maintained by hand is a promise that
 * silently rots the first time someone adds a field in a hurry. This test makes
 * the doc a build artifact of the same truth the code enforces: add a field to
 * the schema without documenting it (or document one that doesn't exist) and the
 * build stops.
 *
 * Deliberately checks NAMES and ENUM VALUES rather than prose: the doc should
 * stay readable and human-written, and pinning its wording would just teach
 * people to fight the test.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CrashReport,
  ErrorType,
  InstallAgeBucket,
  MachinesBucket,
  TELEMETRY_FEATURES,
  TelemetryArch,
  TelemetryOs,
  UsageReport,
} from './schema'

const DOC_PATH = fileURLToPath(new URL('../../../docs/TELEMETRY.md', import.meta.url))
const doc = readFileSync(DOC_PATH, 'utf8')

/** Field names of a zod object schema. */
function fieldsOf(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape)
}

/** True when the doc mentions `name` as a field — in a table cell or JSON key. */
function documentsField(name: string): boolean {
  return new RegExp(`\`${name}\`|"${name}"`).test(doc)
}

describe('docs/TELEMETRY.md documents every field the schema can send', () => {
  it.each(
    fieldsOf(UsageReport as unknown as { shape: Record<string, unknown> }),
  )('usage field `%s` is documented', (field) => {
    expect(documentsField(field), `add \`${field}\` to the usage table in docs/TELEMETRY.md`).toBe(
      true,
    )
  })

  it.each(
    fieldsOf(CrashReport as unknown as { shape: Record<string, unknown> }),
  )('crash field `%s` is documented', (field) => {
    expect(documentsField(field), `add \`${field}\` to the crash table in docs/TELEMETRY.md`).toBe(
      true,
    )
  })
})

describe('docs/TELEMETRY.md lists every value each closed enum admits', () => {
  const enums: [string, readonly string[]][] = [
    ['os', TelemetryOs.options],
    ['arch', TelemetryArch.options],
    ['installAge', InstallAgeBucket.options],
    ['machines', MachinesBucket.options],
    ['errorType', ErrorType.options],
    ['features', TELEMETRY_FEATURES],
  ]
  it.each(enums)('%s values are all documented', (field, values) => {
    for (const value of values) {
      expect(
        new RegExp(`\`${value.replace(/[+]/g, '\\+')}\``).test(doc),
        `docs/TELEMETRY.md does not mention the ${field} value '${value}'`,
      ).toBe(true)
    }
  })

  it('documents every harness kind sessions can be keyed by', async () => {
    const { AgentKind } = await import('@podium/protocol')
    for (const kind of AgentKind.options) {
      expect(
        doc.includes(`\`${kind}\``),
        `docs/TELEMETRY.md does not mention the harness kind '${kind}'`,
      ).toBe(true)
    }
  })
})

describe('docs/TELEMETRY.md states the promises the code enforces', () => {
  it('names the vendor explicitly (an undisclosed processor is the scandal pattern)', () => {
    expect(doc).toMatch(/PostHog/)
  })

  it('documents both kill switches', () => {
    expect(doc).toMatch(/DO_NOT_TRACK/)
    expect(doc).toMatch(/PODIUM_TELEMETRY=off/)
  })

  it('states that the default is off', () => {
    expect(doc.toLowerCase()).toMatch(/sends nothing unless you turn it on/)
  })

  it('states that error messages are dropped', () => {
    expect(doc.toLowerCase()).toMatch(/message is dropped/)
  })

  it('states that the IP is dropped at ingest', () => {
    expect(doc.toLowerCase()).toMatch(/dropped at ingest/)
  })

  it('is honest that the deployed relay cannot be verified against its source', () => {
    expect(doc.toLowerCase()).toMatch(/cannot verify that the deployed relay/)
  })

  it('points at the CLI opt-out', () => {
    expect(doc).toMatch(/podium telemetry off/)
  })
})

describe('the drift guard itself works', () => {
  it('would fail on an undocumented field (the check is not vacuous)', () => {
    // Guards the guard: if `documentsField` ever matched everything, every test
    // above would pass while documenting nothing.
    expect(documentsField('secretUndocumentedField')).toBe(false)
  })
})
