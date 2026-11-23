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
import { type HarnessHome, isPodiumHome } from './registry'

export function withHomeLogins(
  inventory: Inventory,
  homes: readonly HarnessHome[],
  account: { home: string; env: HarnessEnvironment },
): Inventory {
  return {
    ...inventory,
    agents: inventory.agents.map((agent) => {
      if (!(HOME_HARNESSES as readonly string[]).includes(agent.kind)) return agent
      // The Podium home holds no login (managed installs §4.3): credentials
      // are passed in there, so it has no entry.
      const own = homes
        .filter((home) => home.harness === agent.kind && !isPodiumHome(home))
        .sort((a, b) => a.homeId.localeCompare(b.homeId))
      return {
        ...agent,
        logins: [
          loginEntry(DEFAULT_HOME_ID, agent.login),
          ...own.map((home) => loginEntry(home.homeId, readHomeLogin(home, account))),
        ],
      }
    }),
  }
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
