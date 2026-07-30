/**
 * THE DERIVED SETTINGS WRITE SURFACE (POD-420) — `settings.updatePersonal`,
 * `settings.updateInstance`, `settings.setSecret` and `settings.clearSecret`,
 * produced from the joined table in `registry.ts` rather than written out in
 * `router.ts`.
 *
 * `router.ts` spreads the result into its `settings` router alongside the
 * procedures this issue does NOT migrate:
 *
 *  - `get` — a READ. It carries no contract because a `visibility` class
 *    describes what a command WRITES, and what this read RETURNS is about to
 *    change shape twice (POD-419's scrub, POD-421's presence projection).
 *  - `set` — the legacy blob write, kept because the sidebar, the auto-continue
 *    dialog and the engine still call it, and now refusing a secret change
 *    (`SettingsService.assertNoSecretChange`). Retiring it belongs with the
 *    client scrub that stops the blob carrying secrets at all.
 *  - `telegramSetupStart` / `telegramSetupPoll` — a stateful pairing ceremony
 *    over a third-party API, not a settings write with a payload. Named in the
 *    contract table's own note and counted by `scripts/audit-settings-commands.ts`
 *    as the two hand-written writes this family still allows, so the exception
 *    is visible rather than assumed.
 *
 * ---------------------------------------------------------------------------
 * MEMBERSHIP IS READ OFF THE TABLE, IN BOTH DIRECTIONS
 * ---------------------------------------------------------------------------
 *
 * A procedure appears here if and only if its contract declares `trpc` (ADR 3
 * D3, default-closed). {@link assertSurfaceMatchesContracts} checks that at
 * module load against the object that will actually be SERVED, in both
 * directions — a contract declaring `trpc` that produced no procedure, and a
 * procedure whose contract does not declare `trpc`, both throw before the server
 * answers a request.
 *
 * The second direction is not symmetry for its own sake: without it an EMPTY
 * surface satisfies every claim this file makes (POD-732 — "an empty router
 * satisfies every absence claim perfectly"). The first loop reads `built`, so an
 * empty object FAILS it.
 */

import type { TRPCMutationProcedure } from '@trpc/server'
import type { z } from 'zod'
import { mods, t } from '../../trpc'
import {
  isSettingsCommandExposedOn,
  SETTINGS_COMMANDS_TRPC,
  type SettingsCommandName,
  settingsCommandsOn,
  settingsProcKey,
} from './registry'

type SettingsProcedure<N extends SettingsCommandName> = TRPCMutationProcedure<{
  meta: unknown
  input: z.input<(typeof SETTINGS_COMMANDS_TRPC)[N]['contract']['input']>
  output: Awaited<ReturnType<(typeof SETTINGS_COMMANDS_TRPC)[N]['handler']>>
}>

/**
 * Every derived procedure, keyed by the PROC name the router serves it under —
 * a mapped type over the table, so a fifth settings write appears here without
 * anyone editing this declaration.
 */
export type SettingsProcedures = {
  [N in SettingsCommandName as N extends `settings.${infer P}` ? P : N]: SettingsProcedure<N>
}

function buildProcedure(name: SettingsCommandName): unknown {
  const { contract, handler } = SETTINGS_COMMANDS_TRPC[name]
  // The table is heterogeneous, so at THIS point the parsed input is the union
  // of all four schemas and TypeScript cannot pair it with the handler. It does
  // not need to: each pairing is checked where it is declared (the table is
  // `satisfies Record<SettingsContractName, SettingsCommand>` and each handler
  // carries a `satisfies SettingsHandler<…>` over its own contract's inferred
  // input), and `SettingsProcedures` re-derives the per-command types for the
  // client. This erasure is the one place the two meet.
  const run = handler as (svc: ReturnType<typeof mods>['settings'], input: unknown) => unknown
  return t.procedure
    .input(contract.input)
    .mutation(({ ctx, input }) => run(mods(ctx).settings, input))
}

/** The both-directions exposure check, against the object that will be served. */
function assertSurfaceMatchesContracts(built: Record<string, unknown>): void {
  for (const name of Object.keys(SETTINGS_COMMANDS_TRPC) as SettingsCommandName[]) {
    const present = built[settingsProcKey(name)] !== undefined
    if (isSettingsCommandExposedOn(name, 'trpc') && !present) {
      throw new Error(
        `settings contract ${name} declares trpc exposure but the derived router would not serve it`,
      )
    }
    if (!isSettingsCommandExposedOn(name, 'trpc') && present) {
      throw new Error(
        `the derived router serves ${name}, whose contract does not declare trpc exposure`,
      )
    }
  }
}

/** THE DERIVED PROCEDURES, spread into `router.ts`'s `settings` router. */
export function settingsFamilyProcedures(): SettingsProcedures {
  const built: Record<string, unknown> = {}
  for (const name of settingsCommandsOn('trpc')) built[settingsProcKey(name)] = buildProcedure(name)
  assertSurfaceMatchesContracts(built)
  return built as unknown as SettingsProcedures
}
