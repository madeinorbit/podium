/**
 * ONE captured pre-upgrade customer state, sanitised, shared by the three
 * customer-upgrade drivers (server, daemon, client) and the skew lane.
 *
 * Source: ~/podium-incidents/2026-09-14-pdm52-quarantine, the deploy that
 * quarantined a fleet (ludovico dev.139 → dev.140). One deterministic identity
 * map replaced every uuid with a name; `user:sole` is kept because it is the
 * literal under test. Timestamps, event order, duplicate hostnames, the
 * exported-elsewhere binding residue and the states of every record are the
 * captured ones. Paths and payloads are test-only values.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import daemonBindings from './daemon-bindings.json'
import daemonReceipts from './daemon-receipts.json'
import localStorage from './local-storage.json'
import manifest from './manifest.json'
import serverReleaseMigrations from './server-release-migrations.json'
import serverRows from './server-rows.json'

export { daemonBindings, daemonReceipts, localStorage, manifest, serverReleaseMigrations, serverRows }

/** The ledger exactly as found on the customer's disk (sanitised), newline-terminated. */
export const enrollmentLedger = readFileSync(new URL('./enrollment.ledger', import.meta.url), 'utf8')

/** The name the daemon's binding store gives a binding file (base64url of the session id). */
export const bindingFileName = (sessionId: string): string =>
  `${Buffer.from(sessionId, 'utf8').toString('base64url')}.json`


/** Sanitised identity layouts from the dev.166 outage; credentials are test-only. */
export { default as identityShapes } from './identity-shapes.json'
export interface IdentityShape {
  name: string
  authenticatedId: string
  machineIdFile: string
  daemon: { machineId: string; token: string }
  supervisor?: { machineId: string; token: string }
  token: string
  absentIds: string[]
  historicalIds: string[]
}

/** Write legacy inputs only: first current boot must perform the import itself. */
export function writeIdentityShape(dir: string, shape: IdentityShape): void {
  writeFileSync(`${dir}/machine.id`, shape.machineIdFile)
  writeFileSync(`${dir}/daemon.json`, JSON.stringify(shape.daemon), { mode: 0o600 })
  if (shape.supervisor) writeFileSync(`${dir}/supervisor.json`, JSON.stringify(shape.supervisor), { mode: 0o600 })
}
