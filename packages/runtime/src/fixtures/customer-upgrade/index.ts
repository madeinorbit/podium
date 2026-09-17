import manifest from './manifest.json'
import localStorage from './local-storage.json'
import daemonBindings from './daemon-bindings.json'
import { readFileSync } from 'node:fs'

export { daemonBindings, localStorage, manifest }

export const enrollmentLedger = readFileSync(new URL('./enrollment.ledger', import.meta.url), 'utf8')
