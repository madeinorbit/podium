/**
 * THE DERIVED ACCOUNT SURFACE (POD-314) — `connect` and `disconnect` from their
 * contracts, `list` from the query table.
 */

import { derivedFamilyProcedures, type FamilyProcedures } from '../derived-family'
import { ACCOUNT_QUERIES } from './queries'
import { ACCOUNT_COMMANDS_TRPC } from './registry'

export type AccountProcedures = FamilyProcedures<
  typeof ACCOUNT_COMMANDS_TRPC,
  typeof ACCOUNT_QUERIES
>

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `accounts` router. */
export const accountFamilyProcedures = (): AccountProcedures =>
  derivedFamilyProcedures({
    family: 'accounts',
    service: (state) => ({
      accounts: state.store.accounts,
      machines: state.store.machines,
      machineService: state.modules.machines,
      settings: state.modules.settings,
      nativeLogin: state.modules.nativeLogin,
      callerUserId: state.caller.userId,
    }),
    commands: ACCOUNT_COMMANDS_TRPC,
    queries: ACCOUNT_QUERIES,
  })
