/**
 * WHERE THE MACHINE'S OWN LOGIN OF A HARNESS LIVES (managed installs §4.2,
 * POD-7494, POD-7496).
 *
 * The machine's own login is the one a session on no credential (the
 * `default` home) runs on. It is the person's own folder, except where Podium
 * keeps it in the Podium home ({@link ownLoginInPodiumHome}). Every reader of
 * that login takes the answer from here, so none of them derives it again:
 * session launches and the native sign-in terminal (`sessionHomeFor`), the
 * inventory's login (`withHomeLogins`), the model list, quota and usage of
 * the `default` account (`ownLoginHomes`), and a conversation moved to or from
 * `default` (`placementHomeId`).
 */

import {
  declaredValue,
  type HarnessAccountScope,
  type HarnessEnvironment,
  type HarnessExecutableSnapshot,
  type HarnessLogin,
  harnessAccount,
  harnessHomeVariable,
  manifestFor,
  withHomeScope,
} from '@podium/harness'
import type { AgentKind } from '@podium/model'
import { HOME_HARNESSES, HomeHarness } from '@podium/protocol'
import type { MachineHomeFacts } from '../control/access'
import type { HarnessHome, HomeRegistry } from './registry'

/** Where a login read finds the Podium homes and the account it answers for. */
export interface OwnLoginSource {
  homes?: Pick<HomeRegistry, 'podiumHomeAt'> | undefined
  /** The account HOME and machine env the harness's folders resolve from. */
  account?: { home: string; env: HarnessEnvironment } | undefined
}

/**
 * What a snapshot says of the machine's installs (managed installs §4.2), and,
 * given `logins`, what the login files on each side of the machine's own login
 * say, read when the rule asks.
 */
export function snapshotHomeFacts(
  snapshot: Pick<HarnessExecutableSnapshot, 'managed'> &
    Partial<Pick<HarnessExecutableSnapshot, 'executables'>>,
  logins?: OwnLoginSource,
): MachineHomeFacts {
  const account = logins?.account
  return {
    managedInstall: (kind) => snapshot.managed?.has(kind) ?? false,
    externalInstall: (kind) => snapshot.executables?.has(kind) ?? false,
    ...(account
      ? {
          ownLogin: (kind, side) => {
            const scope = harnessAccount(kind, account.home, account.env)
            if (side === 'person') return readLoginIn(kind, scope).state
            const home = logins?.homes?.podiumHomeAt(kind)
            return home ? readLoginIn(kind, withHomeScope(kind, scope, home.dir)).state : 'out'
          },
        }
      : {}),
  }
}

/**
 * THE MACHINE'S OWN LOGIN IN THE PODIUM HOME (POD-7494, POD-7496; managed
 * installs §4.2). For a harness that keeps its state in a folder a variable
 * moves, with Podium's install on this machine:
 *
 * - Podium's install alone: the person has no install of their own to run,
 *   and Podium's install never runs in the person's folder (M9). The
 *   machine's own login is the Podium home's.
 * - Both installs: the person's own login stays theirs (their binary, their
 *   folder), except while their folder is signed out and the Podium home
 *   holds a sign-in. That is a person who signed in to Podium's copy and
 *   installed their own later: their sessions keep the login they made
 *   instead of turning signed out. Once they sign in to their own copy, it is
 *   theirs again. Without the login facts the person's side keeps it.
 *
 * A harness without a folder variable shares one folder either way (§4.7).
 * Returns the harness when its own login is the Podium home's.
 */
export function ownLoginInPodiumHome(
  kind: AgentKind,
  machine: MachineHomeFacts,
): HomeHarness | undefined {
  const harness = HomeHarness.safeParse(kind)
  if (!harness.success || !harnessHomeVariable(harness.data)) return undefined
  if (!machine.managedInstall(harness.data)) return undefined
  if (!machine.externalInstall?.(harness.data)) return harness.data
  const signedInToPodiumCopyOnly =
    machine.ownLogin?.(harness.data, 'person') === 'out' &&
    machine.ownLogin(harness.data, 'podium') === 'in'
  return signedInToPodiumCopyOnly ? harness.data : undefined
}

/**
 * The home the machine's own login of `kind` lives in when it is not the
 * person's folder: the Podium home, made or not ({@link HomeRegistry.podiumHomeAt}),
 * so a read of a home not made yet finds nothing rather than the person's
 * folder.
 */
export function ownLoginHome(
  homes: Pick<HomeRegistry, 'podiumHomeAt'> | undefined,
  kind: AgentKind,
  machine: MachineHomeFacts,
): HarnessHome | undefined {
  const harness = ownLoginInPodiumHome(kind, machine)
  return harness && homes ? homes.podiumHomeAt(harness) : undefined
}

/**
 * Every harness whose own login lives in the Podium home now, with that home's
 * folder: what an account read of the `default` login (quota, usage, the
 * model list) moves its scope into (`AccountReadScope.homeDirs`).
 */
export function ownLoginHomes(
  homes: Pick<HomeRegistry, 'podiumHomeAt'> | undefined,
  machine: MachineHomeFacts,
): Partial<Record<HomeHarness, string>> {
  const dirs: Partial<Record<HomeHarness, string>> = {}
  for (const harness of HOME_HARNESSES) {
    const home = ownLoginHome(homes, harness, machine)
    if (home) dirs[harness] = home.dir
  }
  return dirs
}

/** What the login files under one account scope say. Never throws: unreadable is unknown. */
export function readLoginIn(kind: string, scope: HarnessAccountScope): HarnessLogin {
  const manifest = manifestFor(kind)
  if (!manifest) return { state: 'unknown' }
  let detected: HarnessLogin
  try {
    detected = manifest.inventory.detectLogin(scope.home, scope.env)
  } catch {
    return { state: 'unknown' }
  }
  try {
    const identity =
      detected.identity ?? declaredValue(manifest.inventory.loginIdentity)?.(scope.home, scope.env)
    return identity ? { ...detected, identity } : detected
  } catch {
    return detected
  }
}
