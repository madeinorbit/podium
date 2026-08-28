// Part of the Agent Runtime contract (POD-1761 W1, POD-3081). See ./index.ts for
// the surface's five governing rules and the core-vs-extended tier boundary.

import type { ConfigureCapability, ConfigureRequest } from './capabilities.js'
import type { ModelPolicy } from './session-spec.js'
import type { Refusal } from './turns.js'

/**
 * THE SHARED HALF OF `configure()`, so three drivers cannot disagree about what
 * a sticky change MEANS.
 *
 * What varies per driver is one thing only: which values that harness can take.
 * Everything else — which fields are changeable, what an undeclared field
 * answers, what an empty request answers, what the new policy is — is contract
 * behaviour, and a driver that re-derived it would be free to drift. The
 * conformance property reads this module's rules through the driver, so a
 * divergence is a failing test rather than a footnote in a review.
 *
 * NOT A BASE CLASS AND NOT A MIXIN. It is a pure function from (declared
 * capability, current policy, request) to (refusal | next policy). Applying the
 * next policy — writing it onto the live session and persisting it so a reload
 * or an adoption still carries it — stays in the driver, because only the driver
 * knows where its session state lives.
 */

/** A driver's own answer to "can this harness take this value?". Returns the
 *  reason it cannot, or undefined when it can. The STRING is user-facing: it is
 *  the detail on an `invalid_value` refusal and a person picks a different value
 *  after reading it, so name the accepted set rather than restating the input. */
export interface ConfigureValueChecks {
  model?(value: string): string | undefined
  effort?(value: string): string | undefined
  permissionMode?(value: string): string | undefined
}

/** Every field of a `ConfigureRequest`, so a fold over them cannot miss one — the
 *  same totality the capability axes get. A field added to the request type
 *  without a member here is a compile error. */
export const CONFIGURE_FIELDS = [
  'model',
  'effort',
  'permissionMode',
] as const satisfies readonly (keyof ConfigureRequest)[]

/** Fields in `ConfigureRequest` that {@link CONFIGURE_FIELDS} forgot. `never`
 *  when the list is complete, which is what the check below requires. */
type UnlistedConfigureField = Exclude<keyof ConfigureRequest, (typeof CONFIGURE_FIELDS)[number]>
const _configureFieldListIsComplete: UnlistedConfigureField extends never ? true : never = true
void _configureFieldListIsComplete

/**
 * The fields this request actually asks to change.
 *
 * ABSENT AND EMPTY ARE DIFFERENT, and this is where the difference is decided:
 * `{}` asks for nothing, while `{ model: '' }` asks for something impossible.
 * The first is a caller bug worth naming; the second is a value the harness
 * cannot take. Both refuse, with different reasons, because a caller retries
 * exactly one of them.
 */
export function requestedConfigureFields(
  request: ConfigureRequest,
): readonly (keyof ConfigureRequest)[] {
  return CONFIGURE_FIELDS.filter((field) => request[field] !== undefined)
}

/**
 * Decide one `configure()` against what the driver declared it can do.
 *
 * The order of the checks is deliberate and is itself pinned by the conformance
 * suite. An UNDECLARED field is refused before its value is looked at, because a
 * driver that cannot change effort at all should say so whatever the value was —
 * validating first would answer `invalid_value` for a field that is not a field
 * here, which sends the caller off to try another effort level on a driver that
 * has none.
 */
export function decideConfigure(input: {
  declared: ConfigureCapability
  request: ConfigureRequest
  policy: ModelPolicy
  checks?: ConfigureValueChecks
}): Refusal | { ok: true; policy: ModelPolicy; changed: readonly (keyof ConfigureRequest)[] } {
  const { declared, request, policy, checks } = input
  const asked = requestedConfigureFields(request)

  if (asked.length === 0) {
    return {
      reason: 'invalid_value',
      detail: 'configure was given no field to change',
    }
  }

  const undeclared = asked.filter((field) => !declared.fields.includes(field))
  if (undeclared.length > 0) {
    return {
      reason: 'unsupported',
      detail: `this driver cannot change ${undeclared.join(' or ')} on a running session; it can change ${declared.fields.length > 0 ? declared.fields.join(' and ') : 'nothing'}`,
    }
  }

  for (const field of asked) {
    const value = request[field] as string
    // A value that is only whitespace is rejected for EVERY field before any
    // harness check runs. No harness has a setting named the empty string, and
    // letting one through would make the session's policy unreadable rather
    // than unset — the difference between "no model chosen" and "the model is
    // called nothing" is one nobody downstream can recover.
    if (value.trim() === '') {
      return { reason: 'invalid_value', detail: `${field} cannot be empty` }
    }
    const complaint = checks?.[field]?.(value)
    if (complaint !== undefined) return { reason: 'invalid_value', detail: complaint }
  }

  return {
    ok: true,
    // THE OTHER FIELDS SURVIVE. A configure naming only `effort` must not clear
    // the model the session was launched with: the request is a patch on the
    // policy, and treating it as a replacement is how a control that changes one
    // setting silently resets the rest.
    policy: {
      ...policy,
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
    },
    changed: asked,
  }
}

/**
 * The one check every driver here wants and none of them should spell twice.
 *
 * A model name or an effort level is a single token on all four harnesses. A
 * value with a space in it is a caller that concatenated something — a label, a
 * flag, a second field — and the harm is durable rather than immediate: it is
 * accepted, written to the session's sticky policy, and then fails at the
 * provider on every turn afterwards with an error that names the string but not
 * who set it.
 *
 * `noun` is user-facing. It completes "…is not a <noun>", so write it as the
 * thing the value was supposed to be.
 */
export function noWhitespaceCheck(noun: string): (value: string) => string | undefined {
  return (value) =>
    /\s/.test(value)
      ? `${JSON.stringify(value)} is not a ${noun}: it contains whitespace`
      : undefined
}
