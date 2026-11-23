/** THE CREDENTIALS SURFACE — writes from their contracts, `list` from the query table. */

import type { FamilyProcedures } from '../derived-family'
import { plainFamilyProcedures } from '../plain-command/family'
import type { CREDENTIAL_COMMANDS_TRPC } from './commands'
import { CREDENTIALS_PLAIN_FAMILY } from './plain-family'
import { CREDENTIAL_QUERIES } from './queries'

export type CredentialProcedures = FamilyProcedures<
  typeof CREDENTIAL_COMMANDS_TRPC,
  typeof CREDENTIAL_QUERIES
>

export const credentialFamilyProcedures = (): CredentialProcedures =>
  plainFamilyProcedures(CREDENTIALS_PLAIN_FAMILY, CREDENTIAL_QUERIES)
