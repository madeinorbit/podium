/**
 * THE DERIVED INSTANCE SURFACES (POD-314) — `setup`, `auth` and `telemetry`,
 * three routers over one `InstanceService`.
 *
 * The service is constructed PER REQUEST from the state bundle rather than held
 * as a module singleton, because its one dependency — the telemetry emitter — is
 * a property of the assembled server and is absent in tests and in the in-process
 * MCP caller. Constructing it here keeps `telemetry.preview` returning `null`
 * in exactly the cases it always did.
 */

import type { FamilyProcedures } from '../derived-family'
import { plainFamilyProcedures } from '../plain-command/family'
import { AUTH_PLAIN_FAMILY, SETUP_PLAIN_FAMILY, TELEMETRY_PLAIN_FAMILY } from './plain-family'
import { AUTH_QUERIES, SETUP_QUERIES, TELEMETRY_QUERIES } from './queries'
import type { AUTH_COMMANDS_TRPC, SETUP_COMMANDS_TRPC, TELEMETRY_COMMANDS_TRPC } from './registry'

export type SetupProcedures = FamilyProcedures<typeof SETUP_COMMANDS_TRPC, typeof SETUP_QUERIES>
export type AuthProcedures = FamilyProcedures<typeof AUTH_COMMANDS_TRPC, typeof AUTH_QUERIES>
export type TelemetryProcedures = FamilyProcedures<
  typeof TELEMETRY_COMMANDS_TRPC,
  typeof TELEMETRY_QUERIES
>

/** First-run "make this instance reachable" flow (Tailscale-first). The web setup
 *  screen reaches these instead of importing @podium/runtime/setup directly,
 *  which would pull node:fs (via ./config) into the browser bundle. */
export const setupFamilyProcedures = (): SetupProcedures =>
  plainFamilyProcedures(SETUP_PLAIN_FAMILY, SETUP_QUERIES)

/** Manage the human-client login password on an already-configured instance.
 *  These run under the same /trpc guard, so once a password is set you must be
 *  logged in to reach them; the CURRENT password is ALSO required for a
 *  change/disable, which defends against a hijacked session. */
export const authFamilyProcedures = (): AuthProcedures =>
  plainFamilyProcedures(AUTH_PLAIN_FAMILY, AUTH_QUERIES)

/** Telemetry [spec:SP-f933] — Settings → Privacy's backing surface.
 *  Reads/writes config.json (D8), NOT the settings blob, so the web toggles and
 *  `podium telemetry off` are the same switch. */
export const telemetryFamilyProcedures = (): TelemetryProcedures =>
  plainFamilyProcedures(TELEMETRY_PLAIN_FAMILY, TELEMETRY_QUERIES)
