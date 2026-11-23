/**
 * THE VENDOR'S SIGN-OUT IN A PODIUM HOME (credential management §8 "What
 * Podium leaves on machines, and cleanup"; epic plan Task 9).
 *
 * Before a home Podium made is deleted, the harness's own sign-out can run in
 * it, so the login it holds is withdrawn at the provider as well as removed
 * from the machine. It runs with the harness's directory variable pointed at
 * the home and nowhere else; the harness's own directory is never a target
 * (the registry refuses `default` before this is reached).
 *
 * The server asks for it per removal (`homeRemoveRequest.signOut`) and keeps
 * that switch off until the scope of a vendor sign-out is measured: a sign-out
 * that also ended other logins of the same account would sign a person out of
 * a login Podium did not make.
 */

import {
  type BoundCommand,
  harnessChildEnv,
  harnessCommand,
  harnessContext,
  manifestFor,
  noAgentTerms,
  type ResolvedHarnessInventory,
  withHarnessHome,
} from '@podium/harness'
import { defaultRunChild } from '../buffered-harness'
import type { DaemonContext } from '../control/context'
import { resolveManagementCredentialHome } from '../harness-management'
import type { HarnessHome } from './registry'

/** How long a sign-out may take before the home is deleted without it. */
export const HOME_SIGN_OUT_TIMEOUT_MS = 30_000

export type SignOutRunChild = (
  command: BoundCommand,
  opts: { timeout: number; maxBuffer: number; cwd?: string; env: NodeJS.ProcessEnv },
  stdin: string,
) => Promise<{ stdout: string }>

export interface SignOutIo {
  snapshot?: () => Promise<ResolvedHarnessInventory>
  runChild?: SignOutRunChild
}

/** Run the harness's sign-out in `home`. Never throws: a failure is reported. */
export async function signOutOfHome(
  ctx: Pick<DaemonContext, 'accountHome' | 'homeDir' | 'harnessRuntime'>,
  home: HarnessHome,
  io: SignOutIo = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const declared = manifestFor(home.harness)?.inventory.signOutCommand
  if (!declared) return { ok: false, error: `${home.harness} declares no sign-out command` }
  const runtime = ctx.harnessRuntime
  const snapshotFor = io.snapshot ?? (runtime ? () => runtime.current() : undefined)
  if (!snapshotFor) return { ok: false, error: 'no harness installation to sign out with' }
  try {
    const snapshot = await snapshotFor()
    const account = resolveManagementCredentialHome(ctx) ?? snapshot.commandEnvironment.machineHome
    // A home Podium made: Podium's install when there is one (managed
    // installs §6.1), the same binary the home's sessions run.
    const context = withHarnessHome(harnessContext(snapshot, home.harness, account, 'podium'), {
      id: home.homeId,
      dir: home.dir,
    })
    const command = harnessCommand(
      context,
      { args: [...declared.args], cwd: home.dir },
      noAgentTerms('harness sign-out: runs no agent'),
    )
    const { env } = harnessChildEnv(context, {})
    await (io.runChild ?? defaultRunChild)(
      command,
      { timeout: HOME_SIGN_OUT_TIMEOUT_MS, maxBuffer: 1024 * 1024, cwd: home.dir, env },
      '',
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
