/**
 * The schema-lint [spec:SP-f933]: a structural proof that the payload cannot
 * carry free text.
 *
 * This is the test that makes "we never send your paths / repo names / prompts"
 * checkable rather than aspirational. It walks the actual zod tree — so it also
 * covers fields nobody has written yet. If you add a `z.string()` to a report,
 * this fails, and that is the intended outcome, not an obstacle: find an enum,
 * a bucket, or a regex, or accept that the data cannot be sent.
 */

import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  bucketInstallAge,
  bucketMachines,
  CrashReport,
  normalizeArch,
  normalizeErrorType,
  normalizeOs,
  normalizeVersion,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryReport,
  tierOf,
  UsageReport,
} from './schema'

/** A zod node with the v3 internals we introspect. */
type AnyDef = {
  typeName: string
  checks?: { kind: string }[]
  values?: unknown[]
  innerType?: { _def: AnyDef }
  type?: { _def: AnyDef }
  keyType?: { _def: AnyDef }
  valueType?: { _def: AnyDef }
  value?: unknown
  shape?: () => Record<string, { _def: AnyDef }>
}

/** Every string leaf in the tree, with the path it sits at. */
function stringLeaves(def: AnyDef, path: string, out: { path: string; def: AnyDef }[] = []) {
  switch (def.typeName) {
    case 'ZodString':
      out.push({ path, def })
      break
    case 'ZodObject':
      for (const [key, child] of Object.entries(def.shape?.() ?? {})) {
        stringLeaves(child._def, `${path}.${key}`, out)
      }
      break
    case 'ZodOptional':
    case 'ZodNullable':
      if (def.innerType) stringLeaves(def.innerType._def, path, out)
      break
    case 'ZodArray':
      if (def.type) stringLeaves(def.type._def, `${path}[]`, out)
      break
    case 'ZodRecord':
      // A record's KEYS must be an enum; a string-keyed record is a free-text
      // field wearing a hat (the key travels in the payload just like a value).
      if (def.keyType) stringLeaves(def.keyType._def, `${path}{key}`, out)
      if (def.valueType) stringLeaves(def.valueType._def, `${path}{value}`, out)
      break
    case 'ZodUnion':
      break
    default:
      break
  }
  return out
}

const CONSTRAINING_CHECKS = new Set(['regex', 'uuid', 'ulid', 'cuid', 'cuid2', 'emoji', 'length'])

describe('schema lint — enums and numbers only', () => {
  for (const [name, schema] of [
    ['UsageReport', UsageReport],
    ['CrashReport', CrashReport],
  ] as const) {
    it(`${name} admits no unconstrained string`, () => {
      const leaves = stringLeaves((schema as unknown as { _def: AnyDef })._def, name)
      const unconstrained = leaves.filter(
        (l) => !(l.def.checks ?? []).some((c) => CONSTRAINING_CHECKS.has(c.kind)),
      )
      expect(unconstrained.map((l) => l.path)).toEqual([])
    })

    it(`${name} rejects unknown keys (no smuggling a field past the schema)`, () => {
      const base =
        name === 'UsageReport' ? validUsage() : (validCrash() as unknown as Record<string, unknown>)
      const res = (schema as z.ZodTypeAny).safeParse({ ...base, note: 'hello from the repo' })
      expect(res.success).toBe(false)
    })
  }

  it('every record key type is an enum, never a string', () => {
    const usageShape = (UsageReport as unknown as { _def: AnyDef })._def.shape?.() ?? {}
    for (const key of ['sessions', 'features']) {
      const def = usageShape[key]?._def
      expect(def?.typeName).toBe('ZodRecord')
      expect(def?.keyType?._def.typeName).toBe('ZodEnum')
    }
  })
})

function validUsage() {
  return {
    schema: TELEMETRY_SCHEMA_VERSION,
    installId: '3f9c1a2e-0000-4000-8000-000000000000',
    version: '1.4.2',
    os: 'linux',
    arch: 'x64',
    installAge: '1-7d',
    machines: '2-5',
    sessions: { 'claude-code': 14, codex: 2 },
    features: { issues: true },
  }
}

function validCrash() {
  return {
    schema: TELEMETRY_SCHEMA_VERSION,
    installId: '3f9c1a2e-0000-4000-8000-000000000000',
    version: '1.4.2',
    os: 'linux',
    arch: 'x64',
    errorType: 'TypeError',
    frames: [{ file: 'apps/server/src/router.ts', line: 412, fn: 'handleSession' }],
  }
}

describe('the design doc payloads round-trip', () => {
  it('accepts the usage example from the design doc', () => {
    expect(UsageReport.safeParse(validUsage()).success).toBe(true)
  })
  it('accepts the crash example from the design doc', () => {
    expect(CrashReport.safeParse(validCrash()).success).toBe(true)
  })
  it('classifies each report to its tier without a discriminator field', () => {
    expect(tierOf(UsageReport.parse(validUsage()))).toBe('usage')
    expect(tierOf(CrashReport.parse(validCrash()))).toBe('crash')
  })
  it('the union accepts both and rejects a hybrid', () => {
    expect(TelemetryReport.safeParse(validUsage()).success).toBe(true)
    expect(TelemetryReport.safeParse(validCrash()).success).toBe(true)
    expect(TelemetryReport.safeParse({ ...validUsage(), ...validCrash() }).success).toBe(false)
  })
})

describe('field domains reject the things they exist to reject', () => {
  it('rejects a session key that is not a known harness', () => {
    const res = UsageReport.safeParse({ ...validUsage(), sessions: { 'my-secret-tool': 1 } })
    expect(res.success).toBe(false)
  })
  it('rejects a feature key outside the enum', () => {
    const res = UsageReport.safeParse({ ...validUsage(), features: { 'repo-acme-corp': true } })
    expect(res.success).toBe(false)
  })
  it('rejects a non-uuid installId (no hostname-derived ids)', () => {
    const res = UsageReport.safeParse({ ...validUsage(), installId: 'alices-macbook' })
    expect(res.success).toBe(false)
  })
  it('rejects a version carrying free text', () => {
    const res = UsageReport.safeParse({ ...validUsage(), version: '1.4.2 (/home/alice/podium)' })
    expect(res.success).toBe(false)
  })
  it('rejects a raw install age or machine count (buckets only)', () => {
    expect(UsageReport.safeParse({ ...validUsage(), installAge: '17 days' }).success).toBe(false)
    expect(UsageReport.safeParse({ ...validUsage(), machines: 3 }).success).toBe(false)
  })
  it('rejects an absolute path in a frame', () => {
    const res = CrashReport.safeParse({
      ...validCrash(),
      frames: [{ file: '/home/alice/secret-repo/index.ts', line: 1 }],
    })
    expect(res.success).toBe(false)
  })
  it('rejects a custom error class name (folded to Other by the normalizer)', () => {
    expect(CrashReport.safeParse({ ...validCrash(), errorType: 'AcmeCorpDbError' }).success).toBe(
      false,
    )
    expect(normalizeErrorType('AcmeCorpDbError')).toBe('Other')
  })
})

describe('normalizers fold rather than pass through', () => {
  it('folds unknown platforms/arches', () => {
    expect(normalizeOs('linux')).toBe('linux')
    expect(normalizeOs('freebsd')).toBe('other')
    expect(normalizeArch('arm64')).toBe('arm64')
    expect(normalizeArch('mips')).toBe('other')
  })
  it('folds an unrecognized version to dev rather than smuggling it', () => {
    expect(normalizeVersion('0.1.2-edge.1')).toBe('0.1.2-edge.1')
    expect(normalizeVersion(undefined)).toBe('dev')
    expect(normalizeVersion('built-from /home/alice/src')).toBe('dev')
  })
  it('folds standard error types through and everything else to Other', () => {
    expect(normalizeErrorType('TypeError')).toBe('TypeError')
    expect(normalizeErrorType(undefined)).toBe('Other')
  })
})

describe('bucketing (raw values never reach a payload)', () => {
  const day = 86_400_000
  it.each([
    [0, '0d'],
    [day - 1, '0d'],
    [day, '1-7d'],
    [7 * day, '1-7d'],
    [8 * day, '8-30d'],
    [30 * day, '8-30d'],
    [31 * day, '31-90d'],
    [90 * day, '31-90d'],
    [91 * day, '90d+'],
    [1000 * day, '90d+'],
  ])('bucketInstallAge(%i) = %s', (ms, expected) => {
    expect(bucketInstallAge(ms)).toBe(expected)
  })
  it.each([
    [0, '1'],
    [1, '1'],
    [2, '2-5'],
    [5, '2-5'],
    [6, '6-20'],
    [20, '6-20'],
    [21, '20+'],
    [5000, '20+'],
  ])('bucketMachines(%i) = %s', (count, expected) => {
    expect(bucketMachines(count)).toBe(expected)
  })
})
