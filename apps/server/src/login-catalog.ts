import type { AgentInventory, HarnessAgent } from '@podium/model'
import type { MachineRecord } from './store/types'

type LoginIdentity = NonNullable<AgentInventory['login']['identity']>
export interface LoginCatalogMachine {
  machineId: string
  machineName: string
  harness: HarnessAgent
  freshness?: number
}

export interface LoginCatalogEntry {
  fingerprint: string
  email?: string
  providerAccountId?: string
  machines: LoginCatalogMachine[]
}

/** The catalog is deliberately keyed by identity fingerprint, never by machine. */
export type LoginCatalog = Readonly<Record<string, LoginCatalogEntry>>

function mergeIdentity(
  current: Pick<LoginCatalogEntry, 'email' | 'providerAccountId'>,
  identity: LoginIdentity,
): Pick<LoginCatalogEntry, 'email' | 'providerAccountId'> {
  return {
    ...(current.email ? { email: current.email } : identity.email ? { email: identity.email } : {}),
    ...(current.providerAccountId
      ? { providerAccountId: current.providerAccountId }
      : identity.providerAccountId
        ? { providerAccountId: identity.providerAccountId }
        : {}),
  }
}

/** Aggregate in-state native logins from every known machine. */
export function buildLoginCatalog(machines: readonly MachineRecord[]): LoginCatalog {
  const entries = new Map<string, LoginCatalogEntry>()
  for (const machine of machines) {
    for (const agent of machine.inventory?.agents ?? []) {
      const login = agent.login
      if (login.state !== 'in' || !login.identity?.fingerprint) continue
      const fingerprint = login.identity.fingerprint
      const existing = entries.get(fingerprint)
      const machineEntry: LoginCatalogMachine = {
        machineId: machine.id,
        machineName: machine.name,
        harness: agent.kind,
        ...(login.freshness !== undefined ? { freshness: login.freshness } : {}),
      }
      if (!existing) {
        entries.set(fingerprint, {
          fingerprint,
          ...mergeIdentity({}, login.identity),
          machines: [machineEntry],
        })
        continue
      }
      const duplicate = existing.machines.some(
        (item) => item.machineId === machine.id && item.harness === agent.kind,
      )
      if (!duplicate) existing.machines.push(machineEntry)
      Object.assign(existing, mergeIdentity(existing, login.identity))
    }
  }
  return Object.fromEntries(entries)
}

export function catalogEntriesForHarness(
  catalog: LoginCatalog,
  harness: HarnessAgent,
): LoginCatalogEntry[] {
  return Object.values(catalog)
    .filter((entry) => entry.machines.some((machine) => machine.harness === harness))
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
}
