/**
 * Builds the golden wire fixture corpus (POD-360). Pure and deterministic —
 * both the test and the `--update` entry point call this, so what CI compares
 * and what a developer regenerates can never drift apart.
 *
 * WHAT ONE CASE RECORDS, AND WHY
 * ------------------------------
 * `wire`         the exact JSON a peer would send. Pretty-printed one field per
 *                line, so a diff reads field-by-field.
 * `parseAdded`   fields the schema DEFAULTED in — present after parse, absent
 *                from the wire. This is the "a field was added" channel.
 * `parseChanged` fields whose value parse REWROTE. Always empty, and asserted
 *                empty: this is the transparency property the whole POD-301
 *                branded-id chain rests on. A brand is compile-time only, so
 *                parsing a wire value must hand back that value unchanged.
 * `parseDropped` fields the schema stripped.
 * `encoded`      the serialized bytes of the parsed value. The byte-identity
 *                anchor: a change here with an unchanged `wire` above it means
 *                serialization moved without any value moving — exactly the
 *                accident this suite exists to catch.
 */

import type { z } from 'zod'
import { encode } from '../messages/codec'
import { type CoveredSchema, coveredSchemas } from './registry'
import { type ParseDiff, parseDiff, sample, unionArity } from './sampler'

export interface WireCase {
  schema: string
  /** `minimal` (no optionals), `full` (every optional populated), or
   *  `full/arm<N>` for the Nth arm of the schema's unions. */
  variant: string
  wire: unknown
  parseAdded: ParseDiff['added']
  parseChanged: ParseDiff['changed']
  parseDropped: ParseDiff['dropped']
  encoded: string
  /** Set only when the sample failed to parse — a sampler or override bug. The
   *  fixture test asserts this is never present rather than skipping the case. */
  parseError?: string
}

export interface WireFamily {
  family: string
  /** Read by a human opening the file cold; not asserted on. */
  note: string
  cases: WireCase[]
}

const FAMILY_NOTE =
  'Golden wire fixtures (POD-360). Generated — regenerate with `bun run fixtures:wire:update`. ' +
  '`wire` is what a peer sends; `parseAdded` is what the schema defaults in; `parseChanged` must ' +
  'stay empty (parse is value-transparent); `encoded` pins the serialized bytes.'

const buildCase = (
  entry: CoveredSchema,
  variant: string,
  mode: 'minimal' | 'full',
  arm: number,
): WireCase => {
  const sampled = sample(entry.schema, { mode, arm })
  // `undefined` here is not "no sample". It is the sampler saying the schema is
  // OPTIONAL AT ITS ROOT and this is the `minimal` variant — a peer with nothing
  // to say sends no document at all. JSON has no term for that, and the previous
  // `sampled ?? null` wrote it down as `null`, which is a DIFFERENT claim and one
  // every such schema is right to refuse: `.optional()` admits `undefined` and
  // never `null`. The coercion invented a value and then recorded the schema's
  // correct rejection of it as a `parseError` (PDM-351).
  //
  // So absence stays absent. `JSON.stringify` drops an `undefined` property, so
  // the golden records the case with no `wire` line — which is what "nothing is
  // sent" looks like — and `toEqual` reads the two as equal. Nothing reaches the
  // wire, so there are no bytes to pin either.
  //
  // Until A2 (`68e8d23e0`) no exported schema was optional at its root, which is
  // why `sampler.ts` still said "which no message type is". `OwnerAsAssigneeField`
  // is the first, and absence there means "this payload predates the projection",
  // never "unassigned" — see `@podium/model`'s `fields/ownership.ts`.
  const absentAtRoot = sampled === undefined
  // Round-trip through JSON first: a fixture that cannot survive JSON is not a
  // wire fixture, and this is where that would surface.
  const wire = absentAtRoot ? undefined : (JSON.parse(JSON.stringify(sampled)) as unknown)

  const parsed = (entry.schema as z.ZodTypeAny).safeParse(wire)
  if (!parsed.success) {
    return {
      schema: entry.name,
      variant,
      wire,
      parseAdded: {},
      parseChanged: {},
      parseDropped: {},
      encoded: '',
      parseError: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    }
  }

  const diff = parseDiff(wire, parsed.data)
  return {
    schema: entry.name,
    variant,
    wire,
    parseAdded: diff.added,
    parseChanged: diff.changed,
    parseDropped: diff.dropped,
    // The real codec, not a local JSON.stringify: if encoding ever grows a step
    // (envelope, compression, key ordering), these bytes move with it. A case
    // that puts no document on the wire has no bytes to pin.
    encoded: absentAtRoot ? '' : encode(parsed.data as never),
  }
}

/** Every case for one schema: minimal, full, and one `full` per extra union arm. */
export const buildSchemaCases = (entry: CoveredSchema): WireCase[] => {
  const arms = unionArity(entry.schema)
  const cases: WireCase[] = [buildCase(entry, 'minimal', 'minimal', 0)]
  for (let arm = 0; arm < arms; arm++) {
    cases.push(buildCase(entry, arms === 1 ? 'full' : `full/arm${arm}`, 'full', arm))
  }
  return cases
}

/** The whole corpus, keyed by family (== golden filename stem). */
export const buildCorpus = (): WireFamily[] => {
  const byFamily = new Map<string, WireCase[]>()
  for (const entry of coveredSchemas()) {
    const bucket = byFamily.get(entry.family) ?? []
    bucket.push(...buildSchemaCases(entry))
    byFamily.set(entry.family, bucket)
  }
  return [...byFamily.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, cases]) => ({ family, note: FAMILY_NOTE, cases }))
}

/** Golden files are pretty-printed with a trailing newline — one field per line
 *  is the whole reason the diff is readable. */
export const serializeFamily = (family: WireFamily): string =>
  `${JSON.stringify(family, null, 2)}\n`
