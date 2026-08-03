/**
 * THE SHAPE THIS BUILD SPEAKS, AS SIXTEEN HEX DIGITS (POD-1610).
 *
 * ---------------------------------------------------------------------------
 * WHY A DIGEST WHEN THERE IS ALREADY A WIRE VERSION
 * ---------------------------------------------------------------------------
 *
 * `WIRE_VERSION` answers "can this peer be SERVED" and is deliberately COARSE:
 * `version.ts` says in as many words to bump it only on a breaking framing
 * change, because additive kinds and fields negotiate by capability instead.
 * That is the right rule and this does not change it — which is exactly why the
 * version could not have caught POD-1610. The bundle and the server agreed on
 * wire 2 the whole time they were failing to understand each other.
 *
 * This answers a different question: "was this bundle built from the same
 * protocol source as the server it is talking to?" Not compatible — IDENTICAL.
 * That is a much stronger claim than the wire needs for a rolling upgrade, and it
 * is deliberately NOT used to refuse a connection anywhere. It is used to tell a
 * human that the artefact in front of them is not the artefact the server was
 * built with, which is a build-plumbing fact and wants a build-plumbing answer
 * (rebuild), not a protocol negotiation.
 *
 * ---------------------------------------------------------------------------
 * COMPUTED, NEVER STAMPED — AND THAT IS THE PROPERTY THAT MAKES IT FIRE
 * ---------------------------------------------------------------------------
 *
 * It is derived at RUN TIME from the zod schemas themselves, on whichever side is
 * asking. Nothing generates it, nothing checks it in, so there is no file anyone
 * can forget to regenerate — the failure mode of every codegen'd fingerprint, and
 * a fingerprint that can go stale cannot detect staleness. A browser bundle and a
 * compiled server binary have no source tree in common to hash; they do both
 * carry these schema objects, so the schemas are the only thing both can measure.
 *
 * It is a structural walk of `ServerMessage` (what a client PARSES) and
 * `ClientMessage` (what it SENDS). Refinements, error messages and brands are
 * invisible to it — a brand is a compile-time construct with no wire presence,
 * and a refinement's identity is a closure, which is not hashable. Renamed
 * fields, added/removed union arms, changed literals and moved optionality all
 * are visible, and those are the changes that make one side unable to read the
 * other.
 */

import type { z } from 'zod'
import { ClientMessage } from './messages/client'
import { ServerMessage } from './messages/server'

// zod's internal defs are untyped from the outside; one cast at the boundary
// beats sprinkling `any` through the walker (same shape as the golden-fixture
// sampler's, which walks the same zod v3 classic API — the package pins ^3.24).
type Def = { typeName: string; [key: string]: unknown }
const defOf = (schema: z.ZodTypeAny): Def => (schema as unknown as { _def: Def })._def

/**
 * A canonical string for one schema node.
 *
 * Object keys are SORTED. Declaration order is not a wire property — two builds
 * that declare the same fields in a different order describe the same messages —
 * and leaving it in would make a pure refactor look like skew, which is how a
 * detector earns the right to be ignored.
 *
 * Union arms are NOT sorted: arm order is meaningful to a plain `z.union` (first
 * match wins), so a reordering there can genuinely change what parses.
 */
function signature(schema: z.ZodTypeAny, seen: Set<z.ZodTypeAny>): string {
  if (seen.has(schema)) return '<cycle>'
  seen.add(schema)
  const def = defOf(schema)
  const sig = (child: unknown): string => signature(child as z.ZodTypeAny, seen)
  const out = ((): string => {
    switch (def.typeName) {
      case 'ZodObject': {
        const shape = (def.shape as () => Record<string, z.ZodTypeAny>)()
        const keys = Object.keys(shape).sort()
        return `{${keys.map((k) => `${k}:${sig(shape[k])}`).join(',')}}`
      }
      case 'ZodDiscriminatedUnion': {
        const options = def.options as z.ZodTypeAny[]
        return `du(${String(def.discriminator)})[${options.map(sig).join('|')}]`
      }
      case 'ZodUnion':
        return `u[${(def.options as z.ZodTypeAny[]).map(sig).join('|')}]`
      case 'ZodArray':
        return `[${sig(def.type)}]`
      case 'ZodTuple':
        return `t[${(def.items as z.ZodTypeAny[]).map(sig).join(',')}]`
      case 'ZodRecord':
        return `rec<${sig(def.keyType)},${sig(def.valueType)}>`
      case 'ZodMap':
        return `map<${sig(def.keyType)},${sig(def.valueType)}>`
      case 'ZodSet':
        return `set<${sig(def.valueType)}>`
      case 'ZodIntersection':
        return `&(${sig(def.left)},${sig(def.right)})`
      case 'ZodLiteral':
        return `lit(${JSON.stringify(def.value)})`
      case 'ZodEnum':
        return `enum(${(def.values as string[]).join(',')})`
      case 'ZodNativeEnum':
        return `nenum(${Object.values(def.values as Record<string, unknown>).join(',')})`
      case 'ZodOptional':
        return `${sig(def.innerType)}?`
      case 'ZodNullable':
        return `${sig(def.innerType)}|null`
      case 'ZodDefault':
        return `${sig(def.innerType)}=`
      case 'ZodCatch':
        return `catch(${sig(def.innerType)})`
      // A brand is compile-time only and a refine/transform's predicate is a
      // closure: neither is a wire shape, so both are their inner schema.
      case 'ZodBranded':
        return sig(def.type)
      case 'ZodEffects':
        return sig(def.schema)
      case 'ZodPipeline':
        return sig(def.in)
      case 'ZodReadonly':
        return sig(def.innerType)
      case 'ZodLazy':
        return sig((def.getter as () => z.ZodTypeAny)())
      default:
        // Scalars (ZodString/Number/Boolean/…) and anything this walk has not met.
        // The typeName alone is the right signature for a scalar; for an unmet node
        // it degrades to "some node of this kind", which is coarse but never wrong.
        return def.typeName
    }
  })()
  seen.delete(schema)
  return out
}

/**
 * FNV-1a, twice, at two offsets — 64 bits of fingerprint in 16 hex digits.
 *
 * Hand-rolled rather than `crypto`: this must produce the same digits inside a
 * browser bundle, a bun server and a node test, and the one hash API all three
 * share (`crypto.subtle`) is async, which would push the asynchrony into every
 * caller for no gain. Collisions matter only against ACCIDENTAL drift here —
 * nothing security-bearing depends on this value, and nothing should.
 */
function fnv1a(text: string, offset: number): string {
  let hash = offset >>> 0
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** The canonical structural signature of any one schema. Exported so a test can
 *  show that a changed shape changes it — a digest whose sensitivity is not
 *  demonstrable is a green light nobody has checked can turn red. */
export function schemaSignature(schema: z.ZodTypeAny): string {
  return signature(schema, new Set())
}

/** The canonical signature string the digest is taken over. Exported for the
 *  human staring at two machines that disagree, where the diff is the answer. */
export function wireSchemaSignature(): string {
  return `S=${schemaSignature(ServerMessage)}\nC=${schemaSignature(ClientMessage)}`
}

/**
 * The file the web build drops beside index.html, and the server reads back.
 *
 * The NAME lives here, next to the value it carries, because the two ends of this
 * check are in different apps built by different toolchains (a vite plugin writes
 * it, a hono handler reads it) and a filename agreed by two string literals is a
 * filename that eventually disagrees.
 */
export const BUILD_STAMP_FILE = 'podium-build.json'

/** What {@link BUILD_STAMP_FILE} contains. Every field optional: it is read from
 *  disk, possibly written by an older build, and a reader that assumes a shape
 *  it did not verify is how a staleness check crashes on the stale case. */
export interface BuildStamp {
  /** {@link wireSchemaDigest} as computed by the build. */
  wireSchemaDigest?: string
  /** WIRE_VERSION at build time — informational; negotiation is elsewhere. */
  wireVersion?: number
  /** ISO timestamp, for the human reading the warning. */
  builtAt?: string
}

let cached: string | undefined

/**
 * The digest this build would advertise. Memoized: the walk is a few thousand
 * nodes, cheap once and pointless twice, and it cannot change during a process's
 * life — the schemas are module-level constants.
 */
export function wireSchemaDigest(): string {
  if (cached === undefined) {
    const text = wireSchemaSignature()
    cached = fnv1a(text, 0x811c9dc5) + fnv1a(text, 0x01000193)
  }
  return cached
}
