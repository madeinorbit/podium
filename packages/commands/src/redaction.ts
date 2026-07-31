/**
 * REDACTION, DRIVEN BY CONTRACT METADATA (POD-421, 3.7d).
 *
 * ADR 3 D5 made every contract declare `redaction: { reviewed, inputPaths,
 * outputPaths, note }`. POD-420 declared it on all six settings contracts and
 * said, at the `SECRET_REDACTION` cell, exactly what the declaration is FOR:
 *
 * > `value` is credential material: never logged, never echoed into an event,
 * > never included in an error, never persisted client-side.
 *
 * Nothing read that declaration. This module is the reader, and the three sites
 * that consume it are the three the brief names — the event log, the audit
 * record, and the ERROR path.
 *
 * ---------------------------------------------------------------------------
 * WHY A READER AND NOT A DETECTOR
 * ---------------------------------------------------------------------------
 *
 * The alternative — scan a payload for secret-SHAPED keys (`/token|key|secret/i`)
 * — is the shape ADR 1 D6 rejects and the shape POD-420's guard rejected for the
 * same reason: a detector that misses one key fails OPEN, silently, and the miss
 * is invisible in every green test. Here the contract has already NAMED its
 * sensitive paths, under review, as a required field. Reading the declaration
 * makes a newly-declared path redacted on the same commit, and an UNDECLARED one
 * a lint failure at `classificationErrors` rather than a leak.
 *
 * ---------------------------------------------------------------------------
 * WHICH WAY IT FAILS
 * ---------------------------------------------------------------------------
 *
 * FAIL CLOSED, in the one direction that matters: {@link redactForLog} takes a
 * contract, and {@link redactUnknownForLog} is what a caller must use when it
 * has only a NAME. A name with no contract redacts to {@link REDACTED} WHOLE —
 * not "passed through because there was nothing to redact". That is the POD-363
 * shape stated as a policy: an instrument that finds nothing must not thereby
 * approve everything.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT IS TWO-SIDED, AND ONLY ONE SIDE IS AT RISK
 * ---------------------------------------------------------------------------
 *
 * POD-419's finding, generalised in the ledger: *"the bug was not in the
 * SCRUBBING, it was in the REBUILDING — so no test of 'is the secret gone' could
 * ever have caught it."* A redactor walks and rebuilds, so it has that defect
 * class exactly. Its contract is therefore stated in two halves and tested in
 * two halves:
 *
 *   1. every declared path is replaced by {@link REDACTED};
 *   2. **everything else survives BYTE-IDENTICAL**, including the values a naive
 *      plain-object check mistakes for objects — `Date`, `Map`, `Set`, typed
 *      arrays, nested arrays.
 *
 * This walker therefore only descends into values it can prove are plain
 * objects or arrays; anything else is returned BY REFERENCE and never rebuilt.
 * A `Date` under a non-redacted key comes out the same `Date`, not `{}`.
 */

import type { AnyCommandContract, RedactionPolicy } from './contract'

/**
 * What a redacted value reads as.
 *
 * A CONSTANT STRING, and deliberately not `undefined` or a deleted key: an audit
 * record whose sensitive field is simply absent is indistinguishable from one
 * written by a build that never carried the field, and "we removed it" and "it
 * was never there" are different facts in a trail whose whole job is
 * accountability. The marker also makes the redaction GREPPABLE, which is how
 * `scripts/audit-settings-commands.ts` can assert a log line was redacted rather
 * than merely lacking a key.
 */
export const REDACTED = '[redacted]'

/** Which side of a command a value came from. The two are declared separately on
 *  every contract, so they are selected separately here rather than merged into
 *  one path list — an input path that leaked through the output list would be a
 *  redaction that reads as working. */
export type RedactionSide = 'input' | 'output'

const pathsFor = (policy: RedactionPolicy, side: RedactionSide): readonly string[] =>
  side === 'input' ? policy.inputPaths : policy.outputPaths

/**
 * A plain object — one whose prototype is `Object.prototype` or null.
 *
 * `typeof v === 'object'` is the check POD-419 found had been silently
 * destroying replica rows, because a `Date`, a `Map`, a `Set` and a typed array
 * all satisfy it and none of them survives being rebuilt key-by-key. The
 * prototype test is the one that says NO to all four.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Replace one dotted path inside a value, returning a NEW value and leaving the
 * original untouched.
 *
 * Returns the input BY REFERENCE when the path does not resolve, so a payload
 * with no redactable path is not rebuilt at all — the cheapest possible answer
 * and the one with no rebuild defect available to it.
 */
function replaceAtPath(value: unknown, segments: readonly string[]): unknown {
  const [head, ...rest] = segments
  if (head === undefined) return REDACTED
  if (Array.isArray(value)) {
    // An array index is addressable, but a path segment that is not an index
    // addresses nothing — and must not be invented as a key on the array.
    const index = Number(head)
    if (!Number.isInteger(index) || index < 0 || index >= value.length) return value
    const replaced = replaceAtPath(value[index], rest)
    if (replaced === value[index]) return value
    const out = value.slice()
    out[index] = replaced
    return out
  }
  if (!isPlainObject(value)) return value
  if (!Object.hasOwn(value, head)) return value
  const replaced = replaceAtPath(value[head], rest)
  if (replaced === value[head]) return value
  return { ...value, [head]: replaced }
}

/**
 * What a redaction DID, not merely what it produced.
 *
 * `redactedPaths` is the part that makes this auditable, and it exists because
 * of the standing obligation on this run: *"plant material and require the
 * redactor to NAME what it removed, rather than asserting a clean log."* A test
 * that only checks the output contains no material passes perfectly against a
 * redactor that dropped the payload on the floor, against one whose path list is
 * empty, and against one whose walker matched nothing (POD-363: *"a derivation
 * that finds nothing passes everything through unchanged"*). Requiring the
 * removal to be NAMED makes those three distinguishable from a real redaction.
 *
 * It is also what `settings/audit.ts` persists, so the record says which fields
 * were withheld rather than silently lacking them — the same reason
 * {@link REDACTED} is a marker and not a deleted key.
 */
export interface RedactionReport {
  readonly value: unknown
  /** The declared paths that actually RESOLVED and were replaced. A declared
   *  path that addressed nothing is deliberately absent: it removed nothing, and
   *  counting it would let a stale declaration inflate the evidence. */
  readonly redactedPaths: readonly string[]
}

/**
 * Apply a redaction policy to one side of one command's payload, reporting what
 * was removed.
 *
 * Exported for the tests and for callers that hold a policy without a contract;
 * ordinary callers want {@link redactForLog} or {@link redactReport}, which read
 * the policy off the contract so the two can never be paired wrongly.
 */
export function applyRedactionWithReport(
  policy: RedactionPolicy,
  side: RedactionSide,
  value: unknown,
): RedactionReport {
  let out = value
  const redactedPaths: string[] = []
  for (const path of pathsFor(policy, side)) {
    const next = replaceAtPath(out, path.split('.'))
    // Identity is the test for "did this path resolve": `replaceAtPath` returns
    // its input BY REFERENCE when the address does not exist, and a new object
    // when it does. A value-equality check would call a redaction of `undefined`
    // to `undefined` a no-op and under-report it.
    if (next !== out) redactedPaths.push(path)
    out = next
  }
  return { value: out, redactedPaths }
}

/** The value half of {@link applyRedactionWithReport}, for callers that do not
 *  persist a report. */
export function applyRedaction(
  policy: RedactionPolicy,
  side: RedactionSide,
  value: unknown,
): unknown {
  return applyRedactionWithReport(policy, side, value).value
}

/**
 * THE READER — redact a payload for a log, an audit record or an error body,
 * using the contract's own declaration.
 *
 * Takes the CONTRACT and not a name, so there is no lookup that can miss. The
 * miss-able form is {@link redactUnknownForLog}, which is separate precisely so
 * that "I could not find the contract" cannot be spelled the same way as "the
 * contract declared nothing".
 */
export function redactForLog(
  contract: AnyCommandContract,
  side: RedactionSide,
  value: unknown,
): unknown {
  return applyRedaction(contract.redaction, side, value)
}

/** {@link redactForLog} with the report — what an audit record persists, so the
 *  removal is a recorded fact rather than an absence a reader has to infer. */
export function redactReport(
  contract: AnyCommandContract,
  side: RedactionSide,
  value: unknown,
): RedactionReport {
  return applyRedactionWithReport(contract.redaction, side, value)
}

/**
 * The answer for a payload whose contract is NOT KNOWN.
 *
 * The whole value becomes {@link REDACTED}. This is the fail-closed arm and it
 * is a function rather than a `?? passthrough` at a call site, because the
 * permissive spelling of this is one character long and reviews as an oversight
 * rather than as a decision.
 *
 * It exists for a real caller: a settings write can be refused BEFORE its
 * contract is resolved (an unknown command name, a transport-level rejection),
 * and the refusal still wants a record. A record saying "something was refused
 * and its payload is redacted" is strictly better than one that logs an
 * unclassified payload, and strictly better than no record at all.
 */
export function redactUnknownForLog(): string {
  return REDACTED
}

/**
 * Redact an ERROR before it reaches a client or a log — the path the brief calls
 * *"the place redaction is usually forgotten"*.
 *
 * An error carries the sensitive material two ways, and this handles the second
 * one only, on purpose:
 *
 *   1. **Structured** — a `cause`, a zod issue list, an echoed input. That is
 *      what {@link redactForLog} covers, applied to whatever the thrower
 *      attached.
 *   2. **In the MESSAGE STRING** — `Invalid value "sk-ant-…"`. A path list
 *      cannot address a substring, so no declaration can redact it. The answer
 *      is not a regex over the message (a detector, failing open); it is that a
 *      message must never be BUILT from a redacted path. {@link
 *      messageMentionsRedactedValue} is the check that makes that testable, and
 *      `settings/audit.ts` runs it on every refusal it records.
 *
 * Stating the split is the point: a redactor that quietly did nothing about
 * case 2 would read as covering errors.
 */
export function messageMentionsRedactedValue(
  message: string,
  contract: AnyCommandContract,
  side: RedactionSide,
  payload: unknown,
): boolean {
  for (const path of pathsFor(contract.redaction, side)) {
    const value = readPath(payload, path.split('.'))
    // Only STRING material can appear verbatim in a message, and only a
    // non-empty one: `''` is a substring of every string, so treating it as a
    // hit would make this predicate answer `true` for every message and be
    // discarded as noise — the "floor a correct tree cannot meet" failure.
    if (typeof value !== 'string' || value === '') continue
    if (message.includes(value)) return true
  }
  return false
}

function readPath(value: unknown, segments: readonly string[]): unknown {
  let cursor = value
  for (const segment of segments) {
    if (Array.isArray(cursor)) {
      const index = Number(segment)
      if (!Number.isInteger(index)) return undefined
      cursor = cursor[index]
      continue
    }
    if (!isPlainObject(cursor)) return undefined
    cursor = cursor[segment]
  }
  return cursor
}
