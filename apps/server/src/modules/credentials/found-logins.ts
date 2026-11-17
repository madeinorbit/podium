/**
 * LOGINS FOUND ON A MACHINE (credential management §4 "A login found on a
 * machine is also a credential", §6 way 3; epic plan Task 9).
 *
 * A login a person made in a harness's own directory appears as a credential
 * by itself: the first time a machine reports it with an identity, one row is
 * created for that identity, owned by the person who holds custody of the
 * machine. The same identity on a second machine is the same row; which
 * machines hold it is read from their inventories, never copied into it.
 * Nothing is placed on the machine and nothing there is touched: the login is
 * the person's, not Podium's (§8). A harness that reports no identity, or a
 * machine nobody holds custody of, creates nothing.
 *
 * The same report also covers a home Podium made whose sign-in finished while
 * no attempt waited for it (the server restarted mid sign-in): its login is
 * bound like a finished sign-in, for the machine's custodian.
 */

import { harnessAccepts } from '@podium/harness/metadata'
import { createLogger } from '@podium/logger'
import {
  asCredentialId,
  type CredentialId,
  type CredentialTypeId,
  type Inventory,
  isCredentialTypeId,
  type MachineId,
} from '@podium/model'
import { DEFAULT_HOME_ID, HOME_HARNESSES, type HomeHarness, parseHomeId } from '@podium/protocol'
import type { SessionStore } from '../../store'
import { recordCredentialEvent } from './events'
import { bindHomeLogin, defaultLabel, type IdentitySerial, identityKey } from './sign-in'

const log = createLogger('server:credentials')

export interface FoundLoginsDeps {
  store: Pick<SessionStore, 'credentials' | 'machines' | 'settingsAudit'>
  serial: IdentitySerial
  now: () => number
  /** A sign-in waits for a login in this home: it binds it, not this. */
  isWaitingFor(homeId: string): boolean
}

/** The credential type a harness keeps in its home, if it keeps one. */
export function homeLoginType(harness: HomeHarness): CredentialTypeId | undefined {
  const line = harnessAccepts(harness).find((l) => l.deliver.kind === 'home')
  return line && isCredentialTypeId(line.type) ? line.type : undefined
}

/**
 * Create the credentials a machine's report names for the first time. Returns
 * the ids it created. Never throws: a failure is logged and the next report
 * tries again.
 */
export async function recordFoundLogins(
  deps: FoundLoginsDeps,
  machineId: MachineId,
  inventory: Inventory | undefined,
): Promise<CredentialId[]> {
  if (!inventory) return []
  try {
    const custodian = await deps.store.machines.custodian(machineId)
    if (!custodian) return []
    const created: CredentialId[] = []
    for (const agent of inventory.agents) {
      if (!(HOME_HARNESSES as readonly string[]).includes(agent.kind)) continue
      const harness = agent.kind as HomeHarness
      const type = homeLoginType(harness)
      if (!type) continue
      const own =
        agent.logins?.find((login) => login.homeId === DEFAULT_HOME_ID) ??
        ({ homeId: DEFAULT_HOME_ID, ...agent.login } as const)
      const fingerprint = own.state === 'in' ? own.identity?.fingerprint : undefined
      if (fingerprint) {
        const email = own.identity?.email
        const id = await deps.serial.run(identityKey(custodian, type, fingerprint), async () => {
          if (
            await deps.store.credentials.findByIdentity({
              ownerUserId: custodian,
              type,
              fingerprint,
            })
          ) {
            return undefined
          }
          const record = await deps.store.credentials.insert({
            ownerUserId: custodian,
            label: defaultLabel(type, email),
            type,
            identity: { fingerprint, ...(email ? { email } : {}) },
          })
          await recordCredentialEvent(deps.store, {
            kind: 'add',
            credentialId: record.id,
            actorUserId: custodian,
            machineId,
            detail: 'found on a machine',
          })
          return record.id
        })
        if (id) created.push(id)
      }
      for (const login of agent.logins ?? []) {
        if (login.homeId === DEFAULT_HOME_ID || login.state !== 'in') continue
        const homeFingerprint = login.identity?.fingerprint
        const named = parseHomeId(login.homeId)
        if (!homeFingerprint || !named || named.harness !== harness) continue
        if (deps.isWaitingFor(login.homeId)) continue
        if (await alreadyBound(deps, custodian, type, homeFingerprint, machineId, login.homeId))
          continue
        const bound = await bindHomeLogin(deps, {
          ownerUserId: custodian,
          actorUserId: custodian,
          type,
          machineId,
          login: {
            homeId: login.homeId,
            identity: {
              fingerprint: homeFingerprint,
              ...(login.identity?.email ? { email: login.identity.email } : {}),
            },
          },
          newId: asCredentialId(named.credentialId),
          existing: asCredentialId(named.credentialId),
        })
        if (bound.outcome === 'new') created.push(bound.credentialId)
      }
    }
    return created
  } catch (error) {
    log.warn('logins found on a machine were not recorded', { err: error, machineId })
    return []
  }
}

/** The home is already the placement of a credential for this identity, or of its own credential. */
async function alreadyBound(
  deps: FoundLoginsDeps,
  owner: Parameters<SessionStore['credentials']['findByIdentity']>[0]['ownerUserId'],
  type: CredentialTypeId,
  fingerprint: string,
  machineId: MachineId,
  homeId: string,
): Promise<boolean> {
  const named = parseHomeId(homeId)
  const candidates = [
    await deps.store.credentials.findByIdentity({ ownerUserId: owner, type, fingerprint }),
    named ? await deps.store.credentials.get(asCredentialId(named.credentialId)) : undefined,
  ]
  for (const credential of candidates) {
    if (!credential) continue
    // A home of a credential someone removed is not adopted back.
    if (credential.status === 'revoked') return true
    const placements = await deps.store.credentials.listPlacements(credential.id)
    if (
      placements.some(
        (p) =>
          p.kind === 'home' &&
          p.machineId === machineId &&
          p.state !== 'removed' &&
          (p.homeId ?? `${credential.id}:${parseHomeId(homeId)?.harness}`) === homeId,
      )
    ) {
      return true
    }
  }
  return false
}
