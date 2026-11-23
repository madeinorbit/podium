/** THE VAULT SURFACE — `reset` from its contract, `status` from the query table. */

import type { FamilyProcedures } from '../derived-family'
import { plainFamilyProcedures } from '../plain-command/family'
import { VAULT_PLAIN_FAMILY } from './plain-family'
import { VAULT_QUERIES } from './queries'
import type { VAULT_COMMANDS_TRPC } from './registry'

export type VaultProcedures = FamilyProcedures<typeof VAULT_COMMANDS_TRPC, typeof VAULT_QUERIES>

export const vaultFamilyProcedures = (): VaultProcedures =>
  plainFamilyProcedures(VAULT_PLAIN_FAMILY, VAULT_QUERIES)
