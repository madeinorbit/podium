/**
 * THE CLOUD SURFACE (POD-314): the five writes from `CLOUD_CONTRACTS`,
 * `capabilities` and `runtime` from the query table.
 *
 * ON THE PLAIN PATH (ADR 12 D8, POD-6417). A cloud write changes nothing in
 * this server's database: the runtime lives on the cloud control plane, and the
 * provider is the network. So each runs through the plain entry (front door,
 * then the handler, online only, never recorded), not `sync.submit`. The one
 * synced write among them, `moveSession`'s local hibernate, is sent through
 * `sync.submit` as the caller once the runtime exists (`records.session`,
 * `desired: hibernated`).
 *
 * Stop and wake as edits of a desired state (ADR 12 D5 E1) need a cloud runtime
 * RECORD, which does not exist yet; until it does they are plain commands.
 *
 * The service is constructed PER REQUEST because its provider comes from the
 * context: `ctx.cloud` is absent on deployments with no cloud runtime, and
 * `CloudService` substitutes the disabled provider once at construction so no
 * method has to remember it.
 */

import type { FamilyProcedures } from '../derived-family'
import { plainFamilyProcedures } from '../plain-command/family'
import { CLOUD_PLAIN_FAMILY } from './plain-family'
import { CLOUD_QUERIES } from './queries'
import type { CLOUD_COMMANDS_TRPC } from './registry'

export type CloudProcedures = FamilyProcedures<typeof CLOUD_COMMANDS_TRPC, typeof CLOUD_QUERIES>

export const cloudFamilyProcedures = (): CloudProcedures =>
  plainFamilyProcedures(CLOUD_PLAIN_FAMILY, CLOUD_QUERIES)
