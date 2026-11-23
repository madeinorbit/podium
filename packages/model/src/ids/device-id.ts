/**
 * DEVICE-MINTED RECORD IDS (ADR 12 D4).
 *
 * A synced record's id is its kind's prefix plus a random UUID, minted on the
 * device that creates it. The id is the create's identity from the first paint
 * on: the optimistic row and the server row share it, so nothing has to be
 * matched up afterwards. Human numbers (the 6241 in POD-6241, `#12`) are
 * LABELS the server fills in inside the same write; they are never identity
 * (ADR 2 D8).
 *
 * WHY A SEPARATE SCHEMA FROM THE `…IdField`s. Those stay permissive on purpose
 * (`brands.ts`): they parse every id already stored, whatever minted it, and an
 * existing row's id is not this check's business. This schema is for the one
 * place a NEW id enters: a create. There the server checks the whole value —
 * the prefix, and a version-4 UUID in canonical lowercase form — and refuses
 * anything else, including strings that look like human refs.
 *
 * The prefix follows the branded-id rule (two to four lowercase letters and an
 * underscore) or is empty: session ids have always been a bare UUID.
 */

import { z } from 'zod'

/** A device-minted id's prefix: the branded-id shape, or none. */
export type DeviceIdPrefix = `${string}_` | ''

const PREFIX_SHAPE = /^(?:[a-z]{2,4}_)?$/
const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

const requirePrefix = (prefix: DeviceIdPrefix): DeviceIdPrefix => {
  if (!PREFIX_SHAPE.test(prefix)) {
    throw new Error(
      `${JSON.stringify(prefix)} is not a valid device id prefix: two to four lowercase letters and an underscore, or none`,
    )
  }
  return prefix
}

/** The schema of a new id for a kind with this prefix (ADR 12 D4's shape check). */
export function deviceIdSchema(prefix: DeviceIdPrefix): z.ZodString {
  const shape = new RegExp(`^${requirePrefix(prefix)}${UUID_V4}$`)
  return z.string().regex(shape, `a new id is ${prefix ? `"${prefix}" and ` : ''}a random UUID`)
}

/**
 * Mint one on this device. `crypto.randomUUID` is a version-4 UUID. Reached
 * through `globalThis` and typed locally, as `ksuid.ts` does: this package
 * compiles under a lean `lib` with no DOM. A platform without it throws rather
 * than falling back to a weaker source; a record identity needs stated odds.
 */
export function mintDeviceId(prefix: DeviceIdPrefix): string {
  const source = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (!source || typeof source.randomUUID !== 'function') {
    throw new Error('mintDeviceId: no crypto.randomUUID on this platform')
  }
  return `${requirePrefix(prefix)}${source.randomUUID()}`
}

/** A new issue's id: `iss_<uuid>`. */
export const NewIssueId = deviceIdSchema('iss_')
/** A new session's id: a bare UUID, as sessions have always been. */
export const NewSessionId = deviceIdSchema('')
