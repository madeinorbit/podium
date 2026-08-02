/**
 * Deterministic zod → sample-value walker, for the golden wire fixtures
 * (POD-360, characterization step of POD-301's branded-id chain).
 *
 * WHY A WALKER RATHER THAN HAND-WRITTEN SAMPLES
 * ---------------------------------------------
 * The fixtures have to cover EVERY message family, and stay complete as the
 * protocol grows: a new message type that lands without a fixture is exactly
 * the gap a characterization suite exists to close. Hand-written samples decay
 * the moment someone adds a field. A walker over the schema itself cannot: the
 * sample is derived from the schema, so a new field shows up in the golden the
 * next time it is regenerated, and CI fails until someone looks at the diff.
 *
 * DETERMINISM IS THE WHOLE CONTRACT. No randomness, no clock, no counters that
 * depend on traversal order across files. Every scalar is derived from the
 * value's PATH, so the same schema always produces byte-identical output and a
 * golden diff means a schema change, never sampler weather.
 *
 * Values are also self-describing: a string is its own path
 * (`"IssueWire.humanQuestionAskedBy"`), which makes the golden files readable
 * as documentation of the wire shape and makes a mis-sorted field obvious.
 *
 * This walks the zod v3 classic API (`_def.typeName`); the package pins
 * zod ^3.24. It is test-only support code and is not exported from the
 * package index.
 */

import type { z } from 'zod'
import { SAMPLE_OVERRIDES } from './sample-overrides'

/** How many union arms / enum members a single schema is sampled across. The
 *  aggregate transport unions (ClientMessage, ServerMessage, …) are covered
 *  member-by-member instead of by arm index — see registry.ts. */
export const MAX_VARIANTS = 8

export type SampleMode = 'minimal' | 'full'

export interface SampleOptions {
  /** `minimal` omits every optional/defaulted field (so the golden records what
   *  parse DEFAULTS in); `full` populates them (so an added optional field shows
   *  up as a pure addition in the diff). */
  mode: SampleMode
  /** Which arm of every union — and which member of every enum — to choose.
   *  Clamped per-node, so arm 3 of a two-arm union is arm 1. */
  arm: number
}

// zod's internal defs are untyped from the outside; one cast at the boundary
// beats sprinkling `any` through the walker.
type Def = {
  typeName: string
  [key: string]: unknown
}

const defOf = (schema: z.ZodTypeAny): Def => (schema as unknown as { _def: Def })._def

const clamp = (index: number, length: number): number =>
  length <= 0 ? 0 : Math.min(Math.max(index, 0), length - 1)

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

interface StringCheck {
  kind: string
  value?: unknown
  offset?: boolean
}

/**
 * A string that satisfies the schema's format checks while staying derived from
 * the path. Formats win over the path (a `url` field must parse as a URL), but
 * the path is folded in wherever the format leaves room, so even a URL sample
 * says which field it came from.
 */
const sampleString = (schema: z.ZodTypeAny, path: string): string => {
  const checks = (defOf(schema).checks as StringCheck[] | undefined) ?? []
  const kinds = new Set(checks.map((check) => check.kind))

  let value = path
  if (kinds.has('uuid')) value = '00000000-0000-4000-8000-000000000000'
  else if (kinds.has('email')) value = 'fixture@example.test'
  else if (kinds.has('datetime')) value = '2026-01-02T03:04:05.000Z'
  else if (kinds.has('date')) value = '2026-01-02'
  else if (kinds.has('time')) value = '03:04:05'
  else if (kinds.has('url')) value = `https://example.test/${encodeURIComponent(path)}`
  else if (kinds.has('cuid') || kinds.has('cuid2') || kinds.has('ulid'))
    value = 'fixtureid000000000000000'
  else if (kinds.has('regex') || kinds.has('emoji') || kinds.has('ip')) {
    // No general way to satisfy an arbitrary pattern; the registry declares an
    // override for these, and the fixture test fails loudly if one is missing.
    value = path
  }

  for (const check of checks) {
    if (check.kind === 'startsWith' && typeof check.value === 'string') {
      if (!value.startsWith(check.value)) value = `${check.value}${value}`
    }
    if (check.kind === 'endsWith' && typeof check.value === 'string') {
      if (!value.endsWith(check.value)) value = `${value}${check.value}`
    }
    if (check.kind === 'includes' && typeof check.value === 'string') {
      if (!value.includes(check.value)) value = `${value}${check.value}`
    }
  }

  const max = checks.find((check) => check.kind === 'max')?.value
  if (typeof max === 'number' && value.length > max) value = value.slice(0, max)
  const min = checks.find((check) => check.kind === 'min')?.value
  if (typeof min === 'number' && value.length < min) value = value.padEnd(min, 'x')
  const length = checks.find((check) => check.kind === 'length')?.value
  if (typeof length === 'number') {
    value = value.length > length ? value.slice(0, length) : value.padEnd(length, 'x')
  }
  return value
}

interface NumberCheck {
  kind: string
  value?: number
  inclusive?: boolean
}

/** The smallest in-range value the checks allow, so numeric samples stay stable
 *  and obviously synthetic rather than looking like real measurements. */
const sampleNumber = (schema: z.ZodTypeAny, arm: number): number => {
  const checks = (defOf(schema).checks as NumberCheck[] | undefined) ?? []
  const int = checks.some((check) => check.kind === 'int')
  let value = int ? 1 : 1

  for (const check of checks) {
    if (check.kind === 'min' && typeof check.value === 'number') {
      const bound = check.inclusive === false ? check.value + (int ? 1 : 0.5) : check.value
      if (value < bound) value = bound
    }
  }
  // Vary with the arm so multi-variant cases don't all collapse to one number,
  // then clamp back under any max.
  value += arm
  for (const check of checks) {
    if (check.kind === 'max' && typeof check.value === 'number') {
      const bound = check.inclusive === false ? check.value - (int ? 1 : 0.5) : check.value
      if (value > bound) value = bound
    }
  }
  for (const check of checks) {
    if (check.kind === 'multipleOf' && typeof check.value === 'number' && check.value !== 0) {
      value = Math.ceil(value / check.value) * check.value
    }
  }
  return int ? Math.round(value) : value
}

// ---------------------------------------------------------------------------
// The walker
// ---------------------------------------------------------------------------

/** Sentinel meaning "this key is absent from the object", distinct from an
 *  explicit `undefined` value (which JSON.stringify also drops, but which would
 *  hide the difference between omitted and present-but-undefined). */
const ABSENT = Symbol('absent')

const sampleNode = (schema: z.ZodTypeAny, opts: SampleOptions, path: string): unknown => {
  // Closed-vocabulary / refined schemas the generic walker cannot satisfy —
  // see sample-overrides.ts. Checked before the typeName switch so nested
  // uses of the same schema instance (LayoutState.entityId → LayoutKeyField)
  // get the intentional fixture value, not a path-derived string that fails
  // parse.
  const override = SAMPLE_OVERRIDES.get(schema)
  if (override !== undefined) return override(opts, path)

  const def = defOf(schema)
  switch (def.typeName) {
    case 'ZodString':
      return sampleString(schema, path)
    case 'ZodNumber':
      return sampleNumber(schema, opts.arm)
    case 'ZodBigInt':
      return 1
    case 'ZodBoolean':
      return opts.arm % 2 === 0
    case 'ZodDate':
      return new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
    case 'ZodLiteral':
      return def.value
    case 'ZodEnum': {
      const values = def.values as string[]
      return values[clamp(opts.arm, values.length)]
    }
    case 'ZodNativeEnum': {
      const values = Object.values(def.values as Record<string, string | number>).filter(
        (value) => typeof value !== 'number' || true,
      )
      return values[clamp(opts.arm, values.length)]
    }
    case 'ZodNull':
      return null
    case 'ZodUndefined':
    case 'ZodVoid':
      return undefined
    case 'ZodAny':
    case 'ZodUnknown':
      // A structured placeholder rather than a string: `z.unknown()` fields on
      // this wire (SpawnMessage.observationCheckpoint) carry objects, and a
      // placeholder that is not an object would mis-characterize the shape.
      return { unknownFixture: path }
    case 'ZodArray': {
      const element = def.type as z.ZodTypeAny
      const exact = (def.exactLength as { value: number } | null)?.value
      const min = (def.minLength as { value: number } | null)?.value ?? 0
      const count = exact ?? Math.max(min, opts.mode === 'full' ? 1 : 0)
      return Array.from({ length: count }, (_unused, index) =>
        sampleNode(element, opts, `${path}[${index}]`),
      )
    }
    case 'ZodTuple': {
      const items = def.items as z.ZodTypeAny[]
      return items.map((item, index) => sampleNode(item, opts, `${path}[${index}]`))
    }
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, z.ZodTypeAny>)()
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(shape)) {
        const value = sampleNode(child, opts, path === '' ? key : `${path}.${key}`)
        if (value !== ABSENT) out[key] = value
      }
      return out
    }
    case 'ZodRecord': {
      if (opts.mode !== 'full') return {}
      const keySchema = def.keyType as z.ZodTypeAny
      const valueSchema = def.valueType as z.ZodTypeAny
      const key = String(sampleNode(keySchema, opts, `${path}.key`))
      return { [key]: sampleNode(valueSchema, opts, `${path}.${key}`) }
    }
    case 'ZodMap':
    case 'ZodSet':
      // Neither survives JSON, so neither appears on this wire. If one ever
      // does, the fixture test's parse assertion is what will say so.
      return opts.mode === 'full' ? [] : []
    case 'ZodUnion': {
      const options = def.options as z.ZodTypeAny[]
      const chosen = options[clamp(opts.arm, options.length)] as z.ZodTypeAny
      return sampleNode(chosen, opts, path)
    }
    case 'ZodDiscriminatedUnion': {
      const options = def.options as z.ZodTypeAny[]
      const chosen = options[clamp(opts.arm, options.length)] as z.ZodTypeAny
      return sampleNode(chosen, opts, path)
    }
    case 'ZodIntersection': {
      const left = sampleNode(def.left as z.ZodTypeAny, opts, path)
      const right = sampleNode(def.right as z.ZodTypeAny, opts, path)
      if (
        typeof left === 'object' &&
        left !== null &&
        typeof right === 'object' &&
        right !== null
      ) {
        return { ...(left as object), ...(right as object) }
      }
      return left
    }
    case 'ZodOptional':
      // The `minimal` variant is what characterizes DEFAULTING: leave the key
      // out and let the golden record what parse fills in.
      return opts.mode === 'full' ? sampleNode(def.innerType as z.ZodTypeAny, opts, path) : ABSENT
    case 'ZodNullable':
      // Nullable (unlike optional) is always present on the wire, so both
      // variants carry it — `minimal` takes the null branch, `full` the value.
      return opts.mode === 'full' ? sampleNode(def.innerType as z.ZodTypeAny, opts, path) : null
    case 'ZodDefault':
      return opts.mode === 'full' ? sampleNode(def.innerType as z.ZodTypeAny, opts, path) : ABSENT
    case 'ZodCatch':
      return sampleNode(def.innerType as z.ZodTypeAny, opts, path)
    case 'ZodBranded':
      // The property this whole fixture set exists to pin: a brand is a
      // compile-time construct, so the sample of a branded schema is exactly
      // the sample of the schema it wraps.
      return sampleNode(def.type as z.ZodTypeAny, opts, path)
    case 'ZodEffects':
      // refine/transform. The inner sample has to satisfy the refinement; where
      // it cannot, SAMPLE_OVERRIDES supplies a value (matched by schema identity
      // at the top of sampleNode) and the fixture test fails loudly via
      // parseError when an override is still missing.
      return sampleNode(def.schema as z.ZodTypeAny, opts, path)
    case 'ZodPipeline':
      return sampleNode(def.in as z.ZodTypeAny, opts, path)
    case 'ZodLazy':
      return sampleNode((def.getter as () => z.ZodTypeAny)(), opts, path)
    case 'ZodReadonly':
      return sampleNode(def.innerType as z.ZodTypeAny, opts, path)
    default:
      throw new Error(`wire fixtures: unsupported zod node ${def.typeName} at ${path || '<root>'}`)
  }
}

/** Sample one schema. Returns a plain JSON-able value (or `undefined` if the
 *  whole schema is optional at its root, which no message type is). */
export const sample = (schema: z.ZodTypeAny, opts: SampleOptions): unknown => {
  const value = sampleNode(schema, opts, '')
  return value === ABSENT ? undefined : value
}

/**
 * How many union arms this schema (recursively) contains — the number of `full`
 * variants worth generating for it. Enum arity deliberately does NOT drive this:
 * enums vary the arm index for free, but only a union changes the SHAPE, and
 * shape is what a wire characterization suite is pinning.
 */
export const unionArity = (schema: z.ZodTypeAny, seen = new Set<z.ZodTypeAny>()): number => {
  if (seen.has(schema)) return 1
  seen.add(schema)
  const def = defOf(schema)
  const children = (): z.ZodTypeAny[] => {
    switch (def.typeName) {
      case 'ZodObject':
        return Object.values((def.shape as () => Record<string, z.ZodTypeAny>)())
      case 'ZodArray':
        return [def.type as z.ZodTypeAny]
      case 'ZodTuple':
        return def.items as z.ZodTypeAny[]
      case 'ZodRecord':
        return [def.valueType as z.ZodTypeAny]
      case 'ZodOptional':
      case 'ZodNullable':
      case 'ZodDefault':
      case 'ZodCatch':
      case 'ZodReadonly':
        return [def.innerType as z.ZodTypeAny]
      case 'ZodBranded':
        return [def.type as z.ZodTypeAny]
      case 'ZodEffects':
        return [def.schema as z.ZodTypeAny]
      case 'ZodPipeline':
        return [def.in as z.ZodTypeAny]
      case 'ZodIntersection':
        return [def.left as z.ZodTypeAny, def.right as z.ZodTypeAny]
      case 'ZodUnion':
      case 'ZodDiscriminatedUnion':
        return def.options as z.ZodTypeAny[]
      default:
        return []
    }
  }
  const own =
    def.typeName === 'ZodUnion' || def.typeName === 'ZodDiscriminatedUnion'
      ? (def.options as z.ZodTypeAny[]).length
      : 1
  let deepest = 1
  for (const child of children()) deepest = Math.max(deepest, unionArity(child, seen))
  return Math.min(Math.max(own, deepest), MAX_VARIANTS)
}

// ---------------------------------------------------------------------------
// Parse diff — the "added field vs changed field" reader
// ---------------------------------------------------------------------------

export interface ParseDiff {
  /** Paths present after parse but absent from the wire input: what the schema
   *  DEFAULTS in. An additive change (POD-1075 / POD-1076) shows up here. */
  added: Record<string, unknown>
  /** Paths whose value parse REWROTE. Must always be empty: a wire codec that
   *  edits values in flight is not transparent, which is precisely what the
   *  branded-id flip must not become. */
  changed: Record<string, { wire: unknown; parsed: unknown }>
  /** Paths present on the wire but dropped by parse (stripped unknown keys). */
  dropped: Record<string, unknown>
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const walkDiff = (wire: unknown, parsed: unknown, path: string, out: ParseDiff): void => {
  if (isPlainObject(wire) && isPlainObject(parsed)) {
    for (const key of Object.keys(parsed)) {
      const child = path === '' ? key : `${path}.${key}`
      if (!(key in wire)) out.added[child] = parsed[key]
      else walkDiff(wire[key], parsed[key], child, out)
    }
    for (const key of Object.keys(wire)) {
      if (!(key in parsed)) out.dropped[path === '' ? key : `${path}.${key}`] = wire[key]
    }
    return
  }
  if (Array.isArray(wire) && Array.isArray(parsed)) {
    const length = Math.max(wire.length, parsed.length)
    for (let index = 0; index < length; index++) {
      const child = `${path}[${index}]`
      if (index >= wire.length) out.added[child] = parsed[index]
      else if (index >= parsed.length) out.dropped[child] = wire[index]
      else walkDiff(wire[index], parsed[index], child, out)
    }
    return
  }
  if (!Object.is(wire, parsed)) out.changed[path] = { wire, parsed }
}

/** Compare the wire input against what the schema parsed out of it. */
export const parseDiff = (wire: unknown, parsed: unknown): ParseDiff => {
  const out: ParseDiff = { added: {}, changed: {}, dropped: {} }
  walkDiff(wire, parsed, '', out)
  return out
}
