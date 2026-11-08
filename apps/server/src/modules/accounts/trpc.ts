/**
 * THE DERIVED ACCOUNT SURFACE (POD-314) — `connect` and `disconnect` from their
 * contracts, `list` from the query table. The family's declaration is
 * `plain-family.ts`.
 */

import type { FamilyProcedures } from '../derived-family'
import { plainFamilyProcedures } from '../plain-command/family'
import { ACCOUNT_PLAIN_FAMILY } from './plain-family'
import { ACCOUNT_QUERIES } from './queries'
import type { ACCOUNT_COMMANDS_TRPC } from './registry'

export { assembleCodexServerAiMarker, type CodexServerAiMarker } from './plain-family'

export type AccountProcedures = FamilyProcedures<
  typeof ACCOUNT_COMMANDS_TRPC,
  typeof ACCOUNT_QUERIES
>

export const accountFamilyProcedures = (): AccountProcedures =>
  plainFamilyProcedures(ACCOUNT_PLAIN_FAMILY, ACCOUNT_QUERIES)
