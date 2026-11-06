/**
 * THE PLAIN COMMAND REGISTRY, COMPOSED (ADR 12 D8 and D9, POD-6593).
 *
 * Every command on the plain path is registered here, once, from its family's
 * declaration (`<family>/plain-family.ts`). The write-route generator
 * (`write-routes/routes.ts`) builds every transport's adapter from this registry;
 * a plain command that is not registered here has no route at all.
 *
 * A module-level instance, because a plain command holds no per-server state:
 * its handler selects its service from the context the transport hands it.
 */

import { ACCOUNT_PLAIN_FAMILY } from '../accounts/plain-family'
import { CLOUD_PLAIN_FAMILY } from '../cloud/plain-family'
import { HOST_PLAIN_FAMILY } from '../hosts/plain-family'
import {
  AUTH_PLAIN_FAMILY,
  SETUP_PLAIN_FAMILY,
  TELEMETRY_PLAIN_FAMILY,
} from '../instance/plain-family'
import { LOGS_PLAIN_FAMILY } from '../logs/plain-family'
import { MODEL_PLAIN_FAMILY } from '../models/plain-family'
import { PERF_PLAIN_FAMILY } from '../perf/plain-family'
import { SPEC_PLAIN_FAMILY } from '../specs/plain-family'
import { plainFamilyRegistrations } from './declare'
import { PlainCommandRegistry, type PlainRegistration } from './registry'

/** Every plain registration, family by family. */
export const PLAIN_REGISTRATIONS: readonly PlainRegistration[] = [
  ...plainFamilyRegistrations(ACCOUNT_PLAIN_FAMILY),
  ...plainFamilyRegistrations(AUTH_PLAIN_FAMILY),
  ...plainFamilyRegistrations(CLOUD_PLAIN_FAMILY),
  ...plainFamilyRegistrations(HOST_PLAIN_FAMILY),
  ...plainFamilyRegistrations(LOGS_PLAIN_FAMILY),
  ...plainFamilyRegistrations(MODEL_PLAIN_FAMILY),
  ...plainFamilyRegistrations(PERF_PLAIN_FAMILY),
  ...plainFamilyRegistrations(SETUP_PLAIN_FAMILY),
  ...plainFamilyRegistrations(SPEC_PLAIN_FAMILY),
  ...plainFamilyRegistrations(TELEMETRY_PLAIN_FAMILY),
]

export const PLAIN_COMMANDS = new PlainCommandRegistry()
for (const registration of PLAIN_REGISTRATIONS) PLAIN_COMMANDS.register(registration)
