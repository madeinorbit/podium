/**
 * THE PLAIN COMMAND REGISTRY, COMPOSED (ADR 12 D8 and D9, POD-6593).
 *
 * Every command on the plain path is registered here, once, from its family's
 * declaration (`<family>/plain-family.ts`). The write-route generator
 * (`write-routes/`) builds every transport's adapter from this registry;
 * a plain command that is not registered here has no route at all.
 *
 * One instance, because a plain command holds no per-server state: its handler
 * selects its service from the context the transport hands it.
 *
 * COMPOSED ON FIRST USE, not at module load. A family's registrations can live
 * in its route module (`updates/trpc.ts`), which imports the route generator,
 * which reads this registry: composing at load would read a family's table
 * before its module had finished loading. The first route built, at router
 * construction, composes it; every module is loaded by then.
 */

import { ACCOUNT_PLAIN_FAMILY } from '../accounts/plain-family'
import { CLOUD_PLAIN_FAMILY } from '../cloud/plain-family'
import { FLEET_PLAIN_REGISTRATIONS } from '../fleet/plain-family'
import { HOST_PLAIN_FAMILY } from '../hosts/plain-family'
import {
  AUTH_PLAIN_FAMILY,
  SETUP_PLAIN_FAMILY,
  TELEMETRY_PLAIN_FAMILY,
} from '../instance/plain-family'
import { LOCK_PLAIN_REGISTRATIONS } from '../lock/plain-family'
import { LOGS_PLAIN_FAMILY } from '../logs/plain-family'
import { MODEL_PLAIN_FAMILY } from '../models/plain-family'
import { OPERATION_PLAIN_REGISTRATIONS } from '../operations/plain-family'
import { PERF_PLAIN_FAMILY } from '../perf/plain-family'
import { SESSION_PLAIN_REGISTRATIONS } from '../sessions/plain-family'
import { SETTINGS_PLAIN_REGISTRATIONS } from '../settings/trpc'
import { SPEC_PLAIN_FAMILY } from '../specs/plain-family'
import { UPDATE_PLAIN_REGISTRATIONS } from '../updates/trpc'
import { plainFamilyRegistrations } from './declare'
import { PlainCommandRegistry, type PlainRegistration } from './registry'

/** Every plain registration, family by family. */
const registrations = (): readonly PlainRegistration[] => [
  ...plainFamilyRegistrations(ACCOUNT_PLAIN_FAMILY),
  ...plainFamilyRegistrations(AUTH_PLAIN_FAMILY),
  ...plainFamilyRegistrations(CLOUD_PLAIN_FAMILY),
  ...FLEET_PLAIN_REGISTRATIONS,
  ...plainFamilyRegistrations(HOST_PLAIN_FAMILY),
  ...LOCK_PLAIN_REGISTRATIONS,
  ...plainFamilyRegistrations(LOGS_PLAIN_FAMILY),
  ...plainFamilyRegistrations(MODEL_PLAIN_FAMILY),
  ...OPERATION_PLAIN_REGISTRATIONS,
  ...plainFamilyRegistrations(PERF_PLAIN_FAMILY),
  ...SESSION_PLAIN_REGISTRATIONS,
  ...plainFamilyRegistrations(SETUP_PLAIN_FAMILY),
  ...SETTINGS_PLAIN_REGISTRATIONS,
  ...plainFamilyRegistrations(SPEC_PLAIN_FAMILY),
  ...plainFamilyRegistrations(TELEMETRY_PLAIN_FAMILY),
  ...UPDATE_PLAIN_REGISTRATIONS,
]

let composed: PlainCommandRegistry | undefined

/** The plain command registry, composed once. */
export function plainCommands(): PlainCommandRegistry {
  if (composed === undefined) {
    const registry = new PlainCommandRegistry()
    for (const registration of registrations()) registry.register(registration)
    composed = registry
  }
  return composed
}
