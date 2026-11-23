/**
 * ONE LOGIN PER HOME IN THE MACHINE INVENTORY (credential management §10).
 *
 * Every harness that can hold logins in homes reports `logins`: `default`
 * first, the same answer as its `login` (the harness's own directory), then
 * one entry per Podium home of that harness. A home's entry is read from that
 * home alone, through the harness's directory variable, by the same detectors
 * the inventory uses for the default directory. The files only: a home's
 * state is whatever its login files say (a refused request is Task 13's).
 */

import {
  declaredValue,
  type HarnessEnvironment,
  type HarnessLogin,
  harnessAccount,
  manifestFor,
  withHomeScope,
} from '@podium/harness'
import type { HomeLogin, Inventory } from '@podium/model'
import { DEFAULT_HOME_ID, HOME_HARNESSES } from '@podium/protocol'
import type { MachineHomeFacts } from '../control/access'
import { ownLoginInPodiumHome } from '../session-harness-context'
import { type HarnessHome, isPodiumHome } from './registry'

export function withHomeLogins(
  inventory: Inventory,
  homes: readonly HarnessHome[],
  account: { home: string; env: HarnessEnvironment },
  /**
   * What the inventory found installed (managed installs §4.2). A harness
   * Podium alone installed here keeps its own login in the Podium home
   * (`ownLoginInPodiumHome`, POD-7494): its `login`, and the `default`
   * entry, are read there. Absent: every login is the person's folder's.
   */
  machine?: MachineHomeFacts,
): Inventory {
  return {
    ...inventory,
    agents: inventory.agents.map((agent) => {
      const podiumSide = machine ? ownLoginInPodiumHome(agent.kind, machine) : undefined
      const login = podiumSide ? podiumHomeLogin(homes, podiumSide, account) : agent.login
      if (!(HOME_HARNESSES as readonly string[]).includes(agent.kind))
        return login === agent.login ? agent : { ...agent, login }
      // A Podium home holds no login of a credential (managed installs §4.3):
      // credentials are passed in there, so it has no entry of its own. Where
      // it holds the machine's own login, that is the `default` entry.
      const own = homes
        .filter((home) => home.harness === agent.kind && !isPodiumHome(home))
        .sort((a, b) => a.homeId.localeCompare(b.homeId))
      return {
        ...agent,
        login,
        logins: [
          loginEntry(DEFAULT_HOME_ID, login),
          ...own.map((home) => loginEntry(home.homeId, readHomeLogin(home, account))),
        ],
      }
    }),
  }
}

/**
 * The machine's own login of `harness` where it lives in the Podium home: what
 * that home's login files say, or signed out while the home is not made yet.
 */
function podiumHomeLogin(
  homes: readonly HarnessHome[],
  harness: string,
  account: { home: string; env: HarnessEnvironment },
): HarnessLogin {
  const home = homes.find((candidate) => candidate.harness === harness && isPodiumHome(candidate))
  return home ? readHomeLogin(home, account) : { state: 'out' }
}

function loginEntry(
  homeId: string,
  login: HarnessLogin | Inventory['agents'][number]['login'],
): HomeLogin {
  return {
    homeId,
    state: login.state,
    ...(login.identity ? { identity: login.identity } : {}),
    ...(login.freshness !== undefined ? { freshness: login.freshness } : {}),
  }
}

/** What the login files in one home say. Never throws: unreadable is unknown. */
export function readHomeLogin(
  home: HarnessHome,
  account: { home: string; env: HarnessEnvironment },
): HarnessLogin {
  const manifest = manifestFor(home.harness)
  if (!manifest) return { state: 'unknown' }
  const scope = withHomeScope(
    home.harness,
    harnessAccount(home.harness, account.home, account.env),
    home.dir,
  )
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
